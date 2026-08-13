/**
 * electron/services/evaluation/a2a-trace.ts
 * A2A 委派 trace 记录与读写（主进程，a2a-integration.md §3.4 / P1）。
 *
 * 无论走私有 chat.send（内部委派）还是未来的 A2A message/send（外部委派），
 * 委派事件都按统一 schema 追加落盘为 JSONL：
 *   ~/.openclaw/a2a-traces/<rootSessionId>.jsonl（每行一条 A2aTraceRecord）
 * 让评估层从「读聊天记录猜协作」升级为「读协作日志算指标」。
 *
 * 容错原则：trace 是评估证据的旁路采集，读写任一步失败都绝不抛出、
 * 绝不影响委派主流程（spawn/steer/kill）与评估采集（collectRunData）。
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getOpenClawConfigDir } from '../../utils/paths';
import type { A2aTraceRecord } from '../../../src/types/evaluation';

/**
 * ════════════ 与 src/demo/observability/traceSink.ts 字段对齐（GOAI SP-11） ════════════
 * 主进程 A2A 委派 trace 与 Demo 闭环 Run trace 共享同一套「协同执行轨迹」语义，
 * 可互为投影、统一落 OTel span：
 *
 *   A2aTraceRecord            ↔  ATRun / LoopStep (Demo traceSink)
 *   ─────────────────────────    ───────────────────────────────────────
 *   trace_id (uuid)           ↔  runId（一次 Run 一条链路，OTel trace_id）
 *   task_id                   ↔  taskId
 *   delegator (agent:leader)  ↔  step.agent（执行该步的 Agent 名）
 *   delegatee / channel       ↔  step.skill（该步调用的 Skill id）
 *   state                     ↔  step.status（ok / warn / blocked）
 *   summary                   ↔  step.summary（该步产出摘要）
 *   sent_at (ISO8601)         ↔  step.ts（毫秒时间戳）
 *   root_session_id           ↔  runId（落盘关联键 / 回放主键）
 *
 * 二者均投影为 OTel GenAI span（见 src/demo/observability/otelGenai.ts）：
 *   gen_ai.conversation.id = runId/trace_id，gen_ai.agent.name = agent/delegator，
 *   gen_ai.operation.name = phase/state。
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */

/** trace 落盘目录（~/.openclaw/a2a-traces） */
export function getA2aTracesDir(): string {
  return join(getOpenClawConfigDir(), 'a2a-traces');
}

/** 文件名安全化：rootSessionId 理论上是 UUID，仍兜底剥掉路径分隔等特殊字符 */
function sanitizeTraceFileName(rootSessionId: string): string {
  return rootSessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function traceFilePath(rootSessionId: string, dirOverride?: string): string {
  return join(dirOverride ?? getA2aTracesDir(), `${sanitizeTraceFileName(rootSessionId)}.jsonl`);
}

/**
 * 从 sessionKey 派生根会话 ID（trace 文件名 / collectRunData 关联键）。
 * sessionKey 形如 `agent:<agentId>:<sessionId>`，子代理再叠 `:subagent:<runtimeId>`；
 * 根会话 ID 即首个 `:subagent:` 之前、`agent:<agentId>:` 之后的部分。
 * 无法解析时回退整串；空串返回 ''（调用方应跳过写 trace）。
 */
export function deriveRootSessionId(sessionKey: string): string {
  const head = sessionKey.split(':subagent:')[0]?.trim() ?? '';
  if (!head) return '';
  const parts = head.split(':');
  if (parts[0] === 'agent' && parts.length >= 3) {
    return parts.slice(2).join(':');
  }
  return head;
}

/** 从 parentSessionKey 派生 delegator 引用（`agent:<leaderId>`，无法解析时 'unknown'） */
export function delegatorFromSessionKey(parentSessionKey: string): string {
  const parts = parentSessionKey.split(':');
  if (parts[0] === 'agent' && parts[1]) {
    return `agent:${parts[1]}`;
  }
  return 'unknown';
}

/** 追加一条 trace（目录自动创建）。永不抛出；成功返回 true，失败返回 false。 */
export async function appendA2aTrace(
  record: A2aTraceRecord,
  dirOverride?: string,
): Promise<boolean> {
  try {
    const dir = dirOverride ?? getA2aTracesDir();
    await mkdir(dir, { recursive: true });
    await appendFile(traceFilePath(record.root_session_id, dir), `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 宽容解析单行 JSON，坏行跳过（返回 null） */
function parseTraceLine(line: string): A2aTraceRecord | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value !== 'object' || value == null) return null;
    if (typeof value.trace_id !== 'string' || typeof value.task_id !== 'string') return null;
    return value as unknown as A2aTraceRecord;
  } catch {
    return null;
  }
}

/** 读取某根会话的全部 trace（按 sent_at 升序）。文件缺失/损坏时返回 []，永不抛出。 */
export async function readA2aTraces(
  rootSessionId: string,
  dirOverride?: string,
): Promise<A2aTraceRecord[]> {
  if (!rootSessionId) return [];
  try {
    const raw = await readFile(traceFilePath(rootSessionId, dirOverride), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseTraceLine)
      .filter((record): record is A2aTraceRecord => record != null)
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  } catch {
    return [];
  }
}

/**
 * 按 sessionId / agentId 关联 trace 记录（collectRunData 的第三数据源）。
 * 优先读 `<sessionId>.jsonl`（评估 leader 会话的常见路径）；读不到时全目录扫描，
 * 匹配 root_session_id / task_id / session_key 命中 sessionId，
 * 或 delegator / delegatee 命中 `agent:<agentId>` 的记录（评估 worker 会话的路径）。
 * 永不抛出；无关联记录返回 []（调用方保持既有兜底行为）。
 */
export async function loadA2aTracesForRun(
  agentId: string,
  sessionId: string,
  dirOverride?: string,
): Promise<A2aTraceRecord[]> {
  try {
    const direct = await readA2aTraces(sessionId, dirOverride);
    if (direct.length > 0) return direct;

    const dir = dirOverride ?? getA2aTracesDir();
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const agentRef = agentId ? `agent:${agentId}` : '';
    const matched: A2aTraceRecord[] = [];
    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue;
      const rootSessionId = fileName.slice(0, -'.jsonl'.length);
      for (const record of await readA2aTraces(rootSessionId, dirOverride)) {
        if (
          record.root_session_id === sessionId
          || record.task_id === sessionId
          || record.session_key === sessionId
          || (agentRef !== '' && (record.delegator === agentRef || record.delegatee === agentRef))
        ) {
          matched.push(record);
        }
      }
    }
    return matched.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  } catch {
    return [];
  }
}
