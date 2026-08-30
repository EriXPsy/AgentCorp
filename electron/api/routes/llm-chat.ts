/**
 * electron/api/routes/llm-chat.ts
 * 引擎「真实执行」LLM 聊天转发（OpenAI 兼容 /chat/completions）。
 *
 * 与 vite-plugin-llm-proxy（web 预览用）同契约，让打包版 Electron 也有承接方：
 * 前端 realExecutor 只调同源 /api/llm/chat，API key 不出主进程。
 *
 * 上游解析优先级：
 *   1. env LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 *   2. env ASCEND_BASE_URL / ASCEND_API_KEY / ASCEND_MODEL（昇腾专用快捷配置）
 *   3. provider 注册表默认账号（仅 openai-completions 协议可转发；
 *      huawei-ascend / custom / ollama 等 OpenAI 兼容端点均在此列）
 *   4. 都缺失 → 503 llm_not_configured
 *
 * body.stream === true 且上游回 SSE 时原样透传（text/event-stream），
 * 否则按非流式 JSON 契约返回 { content, finishReason, usage, model }。
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { getApiKey, getDefaultProvider, getProvider } from '../../utils/secure-storage';

interface UpstreamConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

interface ChatRequestBody {
  message?: string;
  system?: string;
  maxTokens?: number;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: unknown;
  model?: string;
  error?: unknown;
}

/** 解析上游：env 优先，其次 provider 注册表默认账号。 */
export async function resolveUpstream(): Promise<UpstreamConfig | null> {
  const envBase = process.env.LLM_BASE_URL || process.env.ASCEND_BASE_URL;
  const envKey = process.env.LLM_API_KEY || process.env.ASCEND_API_KEY;
  const envModel = process.env.LLM_MODEL || process.env.ASCEND_MODEL;
  if (envBase && envModel) {
    return { baseUrl: envBase, apiKey: envKey ?? null, model: envModel };
  }

  try {
    const defaultId = await getDefaultProvider();
    if (!defaultId) return null;
    const provider = await getProvider(defaultId);
    if (!provider?.baseUrl) return null;
    // 仅 OpenAI 兼容协议可经本路由转发；anthropic-messages 等协议走 gateway 链路。
    const protocol = provider.apiProtocol ?? 'openai-completions';
    if (protocol !== 'openai-completions') return null;
    if (!provider.model) return null;
    const apiKey = await getApiKey(defaultId);
    return { baseUrl: provider.baseUrl, apiKey, model: provider.model };
  } catch {
    return null;
  }
}

/** 与 vite-plugin-llm-proxy 一致的消息规整：{messages[]} 优先，其次 {system?, message}。 */
function normalizeMessages(
  parsed: ChatRequestBody,
): Array<{ role: string; content: string }> | null {
  if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
    const messages = parsed.messages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role || 'user', content: m.content }));
    return messages.length > 0 ? messages : null;
  }
  const message = (parsed.message ?? '').trim();
  if (!message) return null;
  const messages: Array<{ role: string; content: string }> = [];
  if (parsed.system) messages.push({ role: 'system', content: parsed.system });
  messages.push({ role: 'user', content: message });
  return messages;
}

export async function handleLlmChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/llm/chat') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  const parsed = await parseJsonBody<ChatRequestBody>(req);
  const messages = normalizeMessages(parsed ?? {});
  if (!messages) {
    sendJson(res, 400, { error: 'empty_message' });
    return true;
  }

  const upstream = await resolveUpstream();
  if (!upstream) {
    sendJson(res, 503, {
      error: 'llm_not_configured',
      detail:
        '缺少 LLM_API_KEY/LLM_BASE_URL/LLM_MODEL，且未配置默认模型提供方' +
        '（支持华为昇腾 MindIE / vLLM-Ascend 等 OpenAI 兼容端点，见 docs/ascend/deployment.md）',
    });
    return true;
  }

  const wantStream = parsed?.stream === true;
  let upstreamRes: Awaited<ReturnType<typeof fetch>>;
  try {
    upstreamRes = await fetch(`${upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: upstream.model,
        messages,
        // 推理模型会先消耗 tokens 思考，给足额度避免 content 为空。
        max_tokens: parsed.maxTokens ?? 2048,
        stream: wantStream,
      }),
    });
  } catch (err) {
    sendJson(res, 502, {
      error: 'upstream_unreachable',
      detail: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  // SSE 真流式透传（昇腾 MindIE / vLLM-Ascend 的 OpenAI 兼容端点均支持）
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  if (wantStream && upstreamRes.ok && contentType.includes('text/event-stream') && upstreamRes.body) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const reader = upstreamRes.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // 上游中断：尽力关闭，已写出的事件不受影响
    } finally {
      res.end();
    }
    return true;
  }

  const json = (await upstreamRes.json().catch(() => ({}))) as ChatResponse;
  if (!upstreamRes.ok) {
    sendJson(res, 502, { error: 'upstream_error', status: upstreamRes.status, detail: json });
    return true;
  }

  const choice = json.choices?.[0]?.message;
  const content =
    (choice?.content && choice.content.trim()) ||
    (choice?.reasoning_content && choice.reasoning_content.trim()) ||
    '';
  sendJson(res, 200, {
    content,
    finishReason: json.choices?.[0]?.finish_reason ?? null,
    usage: json.usage ?? null,
    // 模型名一并透传，供前端成本看板按模型估价。
    model: json.model ?? upstream.model,
  });
  return true;
}
