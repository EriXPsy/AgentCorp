/**
 * src/lib/team-task-chat.ts
 * 团队任务会话视图的气泡映射与会话派活动作（纯函数/依赖注入，可单测）。
 *
 * 把任务的 executionEvents（含 A2A trace 事件）映射成群聊风格气泡：
 * 每条 A2A 事件 = delegatee 的一条发言（谁产出谁说话，箭头方向语义
 * 「delegator → delegatee」表示 delegatee 在干活/回话）；
 * 非 A2A 事件 = 居中系统提示行。
 */
import type { CreateTaskRequest, KanbanTask, TaskExecutionEvent } from '@/types/task';
import { parseA2aRoute } from '@/lib/a2a-timeline';

export interface TeamChatBubble {
  id: string;
  kind: 'a2a' | 'system' | 'user';
  /** 发言者 agentId（system 气泡为空；user 气泡固定为 'user'） */
  actorId: string;
  /** 协作对端（审阅时是 leader，执行时是 leader；供「回复给谁」展示） */
  peerId: string;
  text: string;
  round: number | null;
  verdict: 'pass' | 'rework' | null;
  createdAt?: string;
}

/** 对话事件前缀：chat:user→<agentId>（用户发言）/ chat:<agentId>→user（成员回复）。 */
export const TEAM_CHAT_EVENT_PREFIX = 'chat:';

/**
 * 剥掉编排 trace 参与者 id 上的 `agent:`/`team:` 前缀（如 `agent:writer-01` → `writer-01`），
 * 还原成纯 id 供 UI 按 agents/teams 查找；无前缀时原样返回。
 */
export function stripActorPrefix(id: string): string {
  if (id.startsWith('agent:')) return id.slice('agent:'.length);
  if (id.startsWith('team:')) return id.slice('team:'.length);
  return id;
}

export function parseTeamChatRoute(type: string | undefined): { from: string; to: string } | null {
  if (!type || !type.startsWith(TEAM_CHAT_EVENT_PREFIX)) return null;
  const route = type.slice(TEAM_CHAT_EVENT_PREFIX.length);
  const sep = route.indexOf('→');
  if (sep === -1) return null;
  return { from: route.slice(0, sep).trim(), to: route.slice(sep + 1).trim() };
}

export function mapEventsToTeamChatBubbles(events: TaskExecutionEvent[]): TeamChatBubble[] {
  return events.map((e, i) => {
    const chatRoute = parseTeamChatRoute(e.type);
    if (chatRoute) {
      // 用户发言：右列气泡；成员回复：左列成员气泡（谁说话谁是 actor）。
      // id 统一剥 agent:/team: 前缀，避免编排 trace 里的前缀泄漏到 UI 查找。
      const isUserSpeaking = chatRoute.from === 'user';
      return {
        id: `chat-${i}`,
        kind: isUserSpeaking ? 'user' : 'a2a',
        actorId: isUserSpeaking ? 'user' : stripActorPrefix(chatRoute.from),
        peerId: isUserSpeaking ? stripActorPrefix(chatRoute.to) : 'user',
        text: e.content ?? '',
        round: null,
        verdict: null,
        createdAt: e.createdAt,
      };
    }
    const route = parseA2aRoute(e.type);
    if (!route) {
      return {
        id: `sys-${i}`,
        kind: 'system',
        actorId: '',
        peerId: '',
        text: e.content ?? '',
        round: null,
        verdict: null,
        createdAt: e.createdAt,
      };
    }
    const roundMatch = /【第(\d+)轮】/.exec(e.content ?? '');
    const verdict = e.content?.includes('PASS')
      ? ('pass' as const)
      : e.content?.includes('REWORK')
        ? ('rework' as const)
        : null;
    return {
      id: `a2a-${i}`,
      kind: 'a2a',
      // 发言者 = 箭头终点（delegator 分派时 leader 在说话；交付/审阅时成员在说话）。
      // 这里以「动作接收方」为发言者更贴近群聊观感：事件描述的是 to 一侧的动作结果。
      // actorId/peerId 统一剥 agent:/team: 前缀，否则 UI 按 id 查 agent 会落空、直接渲染乱码原串。
      actorId: stripActorPrefix(route.to || route.from),
      peerId: route.to ? stripActorPrefix(route.from) : '',
      text: (e.content ?? '').replace(/【第\d+轮】/, '').trim(),
      round: roundMatch ? Number(roundMatch[1]) : null,
      verdict,
      createdAt: e.createdAt,
    };
  });
}

