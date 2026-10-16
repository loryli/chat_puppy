// chat_puppy 薄后端 —— WebSocket 隧道（Key 保护）
//
// 职责：
//   前端 new WebSocket("ws://localhost:8787/ws") 连到这里，
//   本服务持 DASHSCOPE_API_KEY 反向连接到阿里云 Qwen-Omni 的 WebSocket，
//   然后双向透传消息（前端 <-> 阿里云）。
//
// 为什么必须后端隧道：
//   - 浏览器原生 WebSocket API 不支持自定义 Authorization header，
//     无法直接把 Bearer Key 带给阿里云。
//   - Key 绝不能放进前端代码或 URL。
//
// 阿里云旧域名（实测可用）:
//   wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "node:fs";

// 极简 .env 加载（不额外依赖 dotenv）
try {
  const env = readFileSync(new URL("./.env", import.meta.url), "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch {}

const PORT = process.env.PORT || 8787;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
const MODEL = process.env.MODEL || "qwen3.8-omni-flash-realtime";

// 旧域名（已实测 403-free、可用）
const UPSTREAM_URL =
  `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${MODEL}`;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        hasKey: !!DASHSCOPE_API_KEY,
        model: MODEL,
        upstream: UPSTREAM_URL,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client) => {
  console.log("🟢 前端已连接");

  if (!DASHSCOPE_API_KEY) {
    client.send(
      JSON.stringify({
        type: "error",
        error: { message: "后端未配置 DASHSCOPE_API_KEY" },
      })
    );
    client.close();
    return;
  }

  let upstream;
  let closed = false;

  try {
    // Node 24 原生 WebSocket 支持自定义 headers（ws 库则用 addEventListener 方式不行，
    // 所以这里用全局 WebSocket）
    upstream = new WebSocket(UPSTREAM_URL, {
      headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}` },
    });
  } catch (e) {
    console.error("创建上游连接失败:", e);
    client.send(
      JSON.stringify({ type: "error", error: { message: String(e) } })
    );
    client.close();
    return;
  }

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { upstream.close(); } catch {}
    try { client.close(); } catch {}
  };

  upstream.onopen = () => console.log("🔵 已连上阿里云 Qwen-Omni");

  upstream.onmessage = (e) => {
    // 阿里云 -> 前端：原样透传（可能是 ArrayBuffer 或文本）
    if (client.readyState === WebSocket.OPEN) {
      client.send(e.data);
    }
  };

  upstream.onerror = (e) => {
    console.error("上游错误:", e.message || e);
    client.send(
      JSON.stringify({
        type: "error",
        error: { message: "上游连接错误: " + (e.message || "") },
      })
    );
  };

  upstream.onclose = (e) => {
    console.log("🔴 上游关闭:", e.code, e.reason);
    cleanup();
  };

  client.on("message", (data, isBinary) => {
    // 前端 -> 阿里云：原样透传
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  client.on("close", () => {
    console.log("⚫ 前端断开");
    cleanup();
  });

  client.on("error", (e) => {
    console.error("前端错误:", e);
    cleanup();
  });
});

server.listen(PORT, () => {
  if (!DASHSCOPE_API_KEY) {
    console.warn("⚠️  未配置 DASHSCOPE_API_KEY（检查 backend/.env）");
  }
  console.log(`chat_puppy 后端已启动: http://localhost:${PORT}`);
  console.log(`  WS 隧道: ws://localhost:${PORT}/ws`);
  console.log(`  上游: ${UPSTREAM_URL}`);
});
