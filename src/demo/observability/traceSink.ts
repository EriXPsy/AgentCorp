/**
 * Trace 落盘 / 回放（GOAI SP-10 · 2.3 可观测 + 证据沉淀）
 * --------------------------------------------------------------------------
 * 把一次 AgentTeams Run（steps + evaluation + token 估算）持久化，可回放复盘。
 *
 * 双模持久化（设计决策，与 experienceStore 同源）：
 *   - 浏览器（Demo / web 预览 5174）：localStorage（key = `agentcorp:trace:<runId>`）
 *   - Node（vitest / 服务端）：写 `dist-web/traces/run-<runId>.jsonl`（dirOverride 可重定向，测试用）
 *
 * ════════════ 与 electron/services/evaluation/a2a-trace.ts 字段对齐（SP-11） ════════════
 * 两路 trace 共享同一套「协同执行轨迹」语义，可互为投影、统一落 OTel span：
 *
 *   A2aTraceRecord            ↔  ATRun / LoopStep (traceSink)
 *   ─────────────────────────    ───────────────────────────────────────
 *   trace_id (uuid)           ↔  runId（一次 Run 一条链路，OTel trace_id）
 *   task_id                   ↔  taskId
 *   delegator (agent:leader)  ↔  step.agent（执行该步的 Agent 名）
 *   delegatee / channel       ↔  step.skill（该步调用的 Skill id）
 *   state                     ↔  step.status（ok / warn / blocked）
 *   summary                   ↔  step.summary（该步产出摘要）
 *   sent_at (ISO8601)         ↔  step.ts（毫秒时间戳，回放时可归一为 ISO）
 *   root_session_id           ↔  runId（落盘关联键 / 回放主键）
 *
 * 二者均投影为 OTel GenAI span（见 otelGenai.ts）：gen_ai.conversation.id = runId/trace_id，
 * gen_ai.agent.name = agent/delegator，gen_ai.operation.name = phase/state。
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 永不抛出：落盘失败仅返回 null / 路径，不阻断主流程。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ATRun } from '../agentteams-adapter';

/** node 默认落盘目录（相对 cwd，即项目根） */
const DEFAULT_DIR = 'dist-web/traces';
const LS_PREFIX = 'agentcorp:trace:';

/** 浏览器判定：window + localStorage 都存在才算。 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { localStorage?: unknown }).localStorage !== 'undefined';
}

/* ───────────── 浏览器（localStorage） ───────────── */

function sinkRunBrowser(run: ATRun): string {
  const key = `${LS_PREFIX}${run.runId}`;
  try {
    window.localStorage.setItem(key, JSON.stringify(run));
  } catch {
    /* 静默降级 */
  }
  return key;
}

function replayRunBrowser(runId: string): ATRun | null {
  try {
    const raw = window.localStorage.getItem(`${LS_PREFIX}${runId}`);
    return raw ? (JSON.parse(raw) as ATRun) : null;
  } catch {
    return null;
  }
}

/* ───────────── Node（dist-web/traces/*.jsonl） ───────────── */

async function sinkRunNode(run: ATRun, dirOverride?: string): Promise<string> {
  const dir = dirOverride ?? DEFAULT_DIR;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `run-${run.runId}.jsonl`);
  // 单行 JSON = 合法 JSONL；含 steps + evaluation + tokenEstimate
  await writeFile(file, `${JSON.stringify(run)}\n`, 'utf8');
  return file;
}

async function replayRunNode(runId: string, dirOverride?: string): Promise<ATRun | null> {
  const dir = dirOverride ?? DEFAULT_DIR;
  try {
    const raw = await readFile(join(dir, `run-${runId}.jsonl`), 'utf8');
    const line = raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)[0];
    return line ? (JSON.parse(line) as ATRun) : null;
  } catch {
    return null;
  }
}

/* ───────────── 对外 API ───────────── */

/** 落盘一次 Run。返回落盘位置（node=文件路径 / browser=localStorage key）。 */
export async function sinkRun(run: ATRun, dirOverride?: string): Promise<string> {
  if (isBrowser()) return sinkRunBrowser(run);
  return await sinkRunNode(run, dirOverride);
}

/** 按 runId 回放一次 Run。找不到返回 null（永不抛出）。 */
export async function replayRun(runId: string, dirOverride?: string): Promise<ATRun | null> {
  if (isBrowser()) return replayRunBrowser(runId);
  return await replayRunNode(runId, dirOverride);
}