/**
 * 是否「非 leader 成员直接回复用户」的气泡（@成员 私聊式提问的答复发言）。
 * 视图层据此加视觉区分（@你 徽章 + 浅色高亮背景），让用户在 leader 与成员
 * 交替说话时一眼看出「这条是被我点名的成员在回我」。leader 回复维持默认样式。
 */
export function isDirectReplyToUser(bubble: TeamChatBubble, leaderId: string | null): boolean {
  return bubble.kind === 'a2a' && bubble.peerId === 'user' && bubble.actorId !== leaderId;
}

/**
 * 解析用户输入里的 @ 提及。命中成员名（@名字 或 @名字 出现在文中）即返回该成员，
 * 并给出去掉提及后的正文；未命中返回 null（调用方默认发给 leader）。
 */
export function parseMentionTarget(
  text: string,
  members: Array<{ id: string; name: string }>,
): { targetId: string; cleanText: string } | null {
  for (const m of members) {
    const token = `@${m.name}`;
    if (!text.includes(token)) continue;
    return { targetId: m.id, cleanText: text.replace(token, ' ').replace(/\s{2,}/g, ' ').trim() };
  }
  return null;
}

export interface TeamChatContext {
  /** 任务标题；团队房间日常沟通时不传 */
  taskTitle?: string;
  taskDescription?: string;
  teamName?: string;
  /** 最近交付摘要（截断后注入，帮成员对齐上下文） */
  workResultExcerpt?: string;
  /** 交付物是否已落盘可取（防止空口承诺「马上发给你」） */
  deliveryReady?: boolean;
}

/**
 * 构建发给真实模型的多轮消息：system 立人设 + 任务背景，
 * 历史只取 chat: 对话事件（协作 trace 不混入，避免上下文爆炸）。
 */
