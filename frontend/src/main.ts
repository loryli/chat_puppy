// chat_puppy 前端 —— WebSocket 实时语音（P0 完成版）
//
// 流程：
//  1. getUserMedia 拿麦克风
//  2. new WebSocket("ws://localhost:8787/ws")（后端隧道 -> 阿里云）
//  3. 收到 session.created -> 发 session.update（server_vad 模式，支持打断）
//  4. 输入端 AudioContext(16k) + AudioWorklet 采集 -> base64 -> input_audio_buffer.append
//  5. 输出端 AudioContext(24k) 播放 response.audio.delta
//  6. server_vad 事件驱动状态机 + 打断

import { Avatar } from "./avatar";
import "./style.css";
import {
  loadSummary,
  saveSummary,
  loadRecentTurns,
  saveRecentTurns,
  buildMemoryContext,
  pushTurn,
  type Turn,
} from "./memory";

const BACKEND_WS = "ws://localhost:8787/ws";

const avatar = new Avatar(document.getElementById("avatar") as HTMLCanvasElement);

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

// ---- 记忆状态 ----
let summary = ""; // 长期摘要
let recentTurns: Turn[] = []; // 最近 3 轮（持久化）
let sessionTurns: Turn[] = []; // 本次会话所有轮次（用于结算摘要）
let currentUserText = ""; // 当前轮用户说的话（含转写）
let currentAiText = ""; // 当前轮 AI 回复

// 播放队列
const playQueue: Float32Array<ArrayBuffer>[] = [];
let playing = false;
let nextPlayTime = 0;

// ---- UI 元素 ----
const bubbleEl = document.getElementById("bubble") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;

let bubbleTimer = 0;

// 显示对话气泡（AI 的回复文字）
function showBubble(text: string) {
  if (!text) return;
  bubbleEl.textContent = text;
  bubbleEl.classList.remove("hidden");
  // 一段时间后自动隐藏（避免一直遮挡角色）
  clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    bubbleEl.classList.add("hidden");
  }, 6000);
}

// 设置状态徽章
function setStatus(text: string, active = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("active", active);
}

// 切换「开始/停止」按钮的可用状态（开始=主按钮，停止=次按钮）
function setListening(on: boolean) {
  if (on) {
    startBtn.disabled = true;
    startBtn.classList.add("listening");
    stopBtn.disabled = false;
  } else {
    startBtn.disabled = false;
    startBtn.classList.remove("listening");
    stopBtn.disabled = true;
  }
}

// ---- 播放端 ----
function ensureOutputCtx() {
  if (!outputCtx) {
    outputCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
  }
  // 浏览器自动播放策略：必须在用户手势后 resume，否则静音
  if (outputCtx.state === "suspended") {
    outputCtx.resume().catch(() => {});
  }
  return outputCtx;
}

