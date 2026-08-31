/**
 * src/engine/llm/realExecutor.ts
 * 真实 LLM 执行适配器（前端侧）。
 *
 * 前端只调同源 /api/llm/chat，承接方二选一：
 * - Web 预览 / vite dev：vite-plugin-llm-proxy（stream:false 写死，前端分段 reveal 兜底）；
 * - 打包版 Electron：electron/api/routes/llm-chat.ts（支持 SSE 真流式透传，
 *   上游可为华为昇腾 MindIE / vLLM-Ascend 等任意 OpenAI 兼容端点）。
 * API key 只在服务端读取，前端绝不接触。
 *
 * 这是「真实执行」而非 mock：把任务内容作为 prompt 交给真实模型，返回模型的
 * 真实产出；失败（未配置 / 上游报错 / 空产出）都如实抛出，交给 autoWorker 的
 * S9 重试与 failed 流转处理，绝不静默成功。
 */
import type { LlmCallContext } from '@/types/llm-usage';
import { revealText } from './streaming-reveal';

export interface RealExecutionResult {
  /** 模型真实产出文本 */
  content: string;
  finishReason: string | null;
  usage: unknown;
}

/**
 * 用量上报 sink（成本看板）。realExecutor 位于 tsconfig.node.json 工程内，
 * 不能静态引入 renderer 侧的 host-api 依赖链，故由渲染层在启动时
 * （services/llmUsage.initLlmUsageReporting）注入实现；未注入时不上报。
 */
export type LlmUsageReporter = (usage: unknown, model: string | null, ctx?: LlmCallContext) => void;

let usageReporter: LlmUsageReporter | null = null;

export function setLlmUsageReporter(reporter: LlmUsageReporter | null): void {
  usageReporter = reporter;
}

/** 用量采集：失败静默，绝不影响真实执行主流程。 */
function reportUsage(usage: unknown, model: unknown, ctx?: LlmCallContext): void {
  try {
    usageReporter?.(usage, typeof model === 'string' ? model : null, ctx);
  } catch {
    /* 采集失败静默 */
  }
}

/** 判断真实执行后端是否可用（探测代理是否配置了 key）。 */
export async function isRealExecutorAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'ping' }),
    });
    // 503 = 未配置；其余（含 200/400）都说明代理在线且已配置。
    return res.status !== 503;
  } catch {
    return false;
  }
}

/**
 * 让真实模型执行一段任务 prompt。
 * @throws Error 当未配置 / 上游失败 / 无真实产出时。
 */
export async function runRealExecution(input: {
  message: string;
  system?: string;
  maxTokens?: number;
}, ctx?: LlmCallContext): Promise<RealExecutionResult> {
  const res = await fetch('/api/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const data = (await res.json().catch(() => ({}))) as {
    content?: string;
    finishReason?: string | null;
    usage?: unknown;
    model?: string;
    error?: string;
    detail?: unknown;
  };

  if (!res.ok) {
    const detail =
      typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data.error ?? {});
    throw new Error(`真实执行失败（${res.status} ${data.error ?? ''}）：${detail}`.trim());
  }

  const content = (data.content ?? '').trim();
  if (!content) {
    throw new Error('真实执行返回空产出（模型无有效 content）');
  }

  reportUsage(data.usage ?? null, data.model ?? null, ctx);

  return {
    content,
    finishReason: data.finishReason ?? null,
    usage: data.usage ?? null,
  };
}

/** 默认单次 chat 调用超时：上游挂起时不能让用户发送态永久卡死。 */
export const REAL_CHAT_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 多轮消息版真实执行（供多 agent A2A 协作编排使用）。
 * 直接把完整 messages 交给真实模型，返回真实文本产出。
 * 带超时（默认 120s，可用 timeoutMs 覆盖）：超时抛出明确中文错误，
 * 视图的 catch 会提示用户、编排器会把对应子任务走失败改派路径。
 *
 * 调用上下文 ctx（taskId/teamId/agentId，成本看板归集用）由编排器的 chat 包装
 * 在调用处闭包注入：可放第三参（`runRealChat(msgs, 2048, { taskId, ... })`）
 * 或第四参（`runRealChat(msgs, 2048, timeoutMs, { ... })`）。
 * @throws Error 当未配置 / 上游失败 / 空产出 / 超时时。
 */
/**
 * 流式增量回调选项。请求带 stream:true：后端支持 SSE（electron host-api 路由 +
 * 昇腾 MindIE / vLLM-Ascend 等 OpenAI 兼容上游）时逐 chunk 真流式回调；
 * 不支持（如 web 预览的 vite proxy 写死 stream:false）时回退为全文分段
 * reveal（见 ./streaming-reveal）。两条路径对调用方接口一致（onDelta 收累积文本，末次即全文）。
 */
export interface RealChatStreamOptions {
  onDelta?: (accumulated: string) => void;
  /** 兜底揭示间隔（ms），默认 30。 */
  revealIntervalMs?: number;
}