export function buildTeamChatMessages(
  agent: { id: string; name: string; persona?: string; responsibility?: string; isLeader: boolean },
  ctx: TeamChatContext,
  history: TeamChatBubble[],
  userText: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const systemParts = [
    `你是团队${ctx.teamName ? `「${ctx.teamName}」` : ''}的${agent.isLeader ? '负责人（leader）' : '成员'}「${agent.name}」。`,
    agent.persona ? `人设：${agent.persona}` : '',
    agent.responsibility ? `职责：${agent.responsibility}` : '',
    `你正在和老板${ctx.taskTitle ? `就团队任务「${ctx.taskTitle}」` : '进行团队日常'}直接沟通。`,
    ctx.taskDescription ? `任务要求：${ctx.taskDescription}` : '',
    ctx.workResultExcerpt ? `当前交付进展摘要：${ctx.workResultExcerpt}` : '',
    ctx.deliveryReady
      ? '交付物已保存到本地，界面上就有「打开/下载」入口。不要假装「马上发文件给你」——直接告诉老板去交付区获取即可。'
      : '',
    // 诚实约束：成员没有主动执行/发送的能力，动手只能靠系统触发编排
    '重要：你自己无法真的去执行或发送任何东西，不要承诺「马上弄好发给你」这类动作；' +
      '需要实际动手时，说明安排即可，系统会触发执行并展示过程。',
    '回复要求：中文、口语化、简明扼要，像同事在群里回话，不要堆砌格式。',
    // 派活判定约定：leader 识别到工作指令时输出执行标记，前端据此触发真实编排
    agent.isLeader
      ? '另外：如果老板这条消息是在派活、提修改意见或追加需求（而不是闲聊、问进度或纯讨论），' +
        '先在正文里用一两句话说明你的安排，然后在回复最后另起一行只输出 [EXECUTE]；' +
        '如果只是聊天、答疑或汇报，绝对不要输出该标记。'
      : '',
  ].filter(Boolean);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemParts.join('\n') },
  ];
  for (const b of history) {
    if (b.kind === 'user') {
      // 发给其他成员的话标注对象，避免当前成员误以为在问自己
      const toOther = b.peerId && b.peerId !== agent.id;
      messages.push({ role: 'user', content: toOther ? `（对另一位成员说）${b.text}` : b.text });
    } else if (b.kind === 'a2a' && b.peerId === 'user' && b.actorId === agent.id) {
      // 只有自己说过的话算 assistant；其他成员的回复不混入，保持人设单一
      messages.push({ role: 'assistant', content: b.text });
    }
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

export interface TeamChatRenderItem {
  key: string;
  bubble?: TeamChatBubble;
  /** true 表示这是「最终交付」气泡 */
  delivery?: boolean;
}

/**
 * 组装渲染序列：把「最终交付」气泡插到协作过程（非对话）末尾、后续对话之前，
 * 保持时间顺序——而不是永远钉在消息流最底部（那样每来一条新对话，
 * 交付气泡都像又冒出来的最新消息）。
 */
export function buildTeamChatRenderItems(
  bubbles: TeamChatBubble[],
  hasDelivery: boolean,
): TeamChatRenderItem[] {
  const items: TeamChatRenderItem[] = bubbles.map((b) => ({ key: b.id, bubble: b }));
  if (!hasDelivery) return items;
  let insertAt = items.length;
  for (let i = bubbles.length - 1; i >= 0; i -= 1) {
    const b = bubbles[i];
    const isDialogue = b.kind === 'user' || b.peerId === 'user';
    if (!isDialogue) {
      insertAt = i + 1;
      break;
    }
    // 纯对话流：交付插在对话之前
    insertAt = i;
  }
  items.splice(insertAt, 0, { key: '__delivery__', delivery: true });
  return items;
}

/**
 * 解析 leader 回复里的执行标记 [EXECUTE]。
 * 命中时返回剥离标记后的正文 + execute=true，调用方据此触发真实编排。
 * 标记必须出现在行尾独立成行，避免正文里偶然提到该词被误判。
 */
export function parseExecuteMarker(reply: string): { text: string; execute: boolean } {
  const m = /(?:^|\n)\s*\[EXECUTE\]\s*$/.exec(reply);
  if (!m) return { text: reply, execute: false };
  return { text: reply.slice(0, m.index).trimEnd(), execute: true };
}

/**
 * 派活意图分类器的消息组（独立小调用，不污染 leader 人设回复）。
 * 三分类：REWORK=改当前任务 / NEW=新任务 / CHAT=闲聊追问；
 * 调用方用 runRealChat(msgs, 8) 后交给 parseWorkIntent 解析。
 */
export function buildWorkIntentClassifierMessages(
  text: string,
  hasCurrentTask: boolean,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    {
      role: 'system',
      content:
        '判断老板对团队说的这句话的意图，只回答一个词：' +
        (hasCurrentTask
          ? 'REWORK（要求修改/返工/完善当前这个任务）、NEW（要求做一件新的事情/新的作品）、CHAT（闲聊、催促、问进度、问成员、纯讨论）。'
          : 'NEW（要求做一件事/一个作品）、CHAT（闲聊、催促、问进度、问成员、纯讨论）。') +
        '催促（如"快点""还没好吗"）本身不是新需求，算 CHAT。只输出这个词，不要任何其它内容。',
    },
    { role: 'user', content: text },
  ];
}

/** 解析意图分类结果；无法识别时回退 'chat'（保守不执行）。 */
export function parseWorkIntent(reply: string): 'rework' | 'new' | 'chat' {
  const token = reply.trim().toUpperCase();
  if (token.startsWith('REWORK')) return 'rework';
  if (token.startsWith('NEW')) return 'new';
  return 'chat';
}

