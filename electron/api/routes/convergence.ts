/**
 * electron/api/routes/convergence.ts
 * 收敛记录（Layer3）的 Host API 转发。
 *
 * 路由（转发至 model-service，query 原样透传）：
 *   POST /api/convergence/trace   → model-service /api/convergence/trace
 *   POST /api/convergence/score   → model-service /api/convergence/score
 *   GET  /api/convergence/anchor  → model-service /api/convergence/anchor?ownerId=...
 *   POST /api/convergence/anchor  → model-service /api/convergence/anchor
 *
 * 背景：convergenceService（渲染层）经 hostApiFetch 打 Host API（3210），
 * 但此前 Host API 未注册 /api/convergence/* 路由——桌面端所有收敛调用 404，
 * 被 convergenceStore 的 catch 兜底静默吞掉，「服务端权威对拍」名存实亡。
 * 本路由照 arena.ts 的转发模式补齐。
 *
 * 鉴权：沿用 server.ts 统一 isAuthorizedHostApiRequest（x-agentcorp-host-session）。
 * 模型服务不可达 / 非 200 时透传上游状态码。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';

async function forwardToModelService(
  ctx: HostApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathWithQuery: string,
): Promise<void> {
  const upstreamUrl = `${ctx.modelServiceUrl}${pathWithQuery}`;
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    const init: RequestInit = { method: req.method ?? 'GET' };
    if (req.method === 'POST') {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(await parseJsonBody<Record<string, unknown>>(req));
    }
    upstream = await fetch(upstreamUrl, init);
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

export async function handleConvergenceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  const { pathname } = url;
  const isAnchor = pathname === '/api/convergence/anchor';
  const isTrace = pathname === '/api/convergence/trace';
  const isScore = pathname === '/api/convergence/score';
  if (!isAnchor && !isTrace && !isScore) return false;

  if (isTrace && req.method === 'POST') {
    await forwardToModelService(ctx, req, res, pathname);
    return true;
  }
  if (isScore && req.method === 'POST') {
    await forwardToModelService(ctx, req, res, pathname);
    return true;
  }
  if (isAnchor && (req.method === 'GET' || req.method === 'POST')) {
    // GET 带 ownerId query（url.search 含前导 ?），原样透传
    await forwardToModelService(ctx, req, res, `${pathname}${url.search}`);
    return true;
  }
  sendJson(res, 405, { success: false, error: `method ${req.method} not allowed on ${pathname}` });
  return true;
}
