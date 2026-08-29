/**
 * src/engine/squad/squadOrchestration.ts
 * 多 Agent 员工协同编排器：一个团队（leader + N 个成员）协同完成一条任务。
 *
 * 这不是 mock：leader 与所有成员都是真实 LLM agent，消息在它们之间真实往返，
 * 每一步都产出符合项目既有 schema 的 A2aTraceRecord（见 src/types/evaluation.ts）。
 * 流程：
 *
 *   1. DECOMPOSE（leader）：把任务拆成若干子任务，输出 JSON
 *      [{title, instruction, assigneeId?}]；解析失败兜底为单子任务（原任务）。
 *   2. ASSIGN（leader）：校验 assigneeId 是否团队成员；缺失/非法时用
 *      routeBySquadLeader 按子任务内容对成员画像打分兜底指派。
 *   2.5 KICKOFF 开工确认（P2）：成员动手前可提一个最关键的问题，
 *      问题汇总成一次 leader 批量解答，解答注入该成员 EXECUTE 的 messages。
 *   3+4. EXECUTE ∥ REVIEW（成员并行 / leader 逐个审阅）：成员按 persona +
 *      子任务指令产出真实交付物（字数天花板按工种分级，P0-1）；REWORK 回成员
 *      重做，受 maxRounds 限制；执行失败自动改派其他成员重试一次（P0-2）。
 *   4.5 CROSS_REVIEW 交叉评审（P1-1）：≥2 个子任务通过时，成员互看他人产出，
 *      需要衔接/修订则输出修订版替换原产出（一轮封顶）。
 *   4.6 REPLAN 中途重规划（P1-2）：leader 看当前产出 digest，覆盖有缺口则
 *      追加子任务（最多 3 条、只重规划 1 次），走同一套 execute+review 管线。
 *   5. SUMMARIZE（leader）：把全部子任务产出汇总成一份交付物
 *      （上限按子任务数动态化：6000 + 2000/子任务，封顶 16000 字）。
 *
 * 论文驱动的内核改造：
 *   A. 结构化验收 checklist + 独立盲审（对治 MAST arXiv:2503.13657 的 verification
 *      gap）：子任务可带 acceptance 验收标准，leader 审阅逐条 ✓/✗；leader 首次
 *      PASS 后再由「既非执行者也非 leader」的第三成员盲审一次，盲审 PASS 才算真通过。
 *   B. 结构化交付契约机检（MetaGPT ICLR2024 结构化文档思想）：子任务可带
 *      requiredSections，成员产出先做 includes 机检，缺部分直接 REWORK，
 *      不消耗 LLM 审阅。
 *   C. 高质量模式双草案 + 合成（MoA arXiv:2406.04692）：qualityMode 开启时首轮
 *      两名成员各自独立产出草案，leader 审阅两版后合成最优版（成本翻倍，默认关）。
 *   E. 调用预算护栏（对治 MAST termination failure）：callBudget 限制 LLM 调用
 *      次数（默认 80，qualityMode 默认 120）；耗尽后按序降级——先砍可选步骤
 *      （KICKOFF/CROSS_REVIEW/REPLAN/盲审），再停返工（当前产出作最终版），
 *      SUMMARIZE 永远保底并标注「预算受限，提前收敛」。
 *   D（路由侧，见 squadRouting.ts）：绩效加权路由（DyLAN arXiv:2310.02170）。
 *
 * 健壮性：每个新步骤独立 try/catch，失败降级为原行为，绝不影响主流程。
 *
 * 环境无关：通过注入 `chat(agentId, messages)` 执行函数解耦运行环境
 * （浏览器走 /api/llm/chat 代理，Node 脚本直连真实 LLM）。注意注入实现
 * 可能忽略 agentId（如 autoWorker 中的 runRealChat 包装），因此本模块把
 * persona / 身份说明直接拼进 system 消息，不依赖 chat 内部按 agentId 区分人格。
 */
import type { A2aTraceRecord, A2aTraceState } from '../../types/evaluation';
import type { Team } from '../../types/team';
import type { ChatFn, ChatHints, ChatMessage } from './squadCollaboration';
import { checkCodeOutput } from './outputCheck';
import { routeBySquadLeader, type RoutingCandidate } from './squadRouting';

/** 实况发言事件：编排关键阶段的开始/进展/结束（UI 直播气泡用；纯内存，不落盘）。 */
export type AgentSpeakPhase =
  | 'decompose'
  | 'assign'
  | 'kickoff'
  | 'execute'
  | 'review'
  | 'cross-review'
  | 'replan'
  | 'summarize';

export interface AgentSpeakEvent {
  agentId: string;
  /** 编排器只认识 agentId；展示名由调用方（如 teamChatWorkOrder）按 agents store 解析。 */
  agentName?: string;
  phase: AgentSpeakPhase;
  kind: 'start' | 'update' | 'end';
  text: string;
}

/** leader 拆解出的一条子任务。assigneeId 可缺省（由 ASSIGN 兜底指派）。 */
export interface OrchestrationSubTask {
  title: string;
  instruction: string;
  assigneeId?: string;  /**
   * A：可勾选验收标准（2~5 条，对治 MAST verification gap）。
   * 有则 leader 审阅逐条 ✓/✗，且首次 PASS 后触发一次独立盲审；缺失则无 checklist。
   */
  acceptance?: string[];
  /** B：交付必备部分标题（MetaGPT 结构化交付契约）；有则成员产出先做机检。 */
  requiredSections?: string[];
}

export interface OrchestrationInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  /** 执行任务的团队（leaderId + memberIds 决定合法指派范围）。 */
  team: Team;
  /** 团队成员（含 leader）的路由画像投影，用于 ASSIGN 兜底打分。 */
  candidates: RoutingCandidate[];
  /** agentId → persona 文本（SOUL.md 摘要）；缺失的成员退回纯身份说明。 */
  personas?: Record<string, string | null>;
  /** 单个子任务最大返工轮数（含首轮），默认 2。 */
  maxRounds?: number;
  /** C：高质量模式（MoA 双草案 + 合成），成本翻倍，默认关。 */
  qualityMode?: boolean;
  /** 团队经验卡文本：有则拼进 DECOMPOSE system（「团队既往经验：…」），没有就不提。 */
  experience?: string;
  /** E：LLM 调用预算上限，默认 80（qualityMode 时默认 120）；SUMMARIZE 保底不受拦截。 */
  callBudget?: number;
  chat: ChatFn;
  /**
   * 可选富返回通道：带出 finishReason。提供时 SUMMARIZE 用它识别
   * 「输出被 maxTokens 腰斩」（finishReason === 'length'）并自动续写拼接，
   * 避免长交付物断在半句/半张表；未提供时退回单次 chat 调用（原行为）。
   */
  chatRich?: (agentId: string, messages: ChatMessage[]) => Promise<{ content: string; finishReason: string | null }>;
  /** 每产生一条 A2A trace 时回调（用于实时展示 / 落盘）。 */
  onTrace?: (trace: A2aTraceRecord) => void;
  /**
   * 可选实况回调：关键阶段开始/产出摘要/结束时触发（房间「直播中」气泡用）。
   * 纯通知性质，回调抛错一律吞掉，绝不影响编排主流程。
   */
  onAgentSpeak?: (ev: AgentSpeakEvent) => void;
}

export interface SubTaskResult {
  title: string;
  assigneeId: string;
  /** 指派方式：leader 拆解时指定 / 路由兜底 / 兜底自留。 */
  assignedBy: 'decompose' | 'routing' | 'fallback';
  approved: boolean;
  rounds: number;
  /** 最终产出；执行失败时为 null 且 error 有值。 */
  output: string | null;
  /** leader 最终审阅结论 */
  verdict: string;
  error?: string;
  /** A：独立盲审结果（每子任务最多 1 次；未触发/无第三成员时为 undefined）。 */
  blindReview?: { reviewer: string; approved: boolean; notes: string } | null;
  /** C：qualityMode 首轮两版草案来源记录（退回单草案时为 undefined）。 */
  drafts?: { assigneeId: string; output: string }[];
}

