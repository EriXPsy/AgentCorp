/**
 * src/stores/autoWorker.ts
 * Agent Office · 自动任务 worker（S8/S9/S10，真实消费循环，非 mock）。
 *
 * 合并说明（以远程主干为主干、只叠加差异能力）：
 * 本文件不引入任何新表 / 新看板 / 新数据库。它完全构建在主干既有的
 * 任务 + execution 系统之上：
 *   - 任务读写走 useApprovalsStore（api/tasks，文件存储的 KanbanTask）。
 *   - 派活走 useGatewayStore.rpc（真实网关 RPC）+ startTaskExecution（写 canonicalExecution）。
 *   - agent 会话键取 useAgentsStore 的 AgentSummary.mainSessionKey。
 *
 * 提供三项主干原本没有的能力：
 *   S8 自动 worker：网关连上后，自动领取 status='todo' 且 workState='idle' 的任务并派活。
 *   S9 自动重试：任务 workState 变 'failed' 且未达 maxAttempts 时，自动复位为可重跑并再次派活。
 *   S10 并发度控制：同时最多执行 N 条（默认 2，可 1..8 调节），claim 时防重复领取。
 *
 * 真实约束（诚实、不假装）：
 * - 只有网关真正连上（GatewayStatus.state === 'running'）才会投递；未连上则待命。
 * - 每个任务按 assigneeId 反查该 agent 的 mainSessionKey；无 sessionKey →
 *   updateTask 置 workState='failed' 并写明原因，绝不静默成功，也不对其自动重试
 *   （结构性失败重试也会一直缺 key，避免死循环）。
 */
import { create } from 'zustand';

import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useTeamsStore } from '@/stores/teams';
import { useChatStore } from '@/stores/chat';
import { useEvaluationStore } from '@/stores/evaluation';
import { evaluateCompletedWork } from '@/services/workEvaluationLoop';
import { usePerformanceStore } from '@/stores/performance';
import { toPerformance } from '@/types/performance';
import {
  buildTeamDeliveryArtifacts,
  prepareTeamExecutionResources,
  recordTeamExecutionOutcomes,
  syncTeamDeliveryToLearningLoop,
} from '@/services/team/team-execution';
import type { KanbanTask } from '@/types/task';
import {
  routeBySquadLeader,
  type RoutingCandidate,
} from '@/engine/squad/squadRouting';
import { runRealExecution, runRealChat, runRealChatRich, isRealExecutorAvailable } from '@/engine/llm/realExecutor';
import { runSquadCollaboration } from '@/engine/squad/squadCollaboration';
import {
  runSquadOrchestration,
  type SubTaskResult,
} from '@/engine/squad/squadOrchestration';
import { createRoomTraceForwarder } from '@/stores/teamRoomBroadcast';
import { notifyTaskTerminal } from '@/lib/task-notify';
import { persistA2aTrace } from '@/lib/a2a-trace-persist';
import type { Team } from '@/types/team';
import type { A2aTraceRecord } from '@/types/evaluation';
import type { TaskExecutionEvent } from '@/types/task';

/** 领取任务的轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 3_000;
/** 网关 RPC 派活的默认超时（ms）。 */
const DISPATCH_TIMEOUT_MS = 120_000;
/** 并发度上限。 */
const MAX_CONCURRENCY = 8;
/** 默认最大尝试次数（含首次）。主干任务本身无此字段，由 worker 会话内跟踪。 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** 网关是否真正连上（真实判断）。 */
function gatewayConnected(): boolean {
  return useGatewayStore.getState().status.state === 'running';
}

/**
 * 真实执行后端是否就绪（缓存）。首次探测由 syncWithGateway/_tick 触发。
 * 就绪后即使网关未连上，worker 也可跑真实 LLM 执行。
 */
let realExecutorReady = false;
let realExecutorProbed = false;
async function probeRealExecutor(): Promise<boolean> {
  // 只缓存「可用」结论；探测失败（如 dev server 尚未注入 env、代理未就绪）
  // 不锁定，下次执行时重新探测，避免一次失败导致整个会话永远走网关兜底。
  if (realExecutorProbed && realExecutorReady) return true;
  realExecutorProbed = true;
  try {
    realExecutorReady = await isRealExecutorAvailable();
  } catch {
    realExecutorReady = false;
  }
  return realExecutorReady;
}

/** worker 是否有可用的执行通道（真实 LLM 或已连网关）。 */
function canDispatch(): boolean {
  return realExecutorReady || gatewayConnected();
}

