/**
 * api/_llm-core.ts
 * /api/llm/chat 的平台无关核心逻辑：请求校验 → 调 OpenAI 兼容上游 → 统一响应。
 *
 * 被两个宿主复用，行为必须完全一致：
 * - vite-plugin-llm-proxy.ts（本地 dev / 昇腾服务器 web 预览的中间件）
 * - api/llm/chat.ts（Vercel Serverless Function）
 *
 * 安全约束：LLM_API_KEY 只在 Node 侧（process.env）读取，绝不进浏览器包。
 * 响应契约（前端 realExecutor 依赖）：200 → { content, finishReason, usage, model }；
 * 错误 → { error, detail? }。content 优先 choices[0].message.content，推理模型
 * 该字段可能为空则兜底 reasoning_content，保证「有真实产出」而非静默空成功。
 *
 * 文件名以下划线开头：Vercel 不会把 `_` 前缀文件注册为路由。
 */

export interface LlmChatCoreResult {
  status: number;
  payload: Record<string, unknown>;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: unknown;
  model?: string;
  error?: unknown;
}

type Env = Record<string, string | undefined>;

/**
 * 处理一次 chat 请求。body 可以是 JSON 字符串（vite 中间件读到的原始流）
 * 或已解析的对象（Vercel 自动 parse 后的 req.body）。
 */
export async function handleLlmChat(
  body: string | Record<string, unknown> | null | undefined,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmChatCoreResult> {
  const apiKey = env.LLM_API_KEY || env.ASCEND_API_KEY;
  const baseUrl = env.LLM_BASE_URL || env.ASCEND_BASE_URL;
  const model = env.LLM_MODEL || env.ASCEND_MODEL;
  if (!apiKey || !baseUrl || !model) {
    return {
      status: 503,
      payload: {
        error: 'llm_not_configured',
        detail: '缺少 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（或 ASCEND_* 等价项，见 .env）',
      },
    };
  }

  let parsed: {
    message?: string;
    system?: string;
    maxTokens?: number;
    messages?: Array<{ role: string; content: string }>;
  };
  try {
    parsed = (typeof body === 'string' ? (body ? JSON.parse(body) : {}) : body ?? {}) as typeof parsed;
  } catch {
    return { status: 400, payload: { error: 'invalid_json' } };
  }

  // 支持两种入参：单条 {system?, message} 或完整 {messages[]}（多 agent 协作用）。
  let messages: Array<{ role: string; content: string }>;
  if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
    messages = parsed.messages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role || 'user', content: m.content }));
    if (messages.length === 0) {
      return { status: 400, payload: { error: 'empty_message' } };
    }
  } else {
    const message = (parsed.message ?? '').trim();
    if (!message) {
      return { status: 400, payload: { error: 'empty_message' } };
    }
    messages = [];
    if (parsed.system) messages.push({ role: 'system', content: parsed.system });
    messages.push({ role: 'user', content: message });
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        // 推理模型会先消耗 tokens 思考，给足额度避免 content 为空。
        max_tokens: parsed.maxTokens ?? 2048,
        stream: false,
      }),
    });
  } catch (err) {
    return {
      status: 500,
      payload: {
        error: 'proxy_failure',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const json = (await upstream.json()) as ChatResponse;
  if (!upstream.ok) {
    return { status: 502, payload: { error: 'upstream_error', status: upstream.status, detail: json } };
  }

  const choice = json.choices?.[0]?.message;
  const content =
    (choice?.content && choice.content.trim()) ||
    (choice?.reasoning_content && choice.reasoning_content.trim()) ||
    '';
  return {
    status: 200,
    payload: {
      content,
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      usage: json.usage ?? null,
      // 模型名一并透传，供前端成本看板按模型估价。
      model: json.model ?? model,
    },
  };
}
