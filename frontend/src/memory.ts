// memory.ts —— 本地对话记忆（IndexedDB 持久化 + 摘要管理）
//
// 存储结构（IndexedDB 单库 "chat_puppy" / 单对象仓库 "kv"）：
//   - summary: 长期摘要（≤500字），跨会话保留
//   - recentTurns: 最近 N 轮的完整对话（用户话 + AI 回复）

const DB_NAME = "chat_puppy";
const STORE = "kv";
const RECENT_TURNS_LIMIT = 3; // 滑动窗口：保留最近 3 轮

export interface Turn {
  user: string;
  ai: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 读取摘要
export async function loadSummary(): Promise<string> {
  return (await get<string>("summary")) ?? "";
}

// 保存摘要
export async function saveSummary(summary: string): Promise<void> {
  await set("summary", summary);
}

// 读取最近几轮对话
export async function loadRecentTurns(): Promise<Turn[]> {
  return (await get<Turn[]>("recentTurns")) ?? [];
}

// 保存最近几轮对话
export async function saveRecentTurns(turns: Turn[]): Promise<void> {
  await set("recentTurns", turns);
}

// 把历史拼成一段「背景文本」，用于注入 instructions
export function buildMemoryContext(summary: string, turns: Turn[]): string {
  const parts: string[] = [];
  if (summary) {
    parts.push(`【你们之前的对话摘要】${summary}`);
  }
  if (turns.length > 0) {
    const recent = turns
      .map((t) => `用户：${t.user}\n小趴：${t.ai}`)
      .join("\n");
    parts.push(`【最近几轮的对话】\n${recent}`);
  }
  return parts.join("\n\n");
}

// 维护滑动窗口：只保留最近 N 轮
export function pushTurn(turns: Turn[], turn: Turn): Turn[] {
  const next = [...turns, turn];
  return next.slice(-RECENT_TURNS_LIMIT);
}

export { RECENT_TURNS_LIMIT };