/** 按 agentId 反查真实 mainSessionKey；查不到返回 null。 */
function sessionKeyForAgent(agentId: string | undefined): string | null {
  if (!agentId) return null;
  const agent = useAgentsStore.getState().agents.find((a) => a.id === agentId);
  return agent?.mainSessionKey || null;
}

/**
 * worker 会话内的重试计数（taskId → 已尝试次数）。用模块级 Map 跟踪，
 * 不侵入主干 KanbanTask 的 schema / 文件存储。进程重启即清零，符合
 * “自动重试是运行期行为”的预期。
 */
const attemptCount = new Map<string, number>();

interface AutoWorkerState {
  /** 用户是否开启了自动执行（开关意图）。 */
  enabled: boolean;
  /** worker 是否正在循环中（enabled 且已启动定时器）。 */
  running: boolean;
  /** 并发度：同时最多执行多少条任务。 */
  concurrency: number;
  /** 每个任务的最大尝试次数（含首次）。 */
  maxAttempts: number;
  /** 当前在执行中的任务 id 集合（并发）。 */
  activeTaskIds: string[];
  /** 累计已处理任务数（本次会话）。 */
  processed: number;
  /** 最近一次说明（供 UI 显示）。 */
  note: string;
  enable: () => void;
  disable: () => void;
  /** 设置并发度（1..8）。 */
  setConcurrency: (n: number) => void;
  /** 内部：根据网关状态启动/暂停循环。 */
  syncWithGateway: () => void;
  /** 内部：跑一次「补满并发槽位」的 tick。 */
  _tick: () => Promise<void>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
/** 当前在途执行数（模块级，避免并发 tick 之间竞态）。 */
let inFlight = 0;/** 本轮 tick 已在途 / 刚领取的任务 id，避免并发 claim 领到同一条。 */
const claimed = new Set<string>();

/**
 * 跨执行通道的互斥领取（Bug：房间派活 vs autoWorker 双跑同一任务）。
 * teamChatWorkOrder 受理会话派活前先 claimTask（占用失败即不受理），
 * 结束（含失败）后 releaseClaim；autoWorker _tick 领取前查同一集合，天然互斥。
 */
export function claimTask(taskId: string): boolean {
  if (claimed.has(taskId)) return false;
  claimed.add(taskId);
  return true;
}

/** 释放互斥占用（幂等）。 */
export function releaseClaim(taskId: string): void {
  claimed.delete(taskId);
}

/** 只读查询任务是否被任一执行通道占用。 */
export function isTaskClaimed(taskId: string): boolean {
  return claimed.has(taskId);
}

function clearTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 启动恢复：stale working 判定阈值（10 分钟无更新视为中断）。 */
const STALE_WORKING_MS = 10 * 60_000;
/** 每次会话只清扫一次（首次 fetchTasks 完成后触发）。 */
let staleSweepDone = false;

/**
 * 启动恢复清扫：页面刷新/重启后，遗留在「进行中 + working/starting」且长时间
 * 无更新的任务（执行进程已死，状态机永远卡住）复位为 failed + 写明原因，
 * 看板「失败·点我重试」可人工重排队。正在被本 worker/会话派活占用的任务不动。
 */
async function sweepStaleWorkingTasks(): Promise<void> {
  const approvals = useApprovalsStore.getState();
  const now = Date.now();
  const stale = approvals.tasks.filter((t) => {
    if (t.status !== 'in-progress') return false;
    if (t.workState !== 'working' && t.workState !== 'starting') return false;
    if (claimed.has(t.id)) return false;
    const updatedAt = new Date(t.updatedAt).getTime();
    return Number.isFinite(updatedAt) && now - updatedAt > STALE_WORKING_MS;
  });
  for (const t of stale) {
    await approvals
      .updateTask(t.id, {
        workState: 'failed',
        workError: '执行中断（页面刷新/重启），可重试',
      })
      .catch(() => { /* 单条落库失败不阻塞其余清扫 */ });
  }
}

export const useAutoWorkerStore = create<AutoWorkerState>((set, get) => ({
  enabled: false,
  running: false,
  concurrency: 2,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  activeTaskIds: [],
  processed: 0,
  note: '未开启',

  enable: () => {
    set({ enabled: true });
    get().syncWithGateway();
  },

  disable: () => {
    set({ enabled: false, running: false, note: '已关闭' });
    clearTimer();
  },

  setConcurrency: (n) => {
    const clamped = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)));
    set({ concurrency: clamped });
  },

