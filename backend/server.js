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
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || "";
const DOUBAO_MODEL = process.env.DOUBAO_MODEL || "doubao-seed-evolving";
const DOUBAO_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";

// 旧域名（已实测 403-free、可用）
const UPSTREAM_URL =
  `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${MODEL}`;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        hasKey: !!DASHSCOPE_API_KEY,
        model: MODEL,
        upstream: UPSTREAM_URL,
        hasDoubaoKey: !!DOUBAO_API_KEY,
      })
    );
    return;
  }

  // 摘要接口：用豆包模型总结历史对话
  if (req.method === "POST" && req.url === "/api/summarize") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { text, oldSummary } = JSON.parse(body);
        if (!text && !oldSummary) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "缺少文本内容" }));
        }
        if (!DOUBAO_API_KEY) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "未配置 DOUBAO_API_KEY" }));
        }

        const systemPrompt =
          "你是「小趴」的记忆助手，负责维护关于「用户」的稳定画像。\n" +
          "\n规则：\n" +
          "1. 只记录「用户」的信息：用户的称呼/名字、明确的持久喜好/偏好、长期目标/需求、用户明确要求记住的事。\n" +
          "2. 绝对不要记录：情绪化吐槽（如“你是傻子吧”）、一次性闲聊（如“今天天气不错”）、测试/无意义话语、负面/尴尬片段。\n" +
          "3. 绝对不要记录关于「小趴」自身的定义、性格、状态。小趴的人设由系统提示词固定，不属于记忆范围。\n" +
          "4. 合并旧摘要时，剔除其中的小趴描述和无关碎片，只保留用户画像。\n" +
          "5. 如果本次对话没有任何值得长期记住的用户信息，只输出一个字符「无」。\n" +
          "6. 【最重要】直接输出结果本身，禁止输出任何思考过程、分析、步骤、编号、markdown 标记、标题、前缀说明或总结语。只输出最终的一段话。\n" +
          "\n输出：不超过500字的用户画像，简洁中文陈述。";

        let userContent = "";
        if (oldSummary) {
          userContent += `【已有的历史摘要】\n${oldSummary}\n\n`;
        }
        userContent += `【本次对话内容】\n${text}`;

        const resp = await fetch(DOUBAO_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${DOUBAO_API_KEY}`,
          },
          body: JSON.stringify({
            model: DOUBAO_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
          }),
        });

        const data = await resp.json();
        if (!resp.ok) {
          console.error("[summarize] 豆包返回错误:", data);
          res.writeHead(502, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "摘要失败", detail: data }));
        }

        const summary = data?.choices?.[0]?.message?.content || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ summary }));
      } catch (e) {
        console.error("[summarize] 异常:", e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
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
