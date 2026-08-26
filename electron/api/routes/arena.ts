/**
 * electron/api/routes/arena.ts
 * Arena 个性化对决的 Host API 转发。
 *
 * 路由（转发至 model-service，保持 camelCase 原样透传）：
 *   POST /api/arena/compare    → model-service /api/arena/compare
 *   POST /api/arena/user-pick  → model-service /api/arena/user-pick
 *
 * 鉴权：沿用 server.ts 统一 isAuthorizedHostApiRequest（x-agentcorp-host-session）。
 * 模型服务不可达 / 非 200 时透传上游状态码（503/404/409/422/502 语义见契约 §0）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';

async function forwardToModelService(
  ctx: HostApiContext,
  res: ServerResponse,
  path: string,
  body: unknown,
): Promise<void> {
  const upstreamUrl = `${ctx.modelServiceUrl}${path}`;
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
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

export async function handleArenaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/arena/compare' && req.method === 'POST') {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    await forwardToModelService(ctx, res, '/api/arena/compare', body);
    return true;
  }
  if (url.pathname === '/api/arena/user-pick' && req.method === 'POST') {
    const body = await parseJsonBody<Record<string, unknown>>(req);
    await forwardToModelService(ctx, res, '/api/arena/user-pick', body);
    return true;
  }
  return false;
}