export async function runRealChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens = 2048,
  timeoutOrCtx: number | LlmCallContext = REAL_CHAT_DEFAULT_TIMEOUT_MS,
  maybeCtx?: LlmCallContext,
  stream?: RealChatStreamOptions,
): Promise<string> {
  if (!stream?.onDelta) {
  // 无流式订阅：维持原非流式路径
    return (await runRealChatRich(messages, maxTokens, timeoutOrCtx, maybeCtx)).content;
  }
  return runRealChatWithDelta(messages, maxTokens, timeoutOrCtx, maybeCtx, stream);
}

interface ChatJsonPayload {
  content?: string;
  finishReason?: string | null;
  usage?: unknown;
  model?: string;
  error?: string;
  detail?: unknown;
}

/** 非流式 JSON 响应的统一解析：错误映射 + 空产出拒绝 + 用量上报。 */
async function parseChatJsonResponse(
  res: Response,
  ctx?: LlmCallContext,
): Promise<{ content: string; finishReason: string | null }> {
  const data = (await res.json().catch(() => ({}))) as ChatJsonPayload;
  if (!res.ok) {
    const detail =
      typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data.error ?? {});
    throw new Error(`真实执行失败（${res.status} ${data.error ?? ''}）：${detail}`.trim());
  }
  const content = (data.content ?? '').trim();
  if (!content) throw new Error('真实执行返回空产出（模型无有效 content）');
  reportUsage(data.usage ?? null, data.model ?? null, ctx);
  return { content, finishReason: data.finishReason ?? null };
}

/** SSE 流的增量解析：data: 行逐条 JSON，累积 delta.content 喂 onDelta。 */
async function consumeSseStream(
  res: Response,
  onDelta: (accumulated: string) => void,
  ctx?: LlmCallContext,
): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  let usage: unknown = null;
  let model: string | null = null;

  // 处理一个 SSE 事件块（可含多条 data: 行，拼接后为一个 JSON payload）
  const handleEvent = (raw: string) => {
    const dataLines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    const payload = dataLines.join('');
    if (payload === '[DONE]') return;
    // 容错：单条坏事件不中断整流
    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string | null } }>;
        usage?: unknown;
        model?: string;
      };
      const delta = json.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        acc += delta;
        onDelta(acc);
      }
      usage = json.usage ?? usage;
      model = json.model ?? model;
    } catch {
      /* 忽略坏事件 */
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    // SSE 事件以空行分隔
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleEvent(buf);

  const content = acc.trim();
  if (!content) throw new Error('真实执行返回空产出（模型无有效 content）');
  reportUsage(usage, model, ctx);
  return acc;
}

/** 带流式回调的 chat：优先真 SSE，回退全文分段 reveal。 */
async function runRealChatWithDelta(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens: number,
  timeoutOrCtx: number | LlmCallContext,
  maybeCtx: LlmCallContext | undefined,
  stream: RealChatStreamOptions,
): Promise<string> {
  const timeoutMs = typeof timeoutOrCtx === 'number' ? timeoutOrCtx : REAL_CHAT_DEFAULT_TIMEOUT_MS;
  const ctx = typeof timeoutOrCtx === 'object' ? timeoutOrCtx : maybeCtx;
  let res: Response;
  try {
    res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages, maxTokens, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`模型响应超时（${Math.round(timeoutMs / 1000)}s），请重试`, { cause: err });
    }
    throw err;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (res.ok && contentType.includes('text/event-stream') && res.body) {
    return consumeSseStream(res, stream.onDelta!, ctx);
  }
  // 回退：非流式 JSON（web 预览 proxy / 上游不支持流式），全文到手后分段揭示
  const { content } = await parseChatJsonResponse(res, ctx);
  await revealText(content, stream.onDelta!, stream.revealIntervalMs ?? 30).done;
  return content;
}

/**
 * runRealChat 的富返回版：额外带出 finishReason。
 * 编排器的 SUMMARIZE 等长产出步骤靠它识别「输出被 maxTokens 腰斩」
 * （finishReason === 'length'）并发起续写拼接，避免交付物断在半句。
 */
export async function runRealChatRich(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens = 2048,
  timeoutOrCtx: number | LlmCallContext = REAL_CHAT_DEFAULT_TIMEOUT_MS,
  maybeCtx?: LlmCallContext,
): Promise<{ content: string; finishReason: string | null }> {
  const timeoutMs = typeof timeoutOrCtx === 'number' ? timeoutOrCtx : REAL_CHAT_DEFAULT_TIMEOUT_MS;
  const ctx = typeof timeoutOrCtx === 'object' ? timeoutOrCtx : maybeCtx;
  let res: Response;
  try {
    res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout 触发时 fetch 以 TimeoutError 拒绝（旧环境可能叫 AbortError）
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`模型响应超时（${Math.round(timeoutMs / 1000)}s），请重试`, { cause: err });
    }
    throw err;
  }
  return parseChatJsonResponse(res, ctx);
}