export interface OrchestrationResult {
  subtasks: SubTaskResult[];
  /** leader 汇总后的最终交付物 */
  deliverable: string;
  /** 完整 A2A 协议轨迹（真实往返） */
  traces: A2aTraceRecord[];
  /** E：本次编排实际 LLM 调用次数（含保底的 SUMMARIZE）。 */
  llmCalls: number;
}

/** 子任务工种分级（P0-1）：决定成员产出的字数天花板。 */
export type SubTaskKind = 'code' | 'long' | 'short';

/** 各级字数天花板：代码 4000 / 长文 2000 / 短答 800。 */
const KIND_WORD_LIMIT: Record<SubTaskKind, number> = {
  code: 4000,
  long: 2000,
  short: 800,
};

/** 各级输出 token 额度（P1-4 分档）：字数 → token 留足余量，推理模型会先烧思考额度。
 *  code 给到 8192：整页 HTML/多文件代码经常被 6000 腰斩（闭合围栏丢失导致交付不落盘）。 */
const KIND_TOKEN_BUDGET: Record<SubTaskKind, number> = {
  code: 8192,
  long: 4000,
  short: 1500,
};

/** 按子任务标题+指令关键词粗分工种：代码类优先，其次长文类，否则短答类。 */
export function classifySubTaskKind(title: string, instruction: string): SubTaskKind {
  const text = `${title}\n${instruction}`.toLowerCase();
  if (/代码|实现|开发|网站|页面|html|css|脚本|程序|接口|应用/.test(text)) return 'code';
  if (/文案|方案|报告|分析|总结|设计|调研/.test(text)) return 'long';
  return 'short';
}

// ── P0-2：拆解覆盖机检（Chain-of-Verification 思想，arXiv:2309.11495）——
// 从原任务提取关键实体词，核对拆解后的子任务集是否真的覆盖了它们；
// 覆盖率过低时把缺口回喂 leader 修订一次，跑题在拆解层就被拦下。

/** 需求文本里的虚词/套话，不作为关键实体。 */
const KEY_TERM_STOPWORDS = new Set([
  '帮我', '一下', '需要', '进行', '一个', '以及', '并且', '有关', '相关', '方面',
  '内容', '要求', '希望', '可以', '不要', '完成', '输出', '包括', '包含', '整理',
]);

/** 子句开头的套话前缀（提取时剥掉，只留实质内容）。 */
const CLAUSE_STRIP_PREFIX = /^(帮我|麻烦|请|我想|我要|我需要|我们需要|给我|帮忙|希望)+/;

/**
 * 提取需求文本的关键子句：拉丁词（≥3 字符）整词；CJK 按标点/空白切成子句、
 * 剥套话前缀。子句保留完整语义单元（「皮肤病」会被包含在「调研中国皮肤病…」
 * 子句里），不做暴力 n-gram 展开——碎片词元几乎必然漏报，会把机检变成噪音。
 */
export function extractKeyTerms(text: string): string[] {
  const terms: string[] = [];
  for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9-]{2,}/g)) {
    terms.push(m[0].toLowerCase());
  }
  for (const m of text.matchAll(/[一-鿿]{2,}/g)) {
    const seg = m[0].replace(CLAUSE_STRIP_PREFIX, '');
    if (seg.length >= 2 && !KEY_TERM_STOPWORDS.has(seg)) terms.push(seg);
  }
  return terms.slice(0, 12);
}

/** 子句覆盖判定：≤3 字须整体出现；长子句任意 3 字滑窗命中即视为覆盖（措辞可变、意图须在）。 */
function clauseCovered(clause: string, haystack: string): boolean {
  if (clause.length <= 3) return haystack.includes(clause);
  for (let i = 0; i + 3 <= clause.length; i += 1) {
    if (haystack.includes(clause.slice(i, i + 3))) return true;
  }
  return false;
}

/** 拆解覆盖率：子任务标题+指令里命中的关键子句占比（无子句时视为全覆盖）。 */
export function decompositionCoverage(
  subtasks: Pick<OrchestrationSubTask, 'title' | 'instruction'>[],
  terms: string[],
): { covered: number; total: number; missing: string[] } {
  if (terms.length === 0) return { covered: 0, total: 0, missing: [] };
  const haystack = subtasks.map((s) => `${s.title}\n${s.instruction}`.toLowerCase()).join('\n');
  const missing = terms.filter((t) => !clauseCovered(t, haystack));
  return { covered: terms.length - missing.length, total: terms.length, missing };
}

// ── P0-5：leader 自留比例机检 ——
// leader 拆解时把过多子任务派给自己（assigneeId === leaderId），成员的动态选择
// （filterCandidatesForKind / 路由）形同虚设。占比超过一半即视为分工不合格，
// 与覆盖机检同路径回喂 leader 修订一次；修订后仍超比例不再强求（留 trace 说明）。

/** 拆解结果中 leader 自留的子任务数与总数（assigneeId 缺失不计入自留）。 */
export function leaderSelfAssignStats(
  subtasks: Pick<OrchestrationSubTask, 'assigneeId'>[],
  leaderId: string,
): { self: number; total: number } {
  return {
    self: subtasks.filter((s) => s.assigneeId === leaderId).length,
    total: subtasks.length,
  };
}

// ── P0-3：举证审阅（G-Eval 思想，arXiv:2303.16634）——
// 有验收标准时要求 leader 输出结构化 verdict：逐条 ✓/✗ + 产出原文引用作证据，
// 返工意见因此具体可执行（不再「感觉不对」整体打回）。

export interface StructuredReview {
  approved: boolean;
  /** 逐条核对结果（缺失表示模型未按格式输出，调用方回退首行契约） */
  checks: { criterion: string; pass: boolean; evidence: string }[];
  feedback: string;
}

/** 容错解析结构化审阅 verdict：提取首个 JSON 对象；字段非法一律 null。 */
export function parseStructuredReview(raw: string): StructuredReview | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toUpperCase() : '';
    if (verdict !== 'PASS' && verdict !== 'REWORK') return null;
    const checks = Array.isArray(parsed.checks)
      ? (parsed.checks as Record<string, unknown>[])
          .filter((c) => c && typeof c.criterion === 'string')
          .slice(0, 5)
          .map((c) => ({
            criterion: String(c.criterion).trim(),
            pass: c.pass === true,
            evidence: typeof c.evidence === 'string' ? c.evidence.trim().slice(0, 120) : '',
          }))
      : [];
    return {
      approved: verdict === 'PASS',
      checks,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim().slice(0, 400) : '',
    };
  } catch {
    return null;
  }
}

/** 结构化审阅 → 人类可读 verdict 文本（写事件流/给成员返工用，保持 UI 兼容）。 */
export function formatStructuredReview(review: StructuredReview): string {
  const lines = [review.approved ? 'PASS' : 'REWORK'];
  if (review.checks.length > 0) {
    lines.push(
      ...review.checks.map((c) => `${c.pass ? '✓' : '✗'} ${c.criterion}${c.evidence ? `（证据：${c.evidence}）` : ''}`),
    );
  }
  if (review.feedback) lines.push(review.feedback);
  return lines.join('\n');
}

/**
 * P1-2 动态圈选（DyLAN 思想）：按子任务工种预筛路由候选——
 * 已知工种且不匹配的成员退出候选；筛完为空则返回原列表（宁可用错人也不无人可用）。
 * code → 只留 jobType 'code' 或未知；long → 只留 'text' 或未知；short 不筛。
 */
