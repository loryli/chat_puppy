// chat_puppy 前端 —— WebSocket 实时语音（P0 完成版）
//
// 流程：
//  1. getUserMedia 拿麦克风
//  2. new WebSocket("ws://localhost:8787/ws")（后端隧道 -> 阿里云）
//  3. 收到 session.created -> 发 session.update（server_vad 模式，支持打断）
//  4. 输入端 AudioContext(16k) + AudioWorklet 采集 -> base64 -> input_audio_buffer.append
//  5. 输出端 AudioContext(24k) 播放 response.audio.delta
//  6. server_vad 事件驱动状态机 + 打断

const BACKEND_WS = "ws://localhost:8787/ws";

// 音频参数：输入 16k，输出 24k（与阿里云约定一致）
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

let ws: WebSocket | null = null;
let micStream: MediaStream | null = null;
let micWorklet: AudioWorkletNode | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let inputCtx: AudioContext | null = null; // 采集端（16k）
let outputCtx: AudioContext | null = null; // 播放端（24k）
let aiSpeaking = false;
let starting = false;

// 播放队列
const playQueue: Float32Array<ArrayBuffer>[] = [];
let playing = false;
let nextPlayTime = 0;

const log = (msg: string) => {
  const el = document.getElementById("log");
  if (!el) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

// ---- 播放端 ----
function ensureOutputCtx() {
  if (!outputCtx) outputCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
  return outputCtx;
}

function bytesToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const ab = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(ab);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return ab;
}

function playPcm(base64: string) {
  ensureOutputCtx();
  const bytes = atob(base64);
  const i16 = new Int16Array(bytes.length / 2);
  const dv = new DataView(bytesToArrayBuffer(bytes));
  for (let i = 0; i < i16.length; i++) i16[i] = dv.getInt16(i * 2, true);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < f32.length; i++) f32[i] = i16[i] / 32768;

  playQueue.push(f32 as Float32Array<ArrayBuffer>);
  if (!playing) pumpQueue();
}

function pumpQueue() {
  if (!outputCtx || playing) return;
  playing = true;
  const tick = () => {
    if (playQueue.length === 0) {
      playing = false;
      return;
    }
    const f32 = playQueue.shift()!;
    const ctx = outputCtx!;
    const buf = ctx.createBuffer(1, f32.length, OUTPUT_SAMPLE_RATE);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const dur = f32.length / OUTPUT_SAMPLE_RATE;
    src.start(Math.max(ctx.currentTime, nextPlayTime));
    nextPlayTime = Math.max(ctx.currentTime, nextPlayTime) + dur;
    src.onended = tick;
  };
  tick();
}

// ---- 发送 ----
function send(obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---- 会话配置 ----
function sendSessionUpdate() {
  send({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
      instructions:
        "你是一只软萌治愈系的 Q 版小宠物，名叫「小趴」。说话温柔、爱撒娇、带一点可爱的语气词，用简短的中文回应，像朋友一样陪伴用户。",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
      },
      audio: {
        input: {
          format: { type: "pcm", sample_rate: 16000, sample_format: "s16le", channels: 1, packing: "interleaved", channel_layout: "mono" },
        },
        output: { voice: "Tina", format: { type: "pcm", sample_rate: 24000 } },
      },
    },
  });
}

// ---- 事件处理 ----
function handleEvent(obj: any) {
  const t = obj?.type;
  switch (t) {
    case "session.created":
      log("✅ 会话已建立，配置参数...");
      sendSessionUpdate();
      break;
    case "session.updated":
      log("✅ 参数已生效，可以开始说话了！");
      break;
    case "input_audio_buffer.speech_started":
      log("🗣️ 用户开始说话");
      if (aiSpeaking) {
        playQueue.length = 0;
        log("⏹️ 打断 AI 说话");
        send({ type: "response.cancel" });
      }
      break;
    case "input_audio_buffer.speech_stopped":
      log("🤐 用户停止说话");
      break;
    case "response.audio.delta":
      aiSpeaking = true;
      playPcm(obj.delta);
      break;
    case "response.audio_transcript.done":
      log(`💬 AI: ${obj.transcript}`);
      break;
    case "response.done":
      aiSpeaking = false;
      nextPlayTime = 0;
      log("✅ 本轮完成");
      break;
    case "error":
      log(`❌ 错误: ${JSON.stringify(obj.error || obj)}`);
      break;
  }
}

// ---- 麦克风采集 ----
async function setupMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  // 采集端 AudioContext：16k，只在首次或已关闭时新建（避免工作线程重复注册）
  if (!inputCtx || inputCtx.state === "closed") {
    inputCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    await inputCtx.audioWorklet.addModule("/mic-worklet.js");
  } else if (inputCtx.state === "suspended") {
    await inputCtx.resume();
  }

  micSource = inputCtx.createMediaStreamSource(micStream);
  micWorklet = new AudioWorkletNode(inputCtx, "mic-capture");
  micSource.connect(micWorklet);

  micWorklet.port.onmessage = (e) => {
    if (e.data?.type === "pcm") {
      const i16 = e.data.i16 as Int16Array;
      let bin = "";
      const chunk = new Uint8Array(i16.buffer);
      for (let i = 0; i < chunk.length; i++) bin += String.fromCharCode(chunk[i]);
      send({ type: "input_audio_buffer.append", audio: btoa(bin) });
    }
  };
  log("🎤 麦克风就绪");
}

// ---- 开始/停止 ----
async function start() {
  if (starting || ws) return;
  starting = true;
  try {
    log("🚀 正在连接...");
    ws = new WebSocket(BACKEND_WS);
    ws.onopen = () => log("🔌 WebSocket 已连接（隧道）");
    ws.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => log("🔴 连接关闭");
    ws.onerror = () => log("❌ 连接错误");
    await setupMic();
  } finally {
    starting = false;
  }
}

function stop() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micWorklet?.disconnect();
  micWorklet = null;
  micSource?.disconnect();
  micSource = null;
  ws?.close();
  ws = null;
  playQueue.length = 0;
  playing = false;
  aiSpeaking = false;
  nextPlayTime = 0;
  // 不关闭 AudioContext，保持 worklet 已注册状态，下次 start 直接复用
  log("🛑 已停止");
}

// ---- UI ----
(document.getElementById("start") as HTMLButtonElement).onclick = () =>
  start().catch((e) => log(`❌ ${e}`));
(document.getElementById("stop") as HTMLButtonElement).onclick = stop;
