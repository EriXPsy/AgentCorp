/**
 * src/engine/llm/realExecutor.ts
 * 真实 LLM 执行适配器（前端侧）。
 *
 * 前端只调同源 /api/llm/chat（由 Vite dev 中间件 vite-plugin-llm-proxy 代理到
 * 真实 LLM，如火山方舟 Ark）。API key 只在服务端读取，前端绝不接触。
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
 * 流式增量回调选项。后端 /api/llm/chat 代理不支持 SSE（stream:false 写死），
 * 因此由前端兜底：拿到全文后按标点/段落切片逐段 reveal（见 ./streaming-reveal），
 * 对调用方的接口与未来真流式路径保持一致（onDelta 收到的是累积文本，末次即全文）。
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
  const { content } = await runRealChatRich(messages, maxTokens, timeoutOrCtx, maybeCtx);
  // 兜底伪流式：全文到手后分段揭示，揭示完成再返回（保证 final 落盘在 reveal 之后）。
  if (stream?.onDelta) {
    await revealText(content, stream.onDelta, stream.revealIntervalMs ?? 30).done;
  }
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
  if (!content) throw new Error('真实执行返回空产出（模型无有效 content）');
  reportUsage(data.usage ?? null, data.model ?? null, ctx);
  return { content, finishReason: data.finishReason ?? null };
}