export function filterCandidatesForKind(
  candidates: RoutingCandidate[],
  kind: SubTaskKind,
): RoutingCandidate[] {
  const want = kind === 'code' ? 'code' : kind === 'long' ? 'text' : null;
  if (!want) return candidates;
  const filtered = candidates.filter((c) => !c.jobType || c.jobType === want);
  return filtered.length > 0 ? filtered : candidates;
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** 与 squadCollaboration.makeTrace 同构（它未导出，这里复制一份避免改动旧文件）。 */
function makeTrace(p: {
  taskId: string;
  rootId: string;
  delegator: string;
  delegatee: string;
  round: number;
  state: A2aTraceState;
  summary: string;
  reworkOf?: string | null;
}): A2aTraceRecord {
  const now = new Date().toISOString();
  return {
    trace_id: id('trace'),
    task_id: p.taskId,
    parent_task_id: p.rootId,
    delegator: p.delegator,
    delegatee: p.delegatee,
    round: p.round,
    kind: 'message',
    state: p.state,
    rework_of: p.reworkOf ?? null,
    channel: 'internal-rpc',
    sent_at: now,
    completed_at: p.state === 'completed' || p.state === 'failed' ? now : null,
    summary: p.summary,
    session_key: `local:${p.delegatee}`,
    root_session_id: p.rootId,
    trigger: p.round === 1 ? 'spawn' : 'steer',
  };
}

/** 拼 system 消息：persona（如有）+ 身份说明。 */
function personaSystem(personas: Record<string, string | null> | undefined, agentId: string, roleLine: string): string {
  const persona = personas?.[agentId]?.trim();
  const parts = [roleLine];
  if (persona) parts.push(`你的工作风格与人格设定：\n${persona}`);
  parts.push(`（你的 agentId 是 ${agentId}）`);
  return parts.join('\n\n');
}

/**
 * 审阅结论首行判定：精确匹配行首 PASS / REWORK（词边界），先判 REWORK 再判 PASS。
 * 修复 `includes('PASS')` 把「REWORK：尚未 PASS」误判通过的问题；
 * 两者都不命中时保守视为未通过（不批准）。
 */
export function parseReviewVerdict(firstLine: string): 'PASS' | 'REWORK' {
  return /^\s*REWORK\b/i.test(firstLine) ? 'REWORK' : /^\s*PASS\b/i.test(firstLine) ? 'PASS' : 'REWORK';
}

/**
 * 归一化判定「OK」确认：取首行，去标点/空白/符号后大写，startsWith('OK')。
 * 容忍「OK，无需调整。」「ok.」等变体，避免把确认误判为修订版正文。
 */
export function firstLineIsOk(reply: string): boolean {
  const firstLine = reply.trim().split(/\r?\n/)[0] ?? '';
  const normalized = firstLine.replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase();
  return normalized.startsWith('OK');
}

/**
 * 容错解析字符串数组字段（acceptance / requiredSections）：
 * 过滤非字符串与空串、截断到 max 条；不足 min 条或不是数组视为非法，
 * 返回 undefined（该子任务无此字段），不导致整体解析失败。
 */
function parseStringList(value: unknown, min: number, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
  return list.length >= min ? list : undefined;
}

/** 容错解析 leader 拆解输出：提取 ```json 块或首个 JSON 数组。 */
export function parseSubTasks(raw: string): OrchestrationSubTask[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
  if (!candidate || !candidate.trim().startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const subtasks: OrchestrationSubTask[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return null;
      const o = item as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const instruction = typeof o.instruction === 'string' ? o.instruction.trim() : '';
      if (!title || !instruction) return null;
      // A：acceptance 验收标准 2~5 条；B：requiredSections 必备部分 1~8 条。
      // 缺失/非法仅丢弃该字段，子任务本身仍有效。
      const acceptance = parseStringList(o.acceptance, 2, 5);
      const requiredSections = parseStringList(o.requiredSections, 1, 8);
      subtasks.push({
        title,
        instruction,
        ...(typeof o.assigneeId === 'string' && o.assigneeId.trim()
          ? { assigneeId: o.assigneeId.trim() }
          : {}),
        ...(acceptance ? { acceptance } : {}),
        ...(requiredSections ? { requiredSections } : {}),
      });
    }
    return subtasks;
  } catch {
    return null;
  }
}

/**
 * 多 Agent 协同编排主入口。返回各子任务结果 + leader 汇总交付物 + 完整 trace。
 */
export async function runSquadOrchestration(
  input: OrchestrationInput,
): Promise<OrchestrationResult> {
  const { taskId, taskTitle, taskDescription, team, candidates, personas, chat } = input;
  const maxRounds = Math.max(1, input.maxRounds ?? 3);
  const qualityMode = input.qualityMode === true;
  const rootId = id('root');
  const traces: A2aTraceRecord[] = [];
  const emit = (t: A2aTraceRecord) => {
    traces.push(t);
    input.onTrace?.(t);
  };
  // 实况发言：UI 直播气泡的数据源（内存态）。回调异常吞掉，绝不阻塞编排。
  const speak = (agentId: string, phase: AgentSpeakPhase, kind: AgentSpeakEvent['kind'], text: string) => {
    try {
      input.onAgentSpeak?.({ agentId, phase, kind, text });
    } catch {
      /* 实况回调不阻塞编排 */
    }
  };

  // —— E：调用预算护栏（对治 MAST arXiv:2503.13657 termination failure）——
  // 引擎内部包一层计数 chat，每调一次 +1；预算耗尽后按序降级：
  // ① 跳过可选步骤（KICKOFF 提问 / CROSS_REVIEW / REPLAN / 盲审）；
  // ② EXECUTE∥REVIEW 循环中耗尽 → 当前产出作为最终版，停止返工
  //   （剩余未启动子任务仍执行首轮但不返工）；
  // ③ SUMMARIZE 永远保底执行（不受预算拦截），交付标注「预算受限，提前收敛」。
  const budget = Math.max(1, input.callBudget ?? (qualityMode ? 120 : 80));
  let llmCalls = 0;
  let budgetLimited = false;
  let budgetGuardTraced = false;
  const hasBudget = () => llmCalls < budget;
  const call = (agentId: string, messages: ChatMessage[], hints?: ChatHints): Promise<string> => {
    llmCalls += 1;
    return chat(agentId, messages, hints);
  };
  /** 预算护栏触发：置降级标记，trace 只落一条。 */
  const noteBudgetGuard = (detail: string) => {
    budgetLimited = true;
    if (budgetGuardTraced) return;
    budgetGuardTraced = true;
    emit(
      makeTrace({
        taskId,
        rootId,
        delegator: `agent:${team.leaderId}`,
        delegatee: `team:${team.id}`,
        round: 1,
        state: 'working',
        summary: `预算护栏触发：LLM 调用达预算上限 ${budget}，${detail}`,
      }),
    );
  };

  const taskText = [taskTitle, taskDescription].filter(Boolean).join('\n');
  // 合法指派范围：团队成员 ∪ leader（去重）。
  const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));

  // —— 步骤 1：DECOMPOSE（leader 拆任务）——
  const roster = candidates
    .map((c) => `- ${c.agentId}${c.jobType ? `（擅长工种：${c.jobType}）` : ''}${c.agentId === team.leaderId ? '（leader）' : ''}`)
    .join('\n');
  const experienceText = input.experience?.trim();
  speak(team.leaderId, 'decompose', 'start', '正在拆解任务…');
  const decomposeRaw = await call(team.leaderId, [
    {
      role: 'system',
      content: personaSystem(
        personas,
        team.leaderId,
        '你是团队 leader，负责把任务拆解为可并行执行的子任务并指派给团队成员。' +
          '只输出一个 JSON 数组，不要输出任何其它文字：[{"title":"子任务标题","instruction":"给成员的具体指令","assigneeId":"成员agentId（可选）","acceptance":["可勾选验收标准1","验收标准2"],"requiredSections":["交付必备部分标题"]}]。' +
          `团队成员如下：\n${roster}\n` +
          '拆解为 1~5 条；每条 instruction 控制在 120 字内，写清要做什么；' +
          '分工要求：执行类子任务应主要指派给成员（assigneeId 填成员 agentId），leader 只自留协调/终审类子任务，不要把大部分活留给自己；' +
          '每条子任务必须给出 acceptance：2~5 条可逐一勾选核对的验收标准（审阅与独立盲审逐条核对用）；' +
          'requiredSections 可选：交付物必须包含的部分标题（将由程序机检核对，不写则跳过机检）；' +
          '不要在 instruction 里限制成员的产出字数（长度由系统按工种自动控制，人为压短会导致交付残缺）。' +
          (experienceText ? `\n\n团队既往经验：\n${experienceText}` : ''),
      ),
    },
    { role: 'user', content: `任务：\n${taskText}` },
  ], { maxTokens: 2500 });

  // 解析失败 / 空数组 → 兜底为单子任务（原任务），诚实继续而非假装拆解成功。
  let subtasks: OrchestrationSubTask[] = parseSubTasks(decomposeRaw) ?? [
    { title: taskTitle, instruction: taskDescription || taskTitle },
  ];

  // P0-2 拆解覆盖机检（Chain-of-Verification）：需求里的关键实体在子任务集中
  // 覆盖率不足一半时，把缺口回喂 leader 修订一次——跑题在拆解层拦下，
  // 而不是等到交付才发现（真实事故：「皮肤病调研」被拆成工地巡检任务）。
  const keyTerms = extractKeyTerms(taskText);
  const coverage = decompositionCoverage(subtasks, keyTerms);
  if (coverage.total >= 2 && coverage.covered / coverage.total < 0.5 && hasBudget()) {
    try {
      const revisedRaw = await call(team.leaderId, [
        {
          role: 'system',
          content: personaSystem(
            personas,
            team.leaderId,
            '你是团队 leader。你之前的任务拆解遗漏了需求要点，请修订：' +
              '输出修订后的完整 JSON 数组（格式与之前相同，1~5 条），确保每个遗漏要点都有对应子任务覆盖。' +
              '只输出 JSON 数组，不要输出任何其它文字。',
          ),
        },
        {
          role: 'user',
          content:
            `任务：\n${taskText}\n\n你之前的拆解：\n${JSON.stringify(subtasks.map((s) => ({ title: s.title, instruction: s.instruction })))}\n\n` +
            `遗漏的需求要点：${coverage.missing.join('、')}`,
        },
      ], { maxTokens: 2500 });
      const revised = parseSubTasks(revisedRaw);
      if (revised) {
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `team:${team.id}`,
            round: 1,
            state: 'working',
            summary: `拆解覆盖机检未过（遗漏：${coverage.missing.join('、').slice(0, 40)}），leader 已修订拆解`,
          }),
        );
        subtasks = revised;
      }
    } catch {
      /* 修订失败降级：沿用首次拆解 */
    }
  }

  // P0-5 自留比例机检：leader 把超过一半的子任务派给自己（≥2 条且有其他在职
  // 成员可派）时视为分工不合格，与覆盖机检同路径回喂修订一次，明确要求把活
  // 分给成员；修订后仍超比例不再强求（留 trace 说明）。单成员团队不触发。
  // （真实事故：「皮肤病调研」全部子任务 psychologist → psychologist 自留。）
  const delegableMembers = (team.memberIds ?? []).filter(
    (mid) => mid !== team.leaderId && candidates.some((c) => c.agentId === mid && c.active !== false),
  );
  const selfStats = leaderSelfAssignStats(subtasks, team.leaderId);
  if (subtasks.length >= 2 && delegableMembers.length > 0 && selfStats.self / selfStats.total > 0.5 && hasBudget()) {
    try {
      const revisedRaw = await call(team.leaderId, [
        {
          role: 'system',
          content: personaSystem(
            personas,
            team.leaderId,
            '你是团队 leader。你之前的任务拆解把过多子任务留给了自己，请修订分工：' +
              '把执行类子任务指派给团队成员（assigneeId 填成员 agentId），leader 只自留协调/终审类子任务。' +
              '输出修订后的完整 JSON 数组（格式与之前相同，1~5 条），子任务内容本身可保持不变。' +
              '只输出 JSON 数组，不要输出任何其它文字。',
          ),
        },
        {
          role: 'user',
          content:
            `任务：\n${taskText}\n\n你之前的拆解：\n${JSON.stringify(subtasks)}\n\n` +
            `可指派的成员：\n${delegableMembers.join('、')}\n\n` +
            `你自留了 ${selfStats.self}/${selfStats.total} 条子任务，请把主要执行工作分给成员。`,
        },
      ], { maxTokens: 2500 });
      const revised = parseSubTasks(revisedRaw);
      if (revised) {
        const revisedStats = leaderSelfAssignStats(revised, team.leaderId);
        const stillOver =
          revised.length >= 2 && revisedStats.self / revisedStats.total > 0.5;
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `team:${team.id}`,
            round: 1,
            state: 'working',
            summary: stillOver
              ? `自留比例机检未过（leader 自留 ${selfStats.self}/${selfStats.total}），修订后仍自留 ${revisedStats.self}/${revisedStats.total}，不再强求，按当前拆解继续`
              : `自留比例机检未过（leader 自留 ${selfStats.self}/${selfStats.total}），leader 已修订分工`,
          }),
        );
        subtasks = revised;
      }
    } catch {
      /* 修订失败降级：沿用首次拆解 */
    }
  }
  emit(
    makeTrace({
      taskId,
      rootId,
      delegator: `agent:${team.leaderId}`,
      delegatee: `team:${team.id}`,
      round: 1,
      state: 'working',
      summary: `Leader 拆解任务为 ${subtasks.length} 个子任务：${subtasks.map((s) => s.title).join('；').slice(0, 60)}`,
    }),
  );
  speak(team.leaderId, 'decompose', 'end', `拆解为 ${subtasks.length} 个子任务，开始分派`);

  // —— 步骤 2：ASSIGN（校验 / 兜底指派）——
  /** 单条子任务指派：leader 指定合法则用，否则路由兜底。 */
  const assignOne = (st: OrchestrationSubTask): SubTaskResult => {    const legal = st.assigneeId && memberIds.includes(st.assigneeId);
    if (legal) {
      return {
        title: st.title,
        assigneeId: st.assigneeId!,
        assignedBy: 'decompose',
        approved: false,
        rounds: 0,
        output: null,
        verdict: '',
      };
    }
    // 缺失 / 非法指派 → 按子任务内容对成员画像打分路由兜底。
    // P1-2：按子任务工种预筛候选（已知工种不匹配的成员退出，无人可用时回退全量）。
    const decision = routeBySquadLeader({
      taskText: `${st.title}\n${st.instruction}`,
      leaderId: team.leaderId,
      candidates: filterCandidatesForKind(candidates, classifySubTaskKind(st.title, st.instruction)),
    });
    return {
      title: st.title,
      assigneeId: decision.assigneeId || team.leaderId,
      assignedBy: decision.assigneeId ? 'routing' : 'fallback',
      approved: false,
      rounds: 0,
      output: null,
      verdict: decision.reason,
    };
  };
  const emitAssignTrace = (st: SubTaskResult) =>
    emit(
      makeTrace({
        taskId,
        rootId,
        delegator: `agent:${team.leaderId}`,
        delegatee: `agent:${st.assigneeId}`,
        round: 1,
        state: 'submitted',
        summary: `子任务「${st.title.slice(0, 30)}」指派给 ${st.assigneeId}（${st.assignedBy === 'decompose' ? 'leader 指定' : '路由兜底'}）`,
      }),
    );

  const assigned = subtasks.map(assignOne);
  for (const st of assigned) {
    emitAssignTrace(st);
    speak(team.leaderId, 'assign', 'update', `「${st.title.slice(0, 24)}」交给 ${st.assigneeId}`);
  }

  // —— C：qualityMode 第二草案成员挑选（排除主 assignee 与 leader，无人可选退回单草案）——
  const pickSecondDraftee = (excludeId: string, title: string, instruction: string): string | null => {
    // P1-2：同样按工种预筛，第二草案成员也得是这块料
    const pool = filterCandidatesForKind(
      candidates.filter(
        (c) => c.agentId !== excludeId && c.agentId !== team.leaderId && c.active !== false,
      ),
      classifySubTaskKind(title, instruction),
    );
    if (pool.length === 0) return null;
    const decision = routeBySquadLeader({
      taskText: `${title}\n${instruction}`,
      leaderId: team.leaderId,
      candidates: pool,
    });
    return decision.leaderKept ? null : decision.assigneeId || null;
  };

  // —— 单个子任务的 EXECUTE ∥ REVIEW 循环（REPLAN 追加的子任务复用）——
  const executeReviewLoop = async (
    st: SubTaskResult,
    sub: OrchestrationSubTask,
    kickoffQA?: string,
  ): Promise<void> => {
    const instruction = sub.instruction;
    // P0-1：字数天花板按工种分级（code 4000 / long 2000 / short 800）。
    const kind = classifySubTaskKind(st.title, instruction);
    const wordLimit = KIND_WORD_LIMIT[kind];
    // P1-4：输出 token 额度同样按工种分档，短输出环节不占大额度
    const tokenBudget = KIND_TOKEN_BUDGET[kind];
    let lastReworkTrace: string | null = null;
    /** 成员执行消息（主 assignee 与第二草案成员共用结构）。 */
    const buildExecuteMsgs = (agentId: string): ChatMessage[] => {
      const msgs: ChatMessage[] = [
        {
          role: 'system',
          content: personaSystem(
            personas,
            agentId,
            '你是团队中的执行成员。严格按 leader 指令产出可交付的真实成果，直接给结果，不要复述指令。' +
              `控制在 ${wordLimit} 字内。`,
          ),
        },
        {
          role: 'user',
          content: `Leader 指令：\n${instruction}\n\n原任务背景：\n${taskText}`,
        },
      ];
      // P2：开工确认的 Q&A 作为附加上下文注入首轮执行。
      if (kickoffQA && st.rounds === 1) {
        msgs.push({
          role: 'user',
          content: `【开工确认·你的提问与 leader 解答】\n${kickoffQA}`,
        });
      }
      if (st.verdict && st.rounds > 1) {
        msgs.push({
          role: 'user',
          content: `上一轮被 leader 打回，返工意见：\n${st.verdict}\n请据此修订你的产出。`,
        });
      }
      return msgs;
    };
    while (st.rounds < maxRounds) {
      // E 预算护栏②：预算已耗尽则不再启动新一轮返工；未启动子任务（rounds===0）
      // 仍执行首轮（见下），但不返工。
      if (st.rounds > 0 && !hasBudget()) {
        noteBudgetGuard(`「${st.title.slice(0, 24)}」停止返工，当前产出作为最终版`);
        break;
      }
      st.rounds += 1;
      speak(st.assigneeId, 'execute', 'start', `正在执行「${st.title.slice(0, 24)}」（第${st.rounds}轮）…`);

      // EXECUTE：成员按 persona + 指令产出交付物。
      // C（MoA arXiv:2406.04692）：qualityMode 首轮双草案并行 + leader 合成最优版；
      // 返工轮退回主 assignee 单草案修订（双草案只在首轮做，成本可控）。
      if (qualityMode && st.rounds === 1) {
        const secondId = pickSecondDraftee(st.assigneeId, st.title, instruction);
        if (secondId && hasBudget()) {
          const [draftA, draftB] = await Promise.all([
            call(st.assigneeId, buildExecuteMsgs(st.assigneeId), { maxTokens: tokenBudget }),
            call(secondId, buildExecuteMsgs(secondId), { maxTokens: tokenBudget }),
          ]);
          st.drafts = [
            { assigneeId: st.assigneeId, output: draftA },
            { assigneeId: secondId, output: draftB },
          ];
          const draftsText =
            `【草案一·${st.assigneeId}】\n${draftA}\n\n【草案二·${secondId}】\n${draftB}`;
          // leader 先分别审阅两版草案并给出合并指令；
          const draftReview = await call(team.leaderId, [
            {
              role: 'system',
              content: personaSystem(
                personas,
                team.leaderId,
                `你是团队 leader，审阅子任务「${st.title}」的两版独立草案（成员 ${st.assigneeId} 与 ${secondId} 各自产出）。` +
                  '分别点评两版的优缺点（各两三句），并给出明确的合并指令：最终版以哪版为底、补入另一版的哪些内容。',
              ),
            },
            { role: 'user', content: `子任务要求：\n${instruction}\n\n${draftsText}` },
          ], { maxTokens: 1200 });
          // 再合成最优版（MoA aggregator：输入两版产出 + 审阅意见，输出最终版）。
          st.output = await call(team.leaderId, [
            {
              role: 'system',
              content: personaSystem(
                personas,
                team.leaderId,
                `合成：你是团队 leader，负责把子任务「${st.title}」的两版草案合成为一版最优最终稿。` +
                  '依据审阅意见取长补短，直接输出最终版全文，不要复述意见。' +
                  `控制在 ${wordLimit} 字内。`,
              ),
            },
            {
              role: 'user',
              content: `子任务要求：\n${instruction}\n\n${draftsText}\n\n【审阅意见】\n${draftReview}`,
            },
          ], { maxTokens: tokenBudget });
        } else {
          // 无第二草案成员（或预算耗尽）→ 退回单草案。
          st.output = await call(st.assigneeId, buildExecuteMsgs(st.assigneeId), { maxTokens: tokenBudget });
        }
      } else {
        st.output = await call(st.assigneeId, buildExecuteMsgs(st.assigneeId), { maxTokens: tokenBudget });
      }
      emit(
        makeTrace({
          taskId,
          rootId,
          delegator: `agent:${st.assigneeId}`,
          delegatee: `agent:${team.leaderId}`,
          round: st.rounds,
          state: 'working',
          summary: `「${st.title.slice(0, 24)}」成员回交产出（第${st.rounds}轮）：${st.output.slice(0, 50)}`,
          reworkOf: lastReworkTrace,
        }),
      );
      speak(st.assigneeId, 'execute', 'update', st.output.slice(0, 120));

      // B（MetaGPT ICLR2024 结构化交付契约）：必备部分机检，缺部分不消耗 LLM 审阅，
      // 直接记 REWORK（算一轮返工）；机检全过才进 leader 审阅。
      // P1-1：代码类产出叠加真实校验（代码块存在性、HTML 标签闭合、JS 语法可编译），
      // 把「能跑」从审阅口径变成机器事实。
      const missing = (sub.requiredSections ?? []).filter((s) => !(st.output ?? '').includes(s));
      const machineIssues = [
        ...(missing.length > 0 ? [`缺少必备部分 ${missing.join('、')}`] : []),
        ...(kind === 'code' ? checkCodeOutput(st.output ?? '') : []),
      ];
      if (machineIssues.length > 0) {
        st.approved = false;
        st.verdict = `机检未过：${machineIssues.join('；')}`;
        const checkTrace = makeTrace({
          taskId,
          rootId,
          delegator: `agent:${team.leaderId}`,
          delegatee: `agent:${st.assigneeId}`,
          round: st.rounds,
          state: 'input-required',
          summary: `「${st.title.slice(0, 24)}」机检未过：${machineIssues.join('；').slice(0, 60)}`,
          reworkOf: lastReworkTrace,
        });
        emit(checkTrace);
        lastReworkTrace = checkTrace.trace_id; // 下一轮 EXECUTE 标记为对本次的返工
        continue;
      }

      // E 预算护栏②：预算耗尽后不再消耗 LLM 审阅，当前产出作为最终版。
      if (!hasBudget()) {
        noteBudgetGuard(`「${st.title.slice(0, 24)}」审阅跳过，当前产出作为最终版`);
        st.approved = false;
        st.verdict = '预算受限：未审阅，当前产出作为最终版';
        break;
      }

      // REVIEW：leader 审阅该子任务产出；第 2 轮起带上轮意见，便于核对是否已解决。
      // P0-3 举证审阅（G-Eval）：有验收标准时要求结构化输出——逐条 ✓/✗ 并引用
      // 产出原文作证据，返工意见因此具体可执行；模型未按格式输出时回退首行契约。
      speak(team.leaderId, 'review', 'start', `正在审阅「${st.title.slice(0, 24)}」…`);
      const reviewRaw = await call(team.leaderId, [
        {
          role: 'system',
          content: personaSystem(
            personas,
            team.leaderId,
            `你是团队 leader，审阅成员 ${st.assigneeId} 对子任务「${st.title}」的产出。` +
              (sub.acceptance?.length
                ? '只输出一个 JSON 对象，不要输出任何其它文字：' +
                  '{"verdict":"PASS"|"REWORK","checks":[{"criterion":"验收标准原文","pass":true|false,"evidence":"产出中的原文引用（不超过60字）"}],"feedback":"REWORK 时的具体修改意见，最多 3 条；PASS 时留空"}。' +
                  '逐条核对验收标准，evidence 必须引用产出原文，不得捏造；任何一条 pass=false 即 REWORK。'
                : '第一行只输出 PASS 或 REWORK；第二行起给出一句理由（打回则给出修改意见）。') +
              '审阅标准：内容质量达标、要求已覆盖即 PASS；若上一轮返工意见已被逐条解决，应 PASS，不要翻新账。' +
              '不要要求成员做他们做不到的外部核验（如验证链接有效性、访问付费数据库）；对来源存疑可要求标注「来源待核验」而非打回。' +
              'REWORK 意见必须具体可执行，一次最多 3 条。',
          ),
        },
        {
          role: 'user',
          content:
            `子任务要求：\n${instruction}\n\n成员产出：\n${st.output}` +
            (sub.acceptance?.length
              ? `\n\n验收标准（请逐条核对）：\n${sub.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
              : '') +
            (st.rounds > 1 && st.verdict ? `\n\n上一轮审阅意见（请核对是否已被解决）：\n${st.verdict}` : ''),
        },
      ], { maxTokens: 1200 });
      // 举证解析：structured 命中时 verdict 与 checks 联合判定（verdict 说 PASS 但
      // 有 ✗ 证据 → 以证据为准判 REWORK）；未命中回退首行 PASS/REWORK 契约。
      const structured = sub.acceptance?.length ? parseStructuredReview(reviewRaw) : null;
      if (structured) {
        st.approved = structured.approved && structured.checks.every((c) => c.pass);
        st.verdict = formatStructuredReview(structured);
      } else {
        st.approved = parseReviewVerdict(reviewRaw.trim().split('\n')[0]) === 'PASS';
        st.verdict = reviewRaw.trim();
      }

      const reviewTrace = makeTrace({
        taskId,
        rootId,
        delegator: `agent:${team.leaderId}`,
        delegatee: `agent:${st.assigneeId}`,
        round: st.rounds,
        state: st.approved ? 'completed' : 'input-required',
        summary: `「${st.title.slice(0, 24)}」Leader 审阅：${st.approved ? 'PASS' : 'REWORK'} — ${st.verdict.slice(0, 40)}`,
        reworkOf: st.approved ? null : lastReworkTrace,
      });
      emit(reviewTrace);
      speak(
        team.leaderId,
        'review',
        'end',
        `「${st.title.slice(0, 24)}」审阅${st.approved ? '通过' : '打回返工'}：${st.verdict.slice(0, 40)}`,
      );

      if (!st.approved) {
        lastReworkTrace = reviewTrace.trace_id; // 下一轮 EXECUTE 标记为对本次的返工
        continue;
      }

      // A 独立盲审（对治 MAST verification gap）：leader 首次 PASS 后，挑一名既不是
      // assignee 也不是 leader 的成员复核 checklist+产出（首行 PASS/REWORK 契约同款）。
      // 每子任务最多盲审 1 次；无第三成员、无 checklist 或预算耗尽则跳过。
      if (sub.acceptance?.length && st.blindReview === undefined && hasBudget()) {
        const reviewer = memberIds.find((mid) => mid !== team.leaderId && mid !== st.assigneeId);
        if (reviewer) {
          const blindRaw = await call(reviewer, [
            {
              role: 'system',
              content: personaSystem(
                personas,
                reviewer,
                `盲审：你是团队中的独立评审成员，与子任务「${st.title}」的执行无关（既不是执行者也不是 leader），请独立盲审其产出。` +
                  '第一行只输出 PASS 或 REWORK；第二行起对照验收标准逐条标注 ✓/✗ 并给一句总评。' +
                  '标准：验收标准全部满足才 PASS；任何一条不满足即 REWORK 并指明是哪条。',
              ),
            },
            {
              role: 'user',
              content:
                `子任务要求：\n${instruction}\n\n验收标准：\n${sub.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}` +
                `\n\n产出：\n${st.output}`,
            },
          ], { maxTokens: 1000 });
          const blindOk = parseReviewVerdict(blindRaw.trim().split('\n')[0]) === 'PASS';
          st.blindReview = { reviewer, approved: blindOk, notes: blindRaw.trim() };
          const blindTrace = makeTrace({
            taskId,
            rootId,
            delegator: `agent:${reviewer}`,
            delegatee: `agent:${team.leaderId}`,
            round: st.rounds,
            state: blindOk ? 'completed' : 'input-required',
            summary: `「${st.title.slice(0, 24)}」盲审（${reviewer}）：${blindOk ? 'PASS' : 'REWORK'} — ${st.blindReview.notes.slice(0, 40)}`,
            reworkOf: blindOk ? null : reviewTrace.trace_id,
          });
          emit(blindTrace);
          if (!blindOk) {
            // 盲审 REWORK → 转回未通过，verdict 记盲审意见；还有轮次则继续返工循环。
            st.approved = false;
            st.verdict = `盲审未过（${reviewer}）：${st.blindReview.notes}`;
            lastReworkTrace = blindTrace.trace_id;
            continue;
          }
        }
      }
      break; // leader PASS（有 checklist 时盲审也 PASS）→ 真通过
    }
    speak(
      st.assigneeId,
      'execute',
      'end',
      st.approved ? `「${st.title.slice(0, 24)}」通过审阅，完成` : `「${st.title.slice(0, 24)}」产出保留（未过审）`,
    );
  };

  // —— 单个子任务处理：execute+review，失败自动改派一次（P0-2）——
  const runSubTask = async (
    st: SubTaskResult,
    sub: OrchestrationSubTask,
    kickoffQA?: string,
  ): Promise<void> => {
    const instruction = sub.instruction;
    const tried = new Set<string>([st.assigneeId]);
    try {
      await executeReviewLoop(st, sub, kickoffQA);
      return;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // P0-2 失败自动改派：团队还有其他成员没试过该子任务时，
      // 路由选一个改派对象，重置轮数重跑一遍（最多改派 1 次）。
      const rest = candidates.filter((c) => !tried.has(c.agentId));
      const decision = rest.length
        ? routeBySquadLeader({
            taskText: `${st.title}\n${instruction}`,
            leaderId: team.leaderId,
            candidates: rest,
          })
        : null;
      const next = decision?.assigneeId;
      if (next && !tried.has(next)) {
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `agent:${next}`,
            round: 1,
            state: 'working',
            summary: `「${st.title.slice(0, 24)}」执行失败，改派给 ${next} 重试：${errMsg.slice(0, 40)}`,
          }),
        );
        st.assigneeId = next;
        st.assignedBy = 'routing';
        st.rounds = 0;
        st.output = null;
        st.approved = false;
        st.verdict = '';
        st.error = undefined;
        try {
          await executeReviewLoop(st, sub, kickoffQA);
          emit(
            makeTrace({
              taskId,
              rootId,
              delegator: `agent:${next}`,
              delegatee: `agent:${team.leaderId}`,
              round: Math.max(1, st.rounds),
              state: st.approved ? 'completed' : 'working',
              summary: `「${st.title.slice(0, 24)}」改派重试完成：${st.approved ? 'Leader 审阅通过' : '产出保留但未通过审阅'}`,
            }),
          );
          return;
        } catch (e2) {
          // 改派也失败：维持 error 终态。
          st.error = e2 instanceof Error ? e2.message : String(e2);
          st.output = null;
          speak(next, 'execute', 'end', `「${st.title.slice(0, 24)}」改派后仍失败`);
          emit(
            makeTrace({
              taskId,
              rootId,
              delegator: `agent:${next}`,
              delegatee: `agent:${team.leaderId}`,
              round: Math.max(1, st.rounds),
              state: 'failed',
              summary: `「${st.title.slice(0, 24)}」改派给 ${next} 后仍失败：${st.error.slice(0, 50)}`,
            }),
          );
          return;
        }
      }
      // 无可改派对象：单成员失败不阻塞全局，记 error，产出置空，trace 落 failed。
      st.error = errMsg;
      st.output = null;
      speak(st.assigneeId, 'execute', 'end', `「${st.title.slice(0, 24)}」执行失败`);
      emit(
        makeTrace({
          taskId,
          rootId,
          delegator: `agent:${st.assigneeId}`,
          delegatee: `agent:${team.leaderId}`,
          round: Math.max(1, st.rounds),
          state: 'failed',
          summary: `「${st.title.slice(0, 24)}」执行失败：${st.error.slice(0, 50)}`,
        }),
      );
    }
  };

  // —— 步骤 2.5：KICKOFF 开工确认（P2，成员提问 → leader 一次批量解答）——
  // E 预算护栏①：预算耗尽后跳过开工提问。
  // P1-3 按需触发：任务文本足够具体且每条子任务都有验收标准时，说明分工
  // 已经讲清，跳过提问环节（省下 2N 次调用）；含糊任务才留提问通道。
  const kickoffNeeded = taskText.trim().length < 50 || subtasks.some((s) => !s.acceptance);
  const kickoffQA = new Map<number, string>();
  if (memberIds.length > 1 && hasBudget() && !kickoffNeeded) {
    emit(
      makeTrace({
        taskId,
        rootId,
        delegator: `agent:${team.leaderId}`,
        delegatee: `team:${team.id}`,
        round: 1,
        state: 'working',
        summary: '开工确认跳过：任务指令明确，各子任务均有验收标准',
      }),
    );
  }
  if (memberIds.length > 1 && hasBudget() && kickoffNeeded) {
    try {
      const questions: { idx: number; assigneeId: string; question: string }[] = [];
      await Promise.all(
        assigned.map(async (st, idx) => {
          if (!hasBudget()) return; // 预算护栏：提问途中耗尽即停
          try {
            speak(st.assigneeId, 'kickoff', 'start', `开工确认「${st.title.slice(0, 24)}」…`);
            const reply = await call(st.assigneeId, [
              {
                role: 'system',
                content: personaSystem(
                  personas,
                  st.assigneeId,
                  '开工确认：你是团队中的执行成员，动手前先确认分工。看清指派给你的子任务指令与任务背景：' +
                    '若对分工边界、成员间接口约定或交付形式有疑问，只提一个最关键的问题；' +
                    '若没有疑问，第一行只输出 OK。',
                ),
              },
              {
                role: 'user',
                content: `指派给你的子任务：「${st.title}」\nLeader 指令：\n${subtasks[idx].instruction}\n\n原任务背景：\n${taskText}`,
              },
            ], { maxTokens: 400 });
            if (!firstLineIsOk(reply)) {
              questions.push({ idx, assigneeId: st.assigneeId, question: reply.trim().slice(0, 300) });
              speak(st.assigneeId, 'kickoff', 'end', '已提交开工问题，等待 leader 解答');
            } else {
              speak(st.assigneeId, 'kickoff', 'end', '无疑问，准备开工');
            }
          } catch {
            /* 单条提问失败视为无问题 */
          }
        }),
      );
      // 有问题才发起 leader 批量解答（一次调用），全部 OK 则跳过。
      if (questions.length > 0 && hasBudget()) {
        const qaText = await call(team.leaderId, [
          {
            role: 'system',
            content: personaSystem(
              personas,
              team.leaderId,
              '开工确认：你是团队 leader。下面是成员动手前提出的问题，请逐条编号批量解答，' +
                '每条一两句给出明确约定（分工边界 / 接口格式 / 交付形式），不要展开发挥。',
            ),
          },
          {
            role: 'user',
            content:
              `原任务：\n${taskText}\n\n成员提问：\n` +
              questions.map((q, i) => `${i + 1}.（${q.assigneeId}）${q.question}`).join('\n'),
          },
        ], { maxTokens: 1200 });
        for (const q of questions) {
          kickoffQA.set(q.idx, `你的问题：${q.question}\nLeader 解答：\n${qaText}`);
        }
        emit(
          makeTrace({
            taskId,
            rootId,
            delegator: `agent:${team.leaderId}`,
            delegatee: `team:${team.id}`,
            round: 1,
            state: 'working',
            summary: `开工确认：成员提出 ${questions.length} 个问题，leader 已解答`,
          }),
        );
      }
    } catch {
      /* 开工确认整体失败降级：跳过问答，照常执行 */
    }
  }

  // —— 步骤 3+4：EXECUTE ∥ REVIEW（各子任务并行，单成员失败不阻塞）——
  await Promise.all(
    assigned.map((st, idx) => runSubTask(st, subtasks[idx], kickoffQA.get(idx))),
  );

  // —— 步骤 4.5：CROSS_REVIEW 成员交叉评审（P1-1，一轮封顶）——
  // E 预算护栏①：预算耗尽后跳过交叉评审。
  try {
    const reviewable = assigned.filter((st) => st.approved && !st.error);
    if (reviewable.length >= 2 && !hasBudget()) {
      noteBudgetGuard('跳过交叉评审');
    }
    if (reviewable.length >= 2 && hasBudget()) {
      await Promise.all(
        reviewable.map(async (st) => {
          if (!hasBudget()) return; // 预算护栏：评审途中耗尽即停
          try {
            speak(st.assigneeId, 'cross-review', 'start', '交叉评审其他成员产出…');
            const others = reviewable
              .filter((o) => o !== st)
              .map((o) => `### ${o.title}（执行者 ${o.assigneeId}）\n${(o.output ?? '').slice(0, 800)}`)
              .join('\n\n');
            const reply = await call(st.assigneeId, [
              {
                role: 'system',
                content: personaSystem(
                  personas,
                  st.assigneeId,
                  `交叉评审：你是团队中的执行成员，刚完成子任务「${st.title}」。下面是其他成员负责子任务的标题与产出。` +
                    '若你的产出需要与他人衔接或据此修订，直接输出修订后的完整版本；' +
                    '若无需调整，第一行只输出 OK。',
                ),
              },              {
                role: 'user',
                content:
                  `你的子任务：「${st.title}」\n你的产出：\n${(st.output ?? '').slice(0, 800)}` +
                  `\n\n其他子任务产出：\n${others}`,
              },
            ], { maxTokens: KIND_TOKEN_BUDGET[classifySubTaskKind(st.title, '')] });
            const revised = reply.trim();
            // 「OK，无需调整。」等确认变体归一化后仍判 OK，不当修订版；
            // 且修订版必须足够长（> 原产出的 50% 或 >200 字），防止一句话回复覆盖真实产出。
            const longEnough =
              revised.length > (st.output?.length ?? 0) * 0.5 || revised.length > 200;
            if (!firstLineIsOk(reply) && longEnough) {
              st.output = revised;
              speak(st.assigneeId, 'cross-review', 'end', `「${st.title.slice(0, 24)}」已按交叉评审修订产出`);
              emit(
                makeTrace({
                  taskId,
                  rootId,
                  delegator: `agent:${st.assigneeId}`,
                  delegatee: `agent:${team.leaderId}`,
                  round: Math.max(1, st.rounds),
                  state: 'working',
                  summary: `「${st.title.slice(0, 24)}」交叉评审后修订产出：${st.output.slice(0, 50)}`,
                }),
              );
            }
          } catch {
            /* 单条交叉评审失败跳过，不影响全局 */
          }
        }),
      );
    }
  } catch {
    /* 交叉评审整体失败降级：保留原产出 */
  }

  // —— 步骤 4.6：REPLAN leader 中途重规划（P1-2，最多一次、最多追加 3 条）——
  // E 预算护栏①：预算耗尽后跳过重规划。
  try {
    if (!hasBudget()) {
      noteBudgetGuard('跳过重规划');
    } else {
    speak(team.leaderId, 'replan', 'start', '正在检查任务覆盖，必要时追加子任务…');
    const replanRaw = await call(team.leaderId, [
      {
        role: 'system',
        content: personaSystem(
          personas,
          team.leaderId,
          '重规划：你是团队 leader，正在中途检查任务覆盖情况。下面是各成员当前的子任务产出。' +
            '若发现原任务覆盖有缺口、还缺必要的子任务，输出一个 JSON 数组追加子任务' +
            '（格式与初始拆分相同：[{"title":"...","instruction":"...","assigneeId":"可选"}]，最多 3 条）；' +
            '若覆盖已完整无需追加，第一行只输出 OK。',
        ),
      },
      { role: 'user', content: `原任务：\n${taskText}\n\n${buildDigest(assigned)}` },
    ], { maxTokens: 1500 });
    const extra = parseSubTasks(replanRaw);
    if (extra) {
      const toAdd = extra.slice(0, 3);
      speak(team.leaderId, 'replan', 'end', `覆盖有缺口，追加 ${toAdd.length} 个子任务`);
      emit(
        makeTrace({
          taskId,
          rootId,
          delegator: `agent:${team.leaderId}`,
          delegatee: `team:${team.id}`,
          round: 1,
          state: 'working',
          summary: `Leader 重规划：追加 ${toAdd.length} 个子任务：${toAdd.map((s) => s.title).join('；').slice(0, 60)}`,
        }),
      );
      // 追加的子任务走同一套 指派 → execute+review 管线。
      const appended = toAdd.map(assignOne);
      for (const st of appended) {
        assigned.push(st);
        emitAssignTrace(st);
      }
      await Promise.all(appended.map((st, i) => runSubTask(st, toAdd[i])));
    } else {
      speak(team.leaderId, 'replan', 'end', '覆盖完整，无需追加');
    }
    }
  } catch {
    /* 重规划失败降级：按现有产出直接汇总 */
  }

  // —— 步骤 5：SUMMARIZE（leader 汇总全部产出）——
  // 汇总上限按子任务规模动态化：底数 6000 + 每个子任务 2000，封顶 16000。
  // 固定小上限会让多子任务报告在句子中间被砍断（真实事故：6 子任务调研报告限 4000 字）。
  // E 预算护栏③：SUMMARIZE 永远保底执行（不受预算拦截），预算受限时如实标注。
  const summarizeLimit = Math.min(6000 + assigned.length * 2000, 16000);
  const summarizeSystem = personaSystem(
    personas,
    team.leaderId,
    '你是团队 leader。下面是各成员对子任务的真实产出，请汇总成一份完整、连贯的最终交付物交付给用户。' +
      '如实反映各部分质量（含失败/未通过部分），不要编造不存在的内容。' +
      `交付物可以写得完整充分，上限 ${summarizeLimit} 字；不要为压缩篇幅砍掉实质内容（数据、表格、案例都要保留）。`,
  );
  const summarizeUser = `原任务：\n${taskText}\n\n${buildDigest(assigned)}`;
  speak(team.leaderId, 'summarize', 'start', '正在汇总各成员产出，形成最终交付…');
  let deliverableRaw: string;
  if (input.chatRich) {
    // 续写拼接：汇总被 maxTokens 腰斩（finishReason === 'length'）时，把已产出前段
    // 回喂给 leader 让它接着写，最多续 2 次；写不完宁可在标注后收尾，也不交半句话。
    llmCalls += 1;
    let rich = await input.chatRich(team.leaderId, [
      { role: 'system', content: summarizeSystem },
      { role: 'user', content: summarizeUser },
    ]);
    deliverableRaw = rich.content;
    for (let cont = 0; rich.finishReason === 'length' && cont < 2; cont += 1) {
      llmCalls += 1;
      rich = await input.chatRich(team.leaderId, [
        { role: 'system', content: summarizeSystem },
        {
          role: 'user',
          content:
            `${summarizeUser}\n\n【你已写出的交付物前段】\n${deliverableRaw}\n\n` +
            '上次的输出在长度上限处戛然而止。请紧接着上文继续写完剩余部分（不要重复已写内容），' +
            '写到最后并自然收尾。',
        },
      ]);
      deliverableRaw += rich.content;
    }
    if (rich.finishReason === 'length') {
      emit(
        makeTrace({
          taskId,
          rootId,
          delegator: `agent:${team.leaderId}`,
          delegatee: `team:${team.id}`,
          round: 1,
          state: 'working',
          summary: '汇总交付续写 2 次后仍达输出上限，按现有内容收尾',
        }),
      );
    }
  } else {
    deliverableRaw = await call(team.leaderId, [
      { role: 'system', content: summarizeSystem },
      { role: 'user', content: summarizeUser },
    ]);
  }
  const deliverable = budgetLimited
    ? `${deliverableRaw}\n\n（预算受限，提前收敛）`
    : deliverableRaw;
  emit(
    makeTrace({
      taskId,
      rootId,
      delegator: `agent:${team.leaderId}`,
      delegatee: `team:${team.id}`,
      round: 1,
      state: 'completed',
      summary: `Leader 汇总交付：${deliverable.slice(0, 60)}`,
    }),
  );
  speak(team.leaderId, 'summarize', 'end', `交付已汇总（${deliverable.length} 字）`);

  return { subtasks: assigned, deliverable, traces, llmCalls };
}

/** 汇总/重规划共用的产出 digest：逐子任务列出执行者与产出（含失败/未通过标注）。 */
function buildDigest(list: SubTaskResult[]): string {
  return list
    .map((st, i) => {
      const body = st.error
        ? `（执行失败：${st.error}）`
        : `${st.output ?? ''}${st.approved ? '' : '\n（注意：该子任务未通过 leader 审阅）'}`;
      return `### 子任务${i + 1}：${st.title}（执行者 ${st.assigneeId}）\n${body}`;
    })
    .join('\n\n');
}
