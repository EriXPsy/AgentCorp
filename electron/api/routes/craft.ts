/**
 * electron/api/routes/craft.ts
 * HR 面试试做题（craft）的 Host API 转发。
 *
 * 路由（转发至 model-service，字段原样透传）：
 *   GET  /api/craft-tasks  → model-service /api/craft-tasks（题库，不含参考答案）
 *   POST /api/craft-judge  → model-service /api/craft-judge（单题 LLM-as-judge 评分）
 *   POST /api/chat-judge   → model-service /api/chat-judge（对话整段评分）
 *
 * 鉴权：沿用 server.ts 统一 isAuthorizedHostApiRequest（x-agentcorp-host-session）。
 * 上游状态码透传：judge 后端不可用时 model-service 返回 503，调用方据此提示而非展示伪造分数。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';

async function forwardToModelService(
  ctx: HostApiContext,
  res: ServerResponse,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<void> {
  const upstreamUrl = `${ctx.modelServiceUrl}${path}`;
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(upstreamUrl, {
      method: init.method,
      headers: init.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
    });
  } catch (err) {
    sendJson(res, 503, {
      success: false,
      error: `model-service unreachable at ${upstreamUrl}: ${String(err)}`,
    });
    return;
  }
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    payload = { success: false, error: `model-service returned non-JSON ${upstream.status}` };
  }
  sendJson(res, upstream.status, payload);
}

export async function handleCraftRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/craft-tasks' && req.method === 'GET') {
    await forwardToModelService(ctx, res, '/api/craft-tasks', { method: 'GET' });
    return true;
  }
  if (url.pathname === '/api/craft-judge' && req.method === 'POST') {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    await forwardToModelService(ctx, res, '/api/craft-judge', { method: 'POST', body });
    return true;
  }
  if (url.pathname === '/api/chat-judge' && req.method === 'POST') {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    await forwardToModelService(ctx, res, '/api/chat-judge', { method: 'POST', body });
    return true;
  }
  return false;
}
