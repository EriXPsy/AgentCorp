/**
 * api/llm/chat.ts
 * Vercel Serverless Function：POST /api/llm/chat → 真实 LLM（OpenAI 兼容端点）。
 *
 * 与 vite-plugin-llm-proxy.ts（本地 dev / 国产算力服务器 web 预览）共用
 * ../_llm-core 的同一份核心逻辑，保证各宿主行为一致。
 *
 * 配置（Vercel Project Settings → Environment Variables，server-side only）：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（或 ASCEND_* 等价项）
 * 绝不要加 VITE_ 前缀——那会把 key 打进浏览器包。
 *
 * 不引 @vercel/node：用最小结构类型声明，Vercel 构建时按其 Node runtime 调用。
 *
 * 模块格式：Vercel 构建器从「入口文件所在目录」向上解析 tsconfig。本目录的
 * api/tsconfig.json 固定 `module: CommonJS`，避免命中根 tsconfig.json 的
 * `module: ESNext` 而产出 ESM 语法——本项目无 `"type": "module"`，Node 会按
 * ESM 语义加载并因扩展名省略的相对导入 `'../_llm-core'` 解析失败，导致函数在
 * 模块加载期崩溃（线上表现为 GET/POST 一律 500 FUNCTION_INVOCATION_FAILED）。
 * 详见 tests/unit/llm-chat-vercel-bundle.test.ts。
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
