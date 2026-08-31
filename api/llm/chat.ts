/**
 * api/llm/chat.ts
 * Vercel Serverless Function：POST /api/llm/chat → 真实 LLM（OpenAI 兼容端点）。
 *
 * 与 vite-plugin-llm-proxy.ts（本地 dev / 昇腾服务器 web 预览）共用
 * ../_llm-core 的同一份核心逻辑，保证各宿主行为一致。
 *
 * 配置（Vercel Project Settings → Environment Variables，server-side only）：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（或 ASCEND_* 等价项）
 * 绝不要加 VITE_ 前缀——那会把 key 打进浏览器包。
 *
 * 不引 @vercel/node：用最小结构类型声明，Vercel 构建时按其 Node runtime 调用。
 */
import { handleLlmChat } from '../_llm-core';

interface VercelLikeRequest {
  method?: string;
  body?: unknown;
}

interface VercelLikeResponse {
  status(code: number): VercelLikeResponse;
  json(payload: unknown): void;
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  // Vercel 会按 Content-Type 自动 parse body：对象直接用，字符串原样交给 core。
  const raw =
    typeof req.body === 'string' || req.body == null
      ? (req.body as string | null | undefined)
      : (req.body as Record<string, unknown>);
  const { status, payload } = await handleLlmChat(raw, process.env);
  res.status(status).json(payload);
}
