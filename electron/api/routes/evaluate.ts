/**
 * electron/api/routes/evaluate.ts
 * 评估裁判 Host API 代理。
 *
 * 路由：POST /api/evaluate/run
 * 行为：读取请求体（JudgeRunInput），服务端转发至 modelServiceUrl 的
 *       /api/evaluate-run（MiniCPM-o 模型服务），将其返回的 SSE 事件流
 *       原样流式转发回 renderer。
 *
 * 鉴权：沿用 server.ts 的统一 isAuthorizedHostApiRequest（x-agentcorp-host-session）。
 * 模型服务不可达 / 非 200 时，返回 503 / 对应状态码（renderer 侧 judgeClient 会回退 Mock）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendJson } from '../route-utils';
import type { HostApiContext } from '../context';
import {
  saveProfile,
  loadProfile,
  listProfiles,
  saveRunLink,
  getRunLink,
} from '../../services/evaluation/eval-store';
import { collectRunData, listAgentSessions } from '../../services/evaluation/eval-data';
import type { EvaluationProfile, RunTaskLink } from '../../../src/types/evaluation';

interface EvaluateRunBody {
  agentId: string;
  agentName?: string;
  persona?: string;
  task?: { title?: string; description?: string; weight?: number };
  transcript?: string;
  usage?: unknown[];
  preference?: unknown;
}

/**
 * 评估数据路由（真实遥测链路）：
 * - GET  /api/eval/sessions?agentId=   列出 agent 真实会话（sessionKey + sessionId(UUID)）
 * - POST /api/eval/collect             一次返回 { events, transcript, entries }
 * - GET  /api/eval/profiles            全部评估档案
 * - PUT  /api/eval/profiles            覆盖写一份档案（body = EvaluationProfile）
 * - GET  /api/eval/profiles/:agentId   单份档案
 * - POST /api/eval/runlinks            写 runId↔task 关联（服务端填 evaluatedAt）
 * - GET  /api/eval/runlinks/:runId     读单条关联
 */
async function handleEvalDataRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === '/api/eval/sessions' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId') ?? '';
    try {
      const sessions = await listAgentSessions(agentId);
      sendJson(res, 200, { success: true, sessions });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/eval/collect' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ agentId?: string; sessionId?: string }>(req);
      if (!body.agentId?.trim() && !body.sessionId?.trim()) {
        sendJson(res, 400, { success: false, error: 'agentId 与 sessionId 至少提供一个' });
        return true;
      }
      const data = await collectRunData(
        (body.agentId ?? '').trim(),
        (body.sessionId ?? '').trim(),
      );
      sendJson(res, 200, { success: true, ...data });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/eval/profiles' && req.method === 'GET') {
    try {
      const profiles = await listProfiles();
      sendJson(res, 200, { success: true, profiles });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/eval/profiles' && req.method === 'PUT') {
    try {
      const profile = await parseJsonBody<EvaluationProfile>(req);
      if (!profile?.agentId) {
        sendJson(res, 400, { success: false, error: 'profile.agentId is required' });
        return true;
      }
      await saveProfile(profile);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const profileMatch = url.pathname.match(/^\/api\/eval\/profiles\/([^/]+)$/);
  if (profileMatch && req.method === 'GET') {
    try {
      const profile = await loadProfile(decodeURIComponent(profileMatch[1]));
      sendJson(res, 200, { success: true, profile: profile ?? null });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/eval/runlinks' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Omit<RunTaskLink, 'evaluatedAt'>>(req);
      if (!body?.runId) {
        sendJson(res, 400, { success: false, error: 'runId is required' });
        return true;
      }
      const link: RunTaskLink = {
        runId: body.runId,
        taskId: body.taskId ?? '',
        agentId: body.agentId ?? '',
        sessionKey: body.sessionKey ?? '',
        sessionId: body.sessionId ?? '',
        evaluatedAt: new Date().toISOString(),
      };
      await saveRunLink(link);
      sendJson(res, 200, { success: true, link });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const runLinkMatch = url.pathname.match(/^\/api\/eval\/runlinks\/([^/]+)$/);
  if (runLinkMatch && req.method === 'GET') {
    try {
      const link = await getRunLink(decodeURIComponent(runLinkMatch[1]));
      sendJson(res, 200, { success: true, link: link ?? null });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}

export async function handleEvaluateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname !== '/api/evaluate/run' || req.method !== 'POST') {
    return handleEvalDataRoutes(req, res, url);
  }

  const body = await parseJsonBody<EvaluateRunBody>(req);

  const upstreamUrl = `${ctx.modelServiceUrl}/api/evaluate-run`;
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
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    sendJson(res, upstream.status || 502, {
      success: false,
      error: `model-service returned ${upstream.status}`,
    });
    return true;
  }

  // 流式转发 SSE
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // 上游中断：尽力关闭，不影响已写入的事件
  } finally {
    res.end();
  }
  return true;
}
