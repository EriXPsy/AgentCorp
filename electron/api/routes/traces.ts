import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  filterA2aTracesByTask,
  appendA2aTrace,
  listA2aTraceFiles,
  readA2aTraces,
} from '../../services/evaluation/a2a-trace';
import type { A2aTraceRecord } from '../../../src/types/evaluation';

/**
 * 历史协作 trace 浏览路由（MCP 等价层 · trace.*）。
 *
 * 把已落盘的 A2A 委派 trace（~/.openclaw/a2a-traces/<rootSessionId>.jsonl）
 * 暴露给渲染层，让「可追溯」承诺在用户侧可见：
 *   GET  /api/traces?taskId=<id>     → 列出全部 trace 文件概览（按最近活动降序；
 *                                      带 taskId 时只保留含该任务记录的文件）
 *   GET  /api/traces/<rootSessionId>?taskId=<id>
 *                                    → 读单个文件的 A2aTraceRecord（带 taskId 时过滤）
 *   POST /api/traces                 → 追加落盘 { records: A2aTraceRecord[] }
 *                                     （渲染层团队任务编排的 A2A trace 经此同盘落盘，
 *                                      与主进程委派链共用一套浏览/回放口径）
 *
 * 与 evaluate/arena 路由同源鉴权（x-agentcorp-host-session），不另开权限面。
 * 读盘失败永不抛出——返回空列表/空数组，让前端如实展示「无 trace」而非崩溃。
 * 落盘同理：appendA2aTrace 内部容错，POST 只汇报实际写入条数。
 */
export async function handleTraceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  // 列表（可选 taskId 过滤：团队任务「查看协作轨迹」入口）
  if (url.pathname === '/api/traces' && req.method === 'GET') {
    const taskId = url.searchParams.get('taskId')?.trim() || undefined;
    const files = await listA2aTraceFiles(undefined, taskId);
    sendJson(res, 200, { traces: files });
    return true;
  }

  // 落盘：渲染层团队任务编排 trace 追加写入（旁路证据，部分失败不 500）
  if (url.pathname === '/api/traces' && req.method === 'POST') {
    let body: { records?: unknown };
    try {
      body = await parseJsonBody<{ records?: unknown }>(req);
    } catch {
      sendJson(res, 400, { success: false, error: 'invalid JSON body' });
      return true;
    }
    const rawRecords = Array.isArray(body.records) ? body.records : [];
    // 最低限度校验：落盘文件名取自 root_session_id，缺关键字段的记录直接丢弃
    const records = rawRecords.filter(
      (r): r is A2aTraceRecord =>
        Boolean(r) &&
        typeof r === 'object' &&
        typeof (r as A2aTraceRecord).trace_id === 'string' &&
        typeof (r as A2aTraceRecord).root_session_id === 'string' &&
        (r as A2aTraceRecord).root_session_id.length > 0,
    );
    let appended = 0;
    for (const record of records) {
      if (await appendA2aTrace(record)) appended += 1;
    }
    sendJson(res, 200, { success: true, appended });
    return true;
  }

  // 单文件详情：/api/traces/<rootSessionId>（可选 taskId 过滤 records）
  const prefix = '/api/traces/';
  if (url.pathname.startsWith(prefix) && req.method === 'GET') {
    const rawId = decodeURIComponent(url.pathname.slice(prefix.length));
    // 文件名安全化（与落盘侧 sanitizeTraceFileName 对齐，防路径穿越）
    const rootSessionId = rawId.replace(/[^A-Za-z0-9._-]/g, '_');
    if (!rootSessionId) {
      sendJson(res, 400, { success: false, error: 'rootSessionId is required' });
      return true;
    }
    const taskId = url.searchParams.get('taskId')?.trim() ?? '';
    const records = filterA2aTracesByTask(await readA2aTraces(rootSessionId), taskId);
    sendJson(res, 200, { rootSessionId, records });
    return true;
  }

  return false;
}