/** 聊天滚动判定：用户是否停留在接近底部的位置（阈值内才允许自动滚底）。 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * 团队房间聊天记录 → 气泡。TeamChatEvent.from 为 'user' 时是老板发言（右列），
 * 否则是成员发言（左列，actorId=from）。from/to 同样剥 agent:/team: 前缀，
 * 防止编排 trace 桥接进来的带前缀 id 泄漏到 UI。
 */
export function mapTeamChatEventsToBubbles(
  events: Array<{ from: string; to: string; content: string; createdAt: string }>,
): TeamChatBubble[] {
  return events.map((e, i) => {
    const isUser = e.from === 'user';
    return {
      id: `room-${i}`,
      kind: isUser ? 'user' : 'a2a',
      actorId: isUser ? 'user' : stripActorPrefix(e.from),
      peerId: isUser ? stripActorPrefix(e.to) : 'user',
      text: e.content,
      round: null,
      verdict: null,
      createdAt: e.createdAt,
    };
  });
}

/** 从派活指令生成看板任务标题：取首行，截断 24 字。 */
export function taskTitleFromInstruction(text: string): string {
  const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '团队任务';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

/**
 * 是否展示「最终交付」气泡。执行中（含返工重做）时任务上的 workResult
 * 还是上一轮的旧交付物，展示出来会让老板误以为「刚开始重做就交付了」，
 * 因此执行中一律隐藏，新交付落库（workState 回 done/review）后自然出现。
 */
export function shouldShowDelivery(
  workResult: string | null | undefined,
  workState: string | null | undefined,
): boolean {
  if (!workResult) return false;
  return workState !== 'working' && workState !== 'starting';
}

// ── 立项 intake（意图分类 + 需求草稿，一次调用出全部）────────────────
// 取代旧的两段式（分类器 + 草稿各一次 RTT）：「开工吧」这类指代性指令的
// 真实需求藏在对话上下文里，intake 让模型一次给出「要不要立项 + 立什么项」。

export type TaskIntent = 'chat' | 'new' | 'rework';

export interface TaskIntake {
  intent: TaskIntent;
  /** intent 为 new 时给出（缺失时调用方回退原文标题） */
  title?: string;
  /** intent 为 new 时给出（缺失时调用方回退原文指令） */
  requirement?: string;
}

/**
 * intake 消息组。hasCurrentTask 时增加 REWORK 选项（改当前任务）；
 * 输出契约：只输出一个 JSON 对象 {"intent":"CHAT"|"NEW"|"REWORK","title":"…","requirement":"…"}。
 */
export function buildTaskIntakeMessages(
  userText: string,
  history: TeamChatBubble[],
  hasCurrentTask: boolean,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const dialogue = history
    .filter((b) => b.kind === 'user' || (b.kind === 'a2a' && b.peerId === 'user'))
    .slice(-10)
    .map((b) => `${b.kind === 'user' ? '老板' : '团队'}：${b.text.slice(0, 300)}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        '你是团队任务的立项助手。根据老板与团队的最近对话和老板的最新指令，判断意图；如需立项，同时整理好任务信息。' +
        '只输出一个 JSON 对象，不要输出任何其它文字：' +
        '{"intent":"CHAT"|"NEW"' + (hasCurrentTask ? '|"REWORK"' : '') + ',"title":"不超过 20 字的任务标题","requirement":"完整需求描述：背景、目标、交付物形态与关键约束，不超过 300 字"}。' +
        '意图判定：闲聊、催促、问进度、问成员、纯讨论 → CHAT（title/requirement 留空）；' +
        (hasCurrentTask ? '要求修改/返工/完善当前任务 → REWORK；' : '') +
        '要求做一件新的事情 → NEW。催促（如"快点""还没好吗"）本身不是新需求。' +
        '最新指令短或含糊（如「开工吧」「开始做」）时，真实需求以对话上下文为准归纳；不要编造上下文里没有的需求。',
    },
    {
      role: 'user',
      content: `【最近对话】\n${dialogue || '（无）'}\n\n【老板最新指令】\n${userText}`,
    },
  ];
}

/**
 * 解析 intake 输出：容忍代码围栏与杂散文字。intent 非法/缺失一律回退 'chat'
 * （保守不执行）；title/requirement 仅 new/rework 时可能携带。
 */
export function parseTaskIntake(reply: string): TaskIntake | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const raw = fenced ? fenced[1] : reply;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const intentRaw = typeof parsed.intent === 'string' ? parsed.intent.trim().toUpperCase() : '';
    const intent: TaskIntent = intentRaw.startsWith('REWORK')
      ? 'rework'
      : intentRaw.startsWith('NEW')
        ? 'new'
        : 'chat';
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const requirement = typeof parsed.requirement === 'string' ? parsed.requirement.trim() : '';
    return {
      intent,
      ...(title ? { title: title.length > 24 ? `${title.slice(0, 24)}…` : title } : {}),
      ...(requirement ? { requirement } : {}),
    };
  } catch {
    return null;
  }
}

// ── 立项确认卡协议（P0-1：人点头才执行）────────────────────────────
// 草稿与处置结果都编码进房间事件 content（事件存储是 append-only），
// 协议事件不渲染为对话气泡；处置以最新一条为准（新草稿出现旧草稿作废）。

export const TASK_DRAFT_PREFIX = '[task-draft]';
export const TASK_DRAFT_RESOLUTION_PREFIX = '[task-draft-resolution]';

export type TaskDraftAction = 'confirmed' | 'cancelled' | 'superseded';

export interface TaskDraftCard {
  id: string;
  title: string;
  requirement: string;
}

let taskDraftSeq = 0;

export function buildTaskDraftEvent(draft: { title: string; requirement: string }): string {
  taskDraftSeq += 1;
  const id = `d${Date.now().toString(36)}-${taskDraftSeq}`;
  return `${TASK_DRAFT_PREFIX}${JSON.stringify({ id, title: draft.title, requirement: draft.requirement })}`;
}

export function parseTaskDraftEvent(content: string): TaskDraftCard | null {
  if (!content.startsWith(TASK_DRAFT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(TASK_DRAFT_PREFIX.length)) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const requirement = typeof parsed.requirement === 'string' ? parsed.requirement.trim() : '';
    if (!id || !title || !requirement) return null;
    return { id, title, requirement };
  } catch {
    return null;
  }
}

export function buildTaskDraftResolution(id: string, action: TaskDraftAction): string {
  return `${TASK_DRAFT_RESOLUTION_PREFIX}${JSON.stringify({ id, action })}`;
}

export function parseTaskDraftResolution(content: string): { id: string; action: TaskDraftAction } | null {
  if (!content.startsWith(TASK_DRAFT_RESOLUTION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(content.slice(TASK_DRAFT_RESOLUTION_PREFIX.length)) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    const action = parsed.action;
    if (!id || (action !== 'confirmed' && action !== 'cancelled' && action !== 'superseded')) return null;
    return { id, action };
  } catch {
    return null;
  }
}

/** 协议事件判定：草稿卡与处置记录都不渲染为对话气泡。 */
export function isTaskProtocolContent(content: string): boolean {
  return content.startsWith(TASK_DRAFT_PREFIX) || content.startsWith(TASK_DRAFT_RESOLUTION_PREFIX);
}

// ── 草稿确认卡倒计时（纯前端渲染层，不进协议）──────────────────────
// 老板 15 分钟内未处置的草稿视为过期：卡片转「已超时」终态、按钮禁用。
// 倒计时只按草稿事件的 createdAt 在前端计算，不落任何协议事件。

export const TASK_DRAFT_TIMEOUT_MS = 15 * 60 * 1000;

/** 确认卡阶段：已有处置 → 处置终态；超时未处置 → expired；否则 pending。 */
export type TaskDraftPhase = TaskDraftAction | 'pending' | 'expired';

export function getTaskDraftPhase(
  resolution: TaskDraftAction | null | undefined,
  createdAt: string | undefined,
  now: number,
): TaskDraftPhase {
  if (resolution) return resolution;
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isFinite(created) && now - created >= TASK_DRAFT_TIMEOUT_MS) return 'expired';
  return 'pending';
}

/** 倒计时剩余毫秒 → mm:ss（负值按 0 计）。 */
export function formatDraftRemainingMs(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 汇总草稿处置状态：同一 id 多条处置时最新一条生效。 */
export function collectTaskDraftResolutions(
  events: Array<{ content: string }>,
): Map<string, TaskDraftAction> {
  const map = new Map<string, TaskDraftAction>();
  for (const e of events) {
    const r = parseTaskDraftResolution(e.content);
    if (r) map.set(r.id, r.action);
  }
  return map;
}

/**
 * 从房间交付消息反查可验收任务。交付消息内容形如「标题」交付完成，请验收：…
 * （teamChatWorkOrder / autoWorker 同步到房间时不带 taskId），按标题匹配
 * 当前 status==='review' 的任务：唯一匹配才返回（多义/非 review 一律不显示按钮，
 * 防止误验收别的任务或给已处理的消息重复挂按钮）。
 */
export function findReviewTaskForDelivery<T extends { id: string; title: string; status: string }>(
  content: string,
  tasks: T[],
): T | null {
  const m = /^\s*「(.+?)」交付完成，请验收/.exec(content);
  if (!m) return null;
  const matches = tasks.filter((t) => t.status === 'review' && t.title === m[1]);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * @成员直派解析：消息 @ 了非 leader 成员且去掉提及后仍有指令正文 → 直派该成员。
 * 返回 null 时维持现状（@leader / 无 @ 走 leader 三路意图分类管线）。
 */
export function parseDirectAssignTarget(
  text: string,
  members: Array<{ id: string; name: string }>,
  leaderId: string | null,
): { targetId: string; targetName: string; instruction: string } | null {
  const mention = parseMentionTarget(text, members);
  if (!mention || mention.targetId === leaderId) return null;
  if (!mention.cleanText) return null;
  const targetName = members.find((m) => m.id === mention.targetId)?.name ?? '';
  return { targetId: mention.targetId, targetName, instruction: mention.cleanText };
}

/**
 * 直派编排指令：加「【指定执行：@成员名】」前缀，leader 拆解（DECOMPOSE）时
 * 自然会把活分给该成员——不动编排 prompt 也能把指定执行人传进管线。
 */
export function buildDirectAssignInstruction(memberName: string, instruction: string): string {
  return `【指定执行：@${memberName}】${instruction}`;
}

// ── 会话派活动作（依赖注入，视图层只收依赖与按钮状态）────────────────
// 承载「立项/开工/打回」的关键路径时序，约束：
// - 先建任务、后落 confirmed 处置：createTask 失败时卡片保持待确认可重试；
//   反向失败（任务已建但处置落库失败）容忍——继续开工，卡片状态下次刷新
//   由 collectTaskDraftResolutions 决定。
// - 知会消息一律 best-effort，执行触发不依赖它（知会挂掉不能卡住派活）。
// - 生效指令在 createTask 时就写进 task.description：AutoWorker 执行用的是
//   任务本身的 title/description，指令随任务走，谁领到都不丢。
// - runWorkOrder 返回值必须检查：false = 任务被占用，提示而非静默。

export interface WorkOrderToast {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

export interface RoomWorkOrderDeps {
  createTask: (input: CreateTaskRequest) => Promise<KanbanTask>;
  appendRoomEvent: (teamId: string, event: { from: string; to: string; content: string }) => Promise<unknown>;
  ensureTeamTaskSession: (task: { id: string; title: string; teamId?: string; teamName?: string }) => unknown;
  runWorkOrder: (taskId: string, instruction: string) => Promise<boolean>;
  toast: WorkOrderToast;
}

/** 触发会话派活：受理失败（任务已被占用）提示在执行队列中而非静默；抛错统一 toast。 */
function triggerWorkOrder(
  deps: Pick<RoomWorkOrderDeps, 'runWorkOrder' | 'toast'>,
  taskId: string,
  instruction: string,
): void {
  void deps
    .runWorkOrder(taskId, instruction)
    .then((accepted) => {
      // 任务已被 AutoWorker/另一通道领走：指令已随 description 走，提示即可
      if (!accepted) deps.toast.info('任务已在执行队列中');
    })
    .catch((err) => {
      deps.toast.error(`派活执行失败：${err instanceof Error ? err.message : String(err)}`);
    });
}

/** 草稿确认开工时写进任务描述的生效指令（完整文本随任务走）。 */
export function buildConfirmedDraftInstruction(requirement: string): string {
  return `草稿已确认，按立项需求执行。\n${requirement}`;
}

/**
 * 立项确认卡「确认开工」：先 createTask，成功后才落 confirmed 处置事件。
 * createTask 抛错直接上抛（视图统一 toast），不落处置、不开工。
 */
export async function confirmTaskDraftAndRun(
  card: TaskDraftCard,
  team: { id: string; name: string },
  leaderId: string,
  deps: RoomWorkOrderDeps,
): Promise<void> {
  const instruction = buildConfirmedDraftInstruction(card.requirement);
  const created = await deps.createTask({
    title: card.title,
    description: instruction,
    priority: 'medium',
    teamId: team.id,
    teamName: team.name,
  });
  // 任务已建成，confirmed 处置落库失败不阻断开工
  try {
    await deps.appendRoomEvent(team.id, {
      from: 'user',
      to: leaderId,
      content: buildTaskDraftResolution(card.id, 'confirmed'),
    });
  } catch {
    deps.toast.info('任务已立项，确认记录同步失败，卡片状态稍后刷新');
  }
  deps.ensureTeamTaskSession({
    id: created.id,
    title: created.title,
    teamId: team.id,
    teamName: team.name,
  });
  // 知会消息 best-effort：不在执行触发的关键路径上
  void deps
    .appendRoomEvent(team.id, {
      from: leaderId,
      to: 'user',
      content: `已立项「${created.title}」，我这就拆解分派，执行过程在任务会话里同步。`,
    })
    .catch(() => { /* 知会失败不阻断开工 */ });
  deps.toast.info('已立项，团队开始执行，过程可在任务会话中查看');
  triggerWorkOrder(deps, created.id, instruction);
}

/**
 * @成员直派立项：生效指令（含【指定执行】前缀）直接写进 task.description，
 * AutoWorker 抢先领走任务时指令也不丢；知会 best-effort。
 */
export async function runDirectAssign(
  team: { id: string; name: string },
  leaderId: string | null,
  directAssign: { targetId: string; targetName: string; instruction: string },
  deps: RoomWorkOrderDeps,
): Promise<void> {
  const instruction = buildDirectAssignInstruction(directAssign.targetName, directAssign.instruction);
  const created = await deps.createTask({
    title: taskTitleFromInstruction(directAssign.instruction),
    description: instruction,
    priority: 'medium',
    teamId: team.id,
    teamName: team.name,
    assigneeId: directAssign.targetId,
    assigneeRole: directAssign.targetName,
  });
  deps.ensureTeamTaskSession({
    id: created.id,
    title: created.title,
    teamId: team.id,
    teamName: team.name,
  });
  if (leaderId) {
    void deps
      .appendRoomEvent(team.id, {
        from: leaderId,
        to: 'user',
        content: `收到，已直接指派给 @${directAssign.targetName}：「${created.title}」，我盯进度，执行过程在任务会话里同步。`,
      })
      .catch(() => { /* 知会失败不阻断开工 */ });
  }
  deps.toast.info(`已立项「${created.title}」并直接指派给 ${directAssign.targetName}`);
  triggerWorkOrder(deps, created.id, instruction);
}

export interface ReworkWorkOrderDeps {
  updateTask: (taskId: string, updates: Partial<KanbanTask>) => Promise<unknown>;
  runWorkOrder: (taskId: string, instruction: string) => Promise<boolean>;
  toast: WorkOrderToast;
}

/**
 * 打回重做：回 in-progress 后复用编排管线重跑。受理失败（任务被占用）时
 * 把状态改回 review 并提示，避免任务永久卡在 in-progress；返回是否受理。
 * runWorkOrder 抛错直接上抛（其内部已复位任务状态，视图统一 toast）。
 */
export async function rejectDeliveryAndRework(
  task: { id: string },
  feedback: string,
  deps: ReworkWorkOrderDeps,
): Promise<boolean> {
  await deps.updateTask(task.id, { status: 'in-progress' });
  const accepted = await deps.runWorkOrder(task.id, `打回重做：${feedback}`);
  if (!accepted) {
    await deps.updateTask(task.id, { status: 'review' });
    deps.toast.error('任务正被占用，稍后再试');
    return false;
  }
  return true;
}

/**
 * 任务会话 rework 指令：受理成功才提示「开始执行」；未受理（任务被占用）
 * 提示稍后再试，不再先报喜。
 */
export async function acceptTaskRework(
  taskId: string,
  instruction: string,
  deps: Pick<ReworkWorkOrderDeps, 'runWorkOrder' | 'toast'>,
): Promise<void> {
  try {
    const accepted = await deps.runWorkOrder(taskId, instruction);
    if (accepted) deps.toast.info('收到，leader 开始安排成员执行，过程会实时出现在这里');
    else deps.toast.error('任务正被占用，稍后再试');
  } catch (err) {
    deps.toast.error(`派活执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface NewTaskFromChatDeps {
  createTask: (input: CreateTaskRequest) => Promise<KanbanTask>;
  ensureTeamTaskSession: (task: { id: string; title: string; teamId?: string; teamName?: string }) => unknown;
  appendTaskEvent: (taskId: string, event: { type: string; content: string }) => Promise<unknown>;
  runWorkOrder: (taskId: string, instruction: string) => Promise<boolean>;
  toast: WorkOrderToast;
}

/**
 * 任务会话里立新任务（intent==='new'）：知会消息 best-effort，
 * 执行触发不依赖它（知会 append 抛错不能卡住派活）。
 */
export async function createTaskFromChatIntake(
  source: { taskId: string; teamId: string; teamName: string; leaderId: string },
  draft: { title: string; requirement: string },
  instruction: string,
  deps: NewTaskFromChatDeps,
): Promise<void> {
  try {
    const created = await deps.createTask({
      title: draft.title,
      description: draft.requirement,
      priority: 'medium',
      teamId: source.teamId,
      teamName: source.teamName,
    });
    deps.ensureTeamTaskSession({
      id: created.id,
      title: created.title,
      teamId: source.teamId,
      teamName: source.teamName,
    });
    void deps
      .appendTaskEvent(source.taskId, {
        type: `chat:${source.leaderId}→user`,
        content: `这是件新活，我已立项「${created.title}」并开始执行，过程在对应的任务会话里同步。`,
      })
      .catch(() => { /* 知会失败不阻断开工 */ });
    deps.toast.info(`已立项「${created.title}」并开始执行`);
    triggerWorkOrder(deps, created.id, instruction);
  } catch (err) {
    deps.toast.error(`立项失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 房间对话历史快照：在 append 用户消息「之前」取——append 是 await，期间
 * 并发广播可能插入新事件，事后按「最后一条是我刚发的」slice(0,-1) 会裁错。
 * 返回的气泡列表是一份拷贝，之后的事件变动不影响它，可直接作
 * buildTeamChatMessages / buildTaskIntakeMessages 的 history。
 */
export function snapshotRoomHistory(
  events: Array<{ from: string; to: string; content: string; createdAt: string }>,
): TeamChatBubble[] {
  return mapTeamChatEventsToBubbles(events);
}