function playPcm(base64: string) {
  ensureOutputCtx();
  // 用 Uint8Array 解码 base64（可靠，避免字符串编码歧义）
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;

  // 实测：阿里云 response.audio.delta 是 16-bit 小端 PCM（虽然 session 报告 pcm24）
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const f32 = new Float32Array(i16.length);
  let sum = 0;
  for (let i = 0; i < i16.length; i++) {
    f32[i] = i16[i] / 32768;
    sum += f32[i] * f32[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, i16.length));
  avatar.feedAudioRms(rms);

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
  const baseInstructions =
    "你是一只软萌治愈系的 Q 版小宠物，名叫「小趴」。说话温柔、爱撒娇，但要认真回应用户说话的内容，不要只是敷衍地‘嗯嗯’。用简短自然的中文回应，像朋友一样陪伴用户。每次都要接住用户的话。";

  // 把历史记忆拼进 instructions
  const memoryCtx = buildMemoryContext(summary, recentTurns);
  const instructions = memoryCtx
    ? `${baseInstructions}\n\n${memoryCtx}`
    : baseInstructions;

  send({
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
      instructions,
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 1200,
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
      setStatus("连接中…");
      sendSessionUpdate();
      break;
    case "session.updated":
      setStatus("待机中", false);
      break;
    case "input_audio_buffer.speech_started":
      setStatus("聆听着…", true);
      avatar.setState("listening");
      if (aiSpeaking) {
        playQueue.length = 0;
        send({ type: "response.cancel" });
      }
      break;
    case "input_audio_buffer.speech_stopped":
      setStatus("思考中…", true);
      avatar.setState("thinking");
      break;
    case "response.audio.delta":
      aiSpeaking = true;
      setStatus("说话中…", true);
      avatar.setState("speaking");
      playPcm(obj.delta);
      break;
    case "conversation.item.input_audio_transcription.completed":
      // 用户说的话转写完成
      if (obj.transcript) currentUserText = obj.transcript;
      break;
    case "response.audio_transcript.done":
      showBubble(obj.transcript);
      currentAiText = obj.transcript || "";
      break;
    case "response.done":
      aiSpeaking = false;
      nextPlayTime = 0;
      setStatus("待机中", false);
      avatar.setState("idle");
      // 记录本轮对话（用户话 + AI 回复），维护滑动窗口
      if (currentUserText || currentAiText) {
        const turn: Turn = {
          user: currentUserText || "（语音）",
          ai: currentAiText || "（无文字）",
        };
        sessionTurns.push(turn);
        recentTurns = pushTurn(recentTurns, turn);
        saveRecentTurns(recentTurns);
        currentUserText = "";
        currentAiText = "";
      }
      break;
    case "error":
      setStatus("出错了", false);
      showBubble("小趴有点卡住了…");
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
}

// ---- 摘要结算（会话结束时调用，把本次对话并入长期摘要）----
async function finalizeSummary() {
  if (sessionTurns.length === 0) return;
  // 把本次会话所有轮次拼成文本
  const text = sessionTurns
    .map((t) => `用户：${t.user}\n小趴：${t.ai}`)
    .join("\n");

  // 暂存本次轮次，避免摘要失败丢失
  sessionTurns = [];

  try {
    const resp = await fetch("http://localhost:8787/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, oldSummary: summary }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.summary) {
        summary = data.summary;
        await saveSummary(summary);
      }
    }
  } catch (e) {
    console.error("摘要失败:", e);
  }
}

// ---- 开始/停止 ----
async function start() {
  if (starting || ws) return;
  starting = true;
  try {
    // 加载记忆（摘要 + 最近几轮）
    summary = await loadSummary();
    recentTurns = await loadRecentTurns();
    sessionTurns = [];

    ensureOutputCtx();
    if (outputCtx && outputCtx.state === "suspended") {
      await outputCtx.resume();
    }
    setStatus("连接中…", true);
    ws = new WebSocket(BACKEND_WS);
    ws.onopen = () => setStatus("待机中", false);
    ws.onmessage = (e) => {
      try { handleEvent(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => {
      setStatus("已断开", false);
      setListening(false);
    };
    ws.onerror = () => setStatus("连接出错", false);
    await setupMic();
    setListening(true);
  } finally {
    starting = false;
  }
}

function stop() {
  // 会话结束：先做摘要结算
  finalizeSummary();

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
  avatar.setState("idle");
  setStatus("待机中", false);
  setListening(false);
}

// ---- UI 绑走 ----
startBtn.onclick = () => {
  start().catch(() => {
    setStatus("启动失败", false);
    setListening(false);
  });
};

stopBtn.onclick = () => {
  stop();
};

// 页面关闭容器：尝试把未结算的对话做摘要（best-effort）
window.addEventListener("beforeunload", () => {
  if (sessionTurns.length > 0) {
    // 用 navigator.sendBeacon 或同步 fetch 尽力保持（可能来不及，但尽量）
    const text = sessionTurns
      .map((t) => `用户：${t.user}\n小趴：${t.ai}`)
      .join("\n");
    try {
      navigator.sendBeacon(
        "http://localhost:8787/api/summarize",
        new Blob([JSON.stringify({ text, oldSummary: summary })], {
          type: "application/json",
        })
      );
    } catch (e) {
      /* 忽略 */
    }
  }
});