  syncWithGateway: () => {
    const { enabled } = get();
    if (!enabled) {
      clearTimer();
      set({ running: false });
      return;
    }
    // 首次探测真实执行后端；探测完成后再次同步（异步，不阻塞）。
    if (!realExecutorProbed) {
      void probeRealExecutor().then(() => get().syncWithGateway());
    }
    if (!canDispatch()) {
      clearTimer();
      set({ running: false, note: '无可用执行通道，待命中（真实 LLM 或网关就绪后自动开始）' });
      return;
    }
    if (!timer) {
      set({
        running: true,
        note: realExecutorReady ? '运行中：真实 LLM 执行已就绪，自动领取待办任务' : '运行中：自动领取待办任务',
      });
      void get()._tick();
      timer = setInterval(() => void get()._tick(), POLL_INTERVAL_MS);
    }
  },

  _tick: async () => {
    if (ticking) return; // tick 自身不重入
    if (!get().enabled) return;
    if (!canDispatch()) {
      get().syncWithGateway(); // 执行通道全部不可用 → 暂停
      return;
    }
    ticking = true;
    try {
      const { concurrency } = get();
      const approvals = useApprovalsStore.getState();
      // 拉最新任务快照（真实读主干 /api/tasks）。
      await approvals.fetchTasks();
      // 启动恢复：首次拿到任务快照后清扫 stale working（刷新/重启遗留的卡死任务）。
      if (!staleSweepDone) {
        staleSweepDone = true;
        await sweepStaleWorkingTasks();
      }

      while (inFlight < concurrency) {
        const tasks = useApprovalsStore.getState().tasks;
        // 可领取：todo 且 idle，且未被本轮领取 / 未在途。
        const next = tasks.find(
          (t) =>
            t.status === 'todo' &&
            t.workState === 'idle' &&
            !claimed.has(t.id),
        );
        if (!next) {
          if (inFlight === 0) set({ note: '运行中：暂无待办任务，等待新任务' });
          break;
        }
        // 逻辑 claim：标记后立即占槽，避免并发 tick / 并发循环重复领取。
        claimTask(next.id);
        inFlight += 1;
        set((s) => ({
          activeTaskIds: [...s.activeTaskIds, next.id],
          note: `执行中 ${inFlight} 条（并发 ${concurrency}）`,
        }));
        void runOne(next, set, get);
      }
    } catch (e) {
      set({ note: `出错：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      ticking = false;
    }
  },
}));

/**
 * 决策对接层 · Squad Leader 路由。
 *
 * 任务先给团队 leader，leader 依据成员真实画像决定分给哪个成员或自己做。
 * 仅当任务带 teamId、能定位到团队、且团队有 leader 时才触发；否则原样返回，
 * 沿用任务既有 assigneeId（不改变主干默认行为）。
 *
 * 决策落地：把选中的 assigneeId 写回任务，并把 leader 决策理由写入 workResult，
 * 使其在看板与 execution 事件流中可见（诚实留痕，非 mock）。
 *
 * 返回决策后应使用的 assigneeId、团队 leaderId，以及是否应走多 agent A2A 协作
 * （团队任务且 leader 与被指派成员不同）。
 */
interface LeaderRouting {
  assigneeId?: string;
  leaderId?: string;
  /** 是否满足多 agent 协作条件（leader ≠ 成员，且二者均为真实 agent）。 */
  collaborate: boolean;
}

/** 把团队成员（含 leader）投影成路由所需的最简画像（真实数据，离职/淘汰标 inactive）。 */
export function projectRoutingCandidates(team: Team): RoutingCandidate[] {
  const agents = useAgentsStore.getState().agents;
  const profiles = useEvaluationStore.getState().profiles;
  // D：成员绩效快照（DyLAN 贡献度信号，arXiv:2310.02170），注入契约字段 performance
  const stats = usePerformanceStore.getState().stats;
  const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));
  return memberIds
    .map((id): RoutingCandidate | null => {
      const agent = agents.find((a) => a.id === id);
      if (!agent) return null;
      const profile = profiles[id];
      // retired（软退休/淘汰）不参与路由；缺省 lifecycleStatus 视为在职。
      const active = (agent.lifecycleStatus ?? 'active') !== 'retired';
      return {
        agentId: id,
        active,
        jobType: profile?.jobType ?? null,
        radar: profile?.radarLatest ?? null,
        userFit: profile?.userFitLatest ?? null,
        // toPerformance 对无记录新成员给 approvedRate=1（新成员不罚）
        performance: toPerformance(stats[id]),
      };
    })
    .filter((c): c is RoutingCandidate => c !== null);
}

async function resolveAssigneeViaLeader(task: KanbanTask): Promise<LeaderRouting> {
  if (!task.teamId) return { assigneeId: task.assigneeId, collaborate: false };

  const team = useTeamsStore.getState().teams.find((t) => t.id === task.teamId);
  if (!team || !team.leaderId) return { assigneeId: task.assigneeId, collaborate: false };

  const agents = useAgentsStore.getState().agents;
  const candidates = projectRoutingCandidates(team);

  const decision = routeBySquadLeader({
    taskText: [task.title, task.description].filter(Boolean).join('\n\n'),
    leaderId: team.leaderId,
    candidates,
  });

  const resolved = decision.assigneeId || task.assigneeId;
  // 只有决策结果与任务当前 assignee 不同（或原本未分配）时才回写，避免无谓写入。
  if (resolved && resolved !== task.assigneeId) {
    const assigneeAgent = agents.find((a) => a.id === resolved);
    await useApprovalsStore.getState().updateTask(task.id, {
      assigneeId: resolved,
      ...(assigneeAgent?.teamRole ? { assigneeRole: assigneeAgent.teamRole } : {}),
      workResult: `[Squad Leader 路由] ${decision.reason}`,
    });
  }
  // 多 agent 协作条件：leader 未自留（成员 ≠ leader）且成员真实存在。
  const collaborate =
    !decision.leaderKept &&
    !!resolved &&
    resolved !== team.leaderId &&
    agents.some((a) => a.id === resolved);
  return { assigneeId: resolved, leaderId: team.leaderId, collaborate };
}

/** 把一条 A2A trace 转成任务执行事件（供看板时间线渲染）。 */
function traceToEvent(t: A2aTraceRecord): TaskExecutionEvent {
  const status: TaskExecutionEvent['status'] =
    t.state === 'completed' ? 'done' : t.state === 'failed' ? 'failed' : 'working';
  return {
    type: `a2a:${t.delegator} → ${t.delegatee}`,
    createdAt: t.sent_at,
    status,
    content: `【第${t.round}轮】${t.summary}`,
    actorId: t.delegator,
  };
}

/** 执行事件写回节流间隔（ms）：编排期间每条 A2A 消息都立即 append 会引发写/渲染风暴。 */
const EVENT_FLUSH_INTERVAL_MS = 800;

/**
 * 事件写回节流器（增量版）：trace 转成事件后攒在本轮待写队列，
 * 最多每 800ms 把新增事件逐条走 appendTaskExecutionEvent 原子 append 端点落库；
 * flush() 强制落尾部（任务结束/失败时必须调用，保证时间线不丢尾事件）。
 *
 * 为何不再全量 PUT executionEvents：运行期用户在任务会话里发的对话消息
 * 同样走原子 append 端点，全量 PUT（编排开始时的快照预填）会把这些消息抹掉。
 * 增量 append 只追加本轮新增，天然不覆盖他人写入；调用方也因此无需再预填
 * 既有事件列表。导出供单测直接验证节流语义。
 */
export function createThrottledEventSink(taskId: string) {
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本轮已 push 待落库的新增事件（write 时取走并清空）。 */
  let pending: TaskExecutionEvent[] = [];
  /** 写链：所有批次串行追加，保证事件顺序且不并发交错。 */
  let writeChain: Promise<unknown> = Promise.resolve();

  const write = (): Promise<unknown> => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return writeChain;
    writeChain = writeChain.then(async () => {
      for (const event of batch) {
        await useApprovalsStore
          .getState()
          .appendTaskExecutionEvent(taskId, event)
          .catch(() => { /* 时间线写回失败不阻塞执行 */ });
      }
    });
    return writeChain;
  };

  return {
    push(t: A2aTraceRecord): void {
      pending.push(traceToEvent(t));
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void write();
        }, EVENT_FLUSH_INTERVAL_MS);
      }
    },
    async flush(): Promise<void> {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // 落尾部批次，并等写链全部完成，避免与后续终态 PUT 交错丢字段
      await write();
      await writeChain.catch(() => { });
    },
  };
}

/**
 * 网关回退路径的终态回写轮询参数（Bug：拿到 runId 直接假完成）。
 * chat.send 只返回 runId，网关侧可查询的终态通道是 chat.history RPC
 * （与 chat 面板 loadHistory 同一通道）：按 sessionKey 拉历史，
 * 取派发时刻之后最新一条带文本的 assistant 消息作为真实产出。
 */
const GATEWAY_RESULT_POLL_MS = 5_000;
const GATEWAY_RESULT_TIMEOUT_MS = 10 * 60_000;
/** 时钟偏差容忍：助手消息时间戳略早于派发时刻也接受。 */
const GATEWAY_RESULT_CLOCK_SKEW_MS = 10_000;

/** 从一条历史消息提取非工具文本（content 为字符串或 text 块数组）；无文本返回空串。 */
function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      Boolean(b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'))
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * 轮询网关会话历史，等待本次派发（sinceMs）之后的真实产出；超时返回 null。
 * 历史查询失败视为瞬态，下轮重试直至超时。
 */
async function awaitGatewayRunResult(sessionKey: string, sinceMs: number): Promise<string | null> {
  const deadline = Date.now() + GATEWAY_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const data = await useGatewayStore.getState().rpc<Record<string, unknown>>(
        'chat.history',
        { sessionKey, limit: 50 },
        15_000,
      );
      const msgs = Array.isArray(data?.messages) ? data.messages as Array<Record<string, unknown>> : [];
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i];
        if (m?.role !== 'assistant') continue;
        // 无时间戳无法确认是本轮产出，宁可跳过也不拿旧回复冒充
        const ts = typeof m.timestamp === 'number' ? m.timestamp * 1000 : 0;
        if (!ts || ts < sinceMs - GATEWAY_RESULT_CLOCK_SKEW_MS) continue;
        const text = extractAssistantText(m.content);
        if (text) return text;
      }
    } catch {
      /* 历史查询失败：下轮再试 */
    }
    await new Promise((r) => setTimeout(r, GATEWAY_RESULT_POLL_MS));
  }
  return null;
}

/**
 * 执行单条任务：（可选）leader 路由 → 反查 sessionKey → 网关真实派活 →
 * startTaskExecution 记录 → 轮询 workState 终态 → done 流转 review / failed 走 S9 自动重试。
 */
async function runOne(
  task: KanbanTask,
  set: (partial: Partial<AutoWorkerState> | ((s: AutoWorkerState) => Partial<AutoWorkerState>)) => void,
  get: () => AutoWorkerState,
): Promise<void> {
  const approvals = useApprovalsStore.getState();
  const gateway = useGatewayStore.getState();

  const release = () => {
    inFlight = Math.max(0, inFlight - 1);
    claimed.delete(task.id);
    set((s) => ({
      activeTaskIds: s.activeTaskIds.filter((id) => id !== task.id),
      processed: s.processed + 1,
    }));
  };

  try {
    // 真实执行是否就绪（复用缓存，避免重复探测）。
    const realAvailable = realExecutorReady || (await probeRealExecutor());

    // 0. 团队任务判定：真实 LLM 可用时走多成员编排（leader 拆解 → 成员并行执行 →
    //    leader 审阅/返工 → 汇总），assignee 由编排器内部 ASSIGN 决定，不再预选；
    //    否则沿用原 leader 路由预选 assignee 的逻辑。
    const team = task.teamId
      ? useTeamsStore.getState().teams.find((t) => t.id === task.teamId)
      : undefined;
    // 兜底：老任务（建会话功能上线前创建的团队任务）被领取执行时补建会话条目。
    if (task.teamId) {
      useChatStore.getState().ensureTeamTaskSession({
        id: task.id,
        title: task.title,
        teamId: task.teamId,
        teamName: task.teamName ?? team?.name,
      });
    }
    const orchestrate = Boolean(team && team.leaderId && realAvailable);
    const routing = orchestrate
      ? { assigneeId: task.assigneeId, leaderId: team!.leaderId, collaborate: false }
      : await resolveAssigneeViaLeader(task);
    const resolvedAssigneeId = orchestrate
      ? task.assigneeId || team!.leaderId
      : routing.assigneeId;

    // 1. 反查真实 sessionKey。网关模式下无 key → failed（不自动重试，避免死循环）；
    //    真实 LLM 模式不依赖网关会话，用合成 key 兜底，保证任务可执行。
    let sessionKey = task.runtimeSessionKey || sessionKeyForAgent(resolvedAssigneeId);
    if (!sessionKey) {
      if (realAvailable) {
        sessionKey = `local:${resolvedAssigneeId ?? task.id}`;
      } else {
        await approvals.updateTask(task.id, {
          workState: 'failed',
          workError: '任务未分配 agent 或该 agent 未在网关注册会话（缺 mainSessionKey），无法自动执行',
        });
        release();
        return;
      }
    }

    const attempts = (attemptCount.get(task.id) ?? 0) + 1;
    attemptCount.set(task.id, attempts);

    const prompt = [task.title, task.description].filter(Boolean).join('\n\n');
    let sessionId = task.runtimeSessionId || sessionKey;
    let runId: string | undefined;
    let realOutput: string | null = null;
    /** 网关派发时刻（ms），终态回写只认这之后的助手产出。 */
    let dispatchedAt = Date.now();
    /** 交付文件落盘目录（仅编排路径产出）。 */
    let deliverableDir: string | undefined;
    /** 编排子任务结果（仅编排路径），交付后用于绩效上报与经验复盘。 */
    let orchSubtasks: SubTaskResult[] | null = null;

    // 2. 真实执行优先：若真实 LLM 后端在线（Vite 代理已配置 key）：
    //    - 团队任务 → 多成员编排（leader 拆解 → 并行执行 → 审阅/返工 → 汇总）；
    //    - 二人协作条件 → leader↔单成员 A2A 往返；
    //    - 否则 → 单 agent 真实执行。
    //    非真实模式回退到网关 RPC。
    if (realAvailable) {
      await approvals.updateTask(task.id, { status: 'in-progress', workState: 'working' });
      try {
        if (orchestrate && team) {
          // —— 多成员编排：leader 拆解 → 成员并行执行 → leader 审阅/返工 → 汇总 ——
          // 事件节流写回（增量 append，无需预填历史事件）：看板即时可见
          const sink = createThrottledEventSink(task.id);
          // P0-3：里程碑 trace 实时广播到团队房间（仅团队任务；失败静默）
          const forwardRoom = task.teamId ? createRoomTraceForwarder(task.teamId) : null;
          const executionResources = await prepareTeamExecutionResources({
            id: team.id,
            name: team.name,
            leaderId: team.leaderId,
            memberIds: team.memberIds,
          });
          let orch: Awaited<ReturnType<typeof runSquadOrchestration>>;
          try {
            // C/F 契约字段：qualityMode（双草案高质量模式）+ experience（团队经验卡）
            orch = await runSquadOrchestration({
              taskId: task.id,
              taskTitle: task.title,
              taskDescription: task.description,
              team,
              candidates: projectRoutingCandidates(team),
              personas: executionResources.personas,
              maxRounds: 3,
              // C：高优先级任务走双草案高质量模式
              qualityMode: task.priority === 'high',
              // F：团队经验卡文本（最近 10 条，每行「- 内容」）
              ...(executionResources.experienceText
                ? { experience: executionResources.experienceText }
                : {}),
              // 注入真实 LLM 执行；persona/身份由编排器拼进 system 消息。
              // ctx 透传给用量采集（成本看板按 task/team/agent 归集）。
              // maxTokens 8192：长交付物需要足够输出额度，2048 会腰斩；
              // 编排器按环节用 hints 分档（拆解/审阅给小额度），缺省回退 8192。
              chat: (agentId, messages, hints) => runRealChat(messages, hints?.maxTokens ?? 8192, { taskId: task.id, teamId: team.id, agentId }),
              // SUMMARIZE 续写拼接依赖 finishReason 识别腰斩（见 squadOrchestration.chatRich）
              chatRich: (agentId, messages) => runRealChatRich(messages, 8192, { taskId: task.id, teamId: team.id, agentId }),
              // 每产生一条 A2A 消息，实时 append 成执行事件（节流写回），
              // 并落盘到主进程 a2a-traces（Trace 浏览面板可按 taskId 回放）。
              onTrace: (t) => { sink.push(t); forwardRoom?.(t); persistA2aTrace(t); },
            });
          } finally {
            // 成功/失败都必须把尾部事件落库，时间线不丢尾
            await sink.flush();
          }
          orchSubtasks = orch.subtasks;
          // D：编排结果按子任务归集成成员绩效上报（fire-and-forget，失败静默）
          recordTeamExecutionOutcomes(orch.subtasks);
          const delivery = await buildTeamDeliveryArtifacts({
            taskId: task.id,
            teamName: team.name,
            subtasks: orch.subtasks,
            deliverable: orch.deliverable,
          });
          realOutput = delivery.output;
          deliverableDir = delivery.deliverableDir;
        } else if (routing.collaborate && routing.leaderId && resolvedAssigneeId) {
          // —— 多 agent A2A 协作：leader 分派 → 成员执行 → leader 审阅（可返工）——
          const sink = createThrottledEventSink(task.id);
          let collab: Awaited<ReturnType<typeof runSquadCollaboration>>;
          try {
            collab = await runSquadCollaboration({
              taskId: task.id,
              taskTitle: task.title,
              taskDescription: task.description,
              leaderId: routing.leaderId,
              memberId: resolvedAssigneeId,
              maxRounds: 3,
              // 注入真实 LLM 执行；agentId 作为身份写进系统提示。
              chat: (agentId, messages) => runRealChat(messages, 8192, { taskId: task.id, teamId: task.teamId, agentId }),
              // 每产生一条 A2A 消息，实时 append 成执行事件（节流写回），并落盘留痕。
              onTrace: (t) => { sink.push(t); persistA2aTrace(t); },
            });
          } finally {
            await sink.flush();
          }
          realOutput = collab.approved
            ? `【A2A 协作完成·${collab.rounds}轮·Leader PASS】\n${collab.deliverable}`
            : `【A2A 协作未通过·已达${collab.rounds}轮】最后产出：\n${collab.deliverable}\n\nLeader 意见：${collab.verdict}`;
        } else {
          // —— 单 agent 真实执行 ——
          const system = [
            '你是 AgentCorp 中的一名专业执行 agent。',
            resolvedAssigneeId ? `你的 agentId 是 ${resolvedAssigneeId}。` : '',
            '请直接完成下面这条任务，给出可交付的真实产出（结论/代码/文案/方案），不要只复述任务。',
          ]
            .filter(Boolean)
            .join('\n');
          const result = await runRealExecution(
            { message: prompt, system, maxTokens: 8192 },
            { taskId: task.id, teamId: task.teamId, agentId: resolvedAssigneeId ?? undefined },
          );
          realOutput = result.content;
        }
      } catch (execErr) {
        // 真实执行失败 → failed，交给 S9 判断是否重试。
        await approvals.updateTask(task.id, {
          workState: 'failed',
          workError: `真实执行失败：${execErr instanceof Error ? execErr.message : String(execErr)}`,
        });
        await maybeAutoRetry(task, get, set);
        release();
        return;
      }
    } else {
      // 回退：网关真实派活（复用主干标准 RPC 通道 chat.send）。
      dispatchedAt = Date.now();
      try {
        const rpcResult = await gateway.rpc<{ runId?: string; sessionId?: string }>(
          'chat.send',
          { sessionKey, message: prompt },
          DISPATCH_TIMEOUT_MS,
        );
        runId = rpcResult?.runId;
        if (rpcResult?.sessionId) sessionId = rpcResult.sessionId;
        // 派发成功只代表网关受理，任务保持进行中，等终态回写（不再直接假完成）
        await approvals.updateTask(task.id, { status: 'in-progress', workState: 'working' });
      } catch (rpcErr) {
        await approvals.updateTask(task.id, {
          workState: 'failed',
          workError: `网关派活失败：${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}`,
        });
        await maybeAutoRetry(task, get, set);
        release();
        return;
      }
    }

    // 3. 记录 execution（写 canonicalExecution）。
    await approvals.startTaskExecution(task.id, {
      sessionId,
      sessionKey,
      ...(resolvedAssigneeId ? { agentId: resolvedAssigneeId } : {}),
      ...(runId ? { entrySessionKey: sessionKey } : {}),
    });

    // 3.5 网关回退路径：轮询会话历史拿真实产出（带超时）。拿不到绝不假装完成——
    //     诚实降级为 failed + 退回待办，由人工决定是否重试。
    if (!realOutput) {
      realOutput = await awaitGatewayRunResult(sessionKey, dispatchedAt);
      if (!realOutput) {
        await approvals.updateTask(task.id, {
          status: 'todo',
          workState: 'failed',
          workError: '网关执行结果回写超时（未能在会话历史中确认产出），已退回待办，可人工重试',
        });
        attemptCount.delete(task.id);
        release();
        return;
      }
    }

    // 4. 落终态并写入真实产出，流转 review。
    //    workResult = 真实产出（真实执行或网关会话回写，截断存储，避免过长）。
    await approvals.updateTask(task.id, {
      status: 'review',
      workState: 'done',
      ...(deliverableDir ? { deliverableDir } : {}),
      // workResult 上限 20000：完整保留汇总交付，看板/会话展示与返工上下文都依赖它。
      workResult: realOutput.slice(0, 20000),
    });
    attemptCount.delete(task.id); // 成功后清计数
    set({ note: `已完成：${task.title.slice(0, 24)}` });

    // 「用人 → 选人」回流：把这次真实干活的产出送回评估层，
    // 让上岗后的实际表现进入六维与榜单，而不是永远停留在面试那一刻的印象。
    // best-effort：评测是观察者，它自己失败不能影响已经交付的工作。
    if (resolvedAssigneeId) {
      const workerAgent = useAgentsStore
        .getState()
        .agents.find((a) => a.id === resolvedAssigneeId);
      void evaluateCompletedWork({
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        agentId: resolvedAssigneeId,
        agentName: workerAgent?.name ?? resolvedAssigneeId,
        output: realOutput,
        runId: runId ?? null,
        sessionId,
        sessionKey,
        leaderId: team?.leaderId,
      }).catch(() => { /* 回流失败静默：不影响交付 */ });
    }
    // 系统通知：真实执行跑完进评审列，提醒用户验收（点击通知直达任务详情）
    notifyTaskTerminal(task.id, 'done', task.title);
    // 团队任务的交付同步到团队房间，并触发 leader 视角经验反思（operate → learn）
    if (task.teamId) {
      await syncTeamDeliveryToLearningLoop({
        teamId: task.teamId,
        leaderId: team?.leaderId ?? null,
        taskId: task.id,
        taskTitle: task.title,
        realOutput,
        subtasks: orchSubtasks,
      });
    }
    release();
    void get()._tick(); // 立即补槽
  } catch (e) {
    // 兜底：任何异常都落 failed 并释放槽位，避免卡在 idle 反复领取。
    try {
      await approvals.updateTask(task.id, {
        workState: 'failed',
        workError: e instanceof Error ? e.message : String(e),
      });
      await maybeAutoRetry(task, get, set);
    } catch {
      /* 落库失败忽略 */
    }
    release();
  }
}

/**
 * S9 自动重试：若该任务尝试次数未达 maxAttempts，则把它复位为可重跑
 * （status='todo', workState='idle'），下一轮 tick 会再次领取；达上限则终止。
 */
async function maybeAutoRetry(
  task: KanbanTask,
  get: () => AutoWorkerState,
  set: (partial: Partial<AutoWorkerState>) => void,
): Promise<void> {
  const attempts = attemptCount.get(task.id) ?? 1;
  const max = get().maxAttempts;
  if (attempts >= max) {
    // 终态失败：status 一并复位回 todo（不再卡在 in-progress 列），
    // workState 保持 failed——autoWorker 只领 idle，不会自动死循环；
    // 看板「失败·点我重试」按钮（复位 todo+idle）是人工重试入口。
    await useApprovalsStore.getState().updateTask(task.id, { status: 'todo' }).catch(() => { /* 落库失败忽略 */ });
    set({ note: `任务失败且已达重试上限（${attempts}/${max}），终止：${task.title.slice(0, 20)}` });
    attemptCount.delete(task.id);
    // 系统通知：终态失败（不再自动重试），提醒用户处理；原因从 store 取最新
    const freshError = useApprovalsStore.getState().tasks.find((t) => t.id === task.id)?.workError;
    notifyTaskTerminal(task.id, 'failed', task.title, freshError ?? undefined);
    return;
  }
  // 复位为待办，等待下一轮自动领取重跑。计数保留（下次进入 runOne 再 +1）。
  await useApprovalsStore.getState().updateTask(task.id, {
    status: 'todo',
    workState: 'idle',
  });
  set({ note: `失败自动重试：第 ${attempts + 1}/${max} 次已重排队：${task.title.slice(0, 20)}` });
}

/**
 * 仅供单测使用：重置 worker 的模块级运行期状态（重试计数、在途槽位、claim 集合）。
 * 生产代码不应调用。
 */
export function __resetAutoWorkerForTest(): void {
  attemptCount.clear();
  claimed.clear();
  inFlight = 0;
  ticking = false;
  staleSweepDone = false;
  realExecutorReady = false;
  realExecutorProbed = false;
  clearTimer();
}
