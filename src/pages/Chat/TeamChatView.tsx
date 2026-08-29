/**
 * src/pages/Chat/TeamChatView.tsx
 * 团队房间：与整个团队对话的会话视图——默认 leader 接话，@成员名 点名任意成员。
 *
 * 与 TeamTaskChatView（单任务）的区别：这里是团队级常驻房间，
 * 聊天记录挂在团队对象上（team.chatEvents，上限 200 条），刷新/重启不丢。
 * 在房间里派活会自动立项：创建看板团队任务并触发真实编排，
 * 执行过程在对应的任务会话里展开。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, CheckCircle2, ClipboardList, Loader2, RotateCcw, SendHorizonal, TriangleAlert, Users } from 'lucide-react';
import { toast } from 'sonner';

import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useChatStore } from '@/stores/chat';
import { useRightPanelStore } from '@/stores/rightPanelStore';
import { useTeamsStore } from '@/stores/teams';
import MarkdownContent from '@/pages/Chat/MarkdownContent';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { StreamingReplyBubble } from '@/components/chat/StreamingReplyBubble';
import { TaskDraftCard } from '@/components/chat/TaskDraftCard';
import { TeamLiveBubbles } from '@/components/chat/TeamLiveBubbles';
import { buildBusyStatusLine, deriveBusyAgentIds, formatBubbleTime, memberRoleLabel } from '@/lib/team-roster';
import {
  buildTaskDraftEvent,
  buildTaskDraftResolution,
  buildTaskIntakeMessages,
  buildTeamChatMessages,
  buildWorkIntentClassifierMessages,
  collectTaskDraftResolutions,
  confirmTaskDraftAndRun,
  findReviewTaskForDelivery,
  isNearBottom,
  isTaskProtocolContent,
  mapTeamChatEventsToBubbles,
  parseDirectAssignTarget,
  parseExecuteMarker,
  parseMentionTarget,
  parseTaskDraftEvent,
  parseTaskIntake,
  parseWorkIntent,
  rejectDeliveryAndRework,
  runDirectAssign,
  snapshotRoomHistory,
  taskTitleFromInstruction,
  type TaskDraftAction,
  type TaskDraftCard as TaskDraftCardData,
  type TeamChatBubble,
} from '@/lib/team-task-chat';
import { retryFailedTask, runTeamChatWorkOrder } from '@/stores/teamChatWorkOrder';
import { runRealChat } from '@/engine/llm/realExecutor';
import { cn } from '@/lib/utils';
import type { KanbanTask } from '@/types/task';

export function TeamChatView({ teamId }: { teamId: string }) {
  const navigate = useNavigate();
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  // 编排实况（内存态）：teamId 下各成员的直播槽位，多成员并行互不覆盖
  const roomLive = useTeamsStore((s) => s.roomLive[teamId]);
  const agents = useAgentsStore((s) => s.agents);
  const tasks = useApprovalsStore((s) => s.tasks);
  const fetchTasks = useApprovalsStore((s) => s.fetchTasks);
  const createTask = useApprovalsStore((s) => s.createTask);
  const updateTask = useApprovalsStore((s) => s.updateTask);
  const fetchAgentStatuses = useAgentsStore((s) => s.fetchAgentStatuses);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  // 流式回复：leader/成员回复期间的分段揭示内容（final 落房间后清空，被正式气泡取代）
  const [streamReply, setStreamReply] = useState<{ agentId: string; text: string } | null>(null);
  // 房间内一键验收/打回：reviewBusy 防连点；rejectTaskId 记录正在填打回意见的任务
  const [reviewBusy, setReviewBusy] = useState(false);
  const [rejectTaskId, setRejectTaskId] = useState<string | null>(null);
  const [rejectDraft, setRejectDraft] = useState('');

  useEffect(() => {
    void fetchTeams();
    // 忙闲状态依赖任务数据：房间打开时刷新任务快照并派生 agentStatuses
    void fetchTasks().then(() => void fetchAgentStatuses());
  }, [fetchTeams, fetchTasks, fetchAgentStatuses]);

  const team = teams.find((t) => t.id === teamId) ?? null;
  const leaderId = team?.leaderId ?? null;
  const teamTasks = useMemo(() => tasks.filter((t) => t.teamId === teamId), [tasks, teamId]);

  // 可对话成员：leader 在前
  const members = useMemo(() => {
    if (!team) return [];
    const ids = [team.leaderId, ...team.memberIds];
    return ids
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
  }, [team, agents]);

  // 头部实时状态行：有成员在忙（任一 in-progress 任务的 assignee）时显示「X 正在工作…」
  const busyLine = useMemo(() => {
    const busyIds = deriveBusyAgentIds(tasks);
    return buildBusyStatusLine(members.filter((m) => busyIds.has(m.id)).map((m) => m.name));
  }, [tasks, members]);

  const roomEvents = useMemo(() => team?.chatEvents ?? [], [team?.chatEvents]);
  const bubbles = useMemo(
    // 协议事件（立项草稿卡/处置记录）不进对话流，由 renderItems 单独渲染
    () => mapTeamChatEventsToBubbles(roomEvents.filter((e) => !isTaskProtocolContent(e.content))),
    [roomEvents],
  );
  const draftResolutions = useMemo(() => collectTaskDraftResolutions(roomEvents), [roomEvents]);
  // 渲染序列：按房间事件原始顺序穿插对话气泡与立项草稿卡（草稿卡带事件 createdAt 供倒计时）
  const renderItems = useMemo(() => {
    const items: Array<{ key: string; bubble?: TeamChatBubble; draft?: TaskDraftCardData; draftAction?: TaskDraftAction; draftCreatedAt?: string }> = [];
    let bubbleIdx = 0;
    roomEvents.forEach((e, i) => {
      if (isTaskProtocolContent(e.content)) {
        const card = parseTaskDraftEvent(e.content);
        if (card && e.from !== 'user') {
          items.push({ key: `draft-${i}`, draft: card, draftAction: draftResolutions.get(card.id), draftCreatedAt: e.createdAt });
        }
        return;
      }
      const b = bubbles[bubbleIdx];
      bubbleIdx += 1;
      if (b) items.push({ key: b.id, bubble: b });
    });
    return items;
  }, [roomEvents, bubbles, draftResolutions]);

  // 失败自救：本团队失败态任务，房间顶部出失败条 + 重试入口
  const failedTasks = useMemo(
    () => teamTasks.filter((t) => t.workState === 'failed'),
    [teamTasks],
  );

  // 交付消息 → 可验收任务（按「标题」唯一匹配 review 任务；同一任务只把按钮挂在最新一条交付气泡上，
  // 返工循环里的历史交付消息不再重复出现按钮）
  const reviewActionByBubble = useMemo(() => {
    const latestBubbleByTask = new Map<string, string>();
    for (const b of bubbles) {
      if (b.kind === 'user') continue;
      const t = findReviewTaskForDelivery(b.text, teamTasks);
      if (t) latestBubbleByTask.set(t.id, b.id);
    }
    const byBubble = new Map<string, KanbanTask>();
    for (const [taskId, bubbleId] of latestBubbleByTask) {
      const t = teamTasks.find((x) => x.id === taskId);
      if (t) byBubble.set(bubbleId, t);
    }
    return byBubble;
  }, [bubbles, teamTasks]);

  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [bubbles.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);

  // @ 提及候选
  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(draft);
    return m ? m[1] : null;
  }, [draft]);
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return members.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()));
  }, [members, mentionQuery]);

  useEffect(() => {
    setMentionOpen(mentionQuery !== null && mentionCandidates.length > 0);
  }, [mentionQuery, mentionCandidates.length]);

  const applyMention = useCallback((name: string) => {
    setDraft((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, (s) => `${s.startsWith(' ') ? ' ' : ''}@${name} `));
    setMentionOpen(false);
    inputRef.current?.focus();
  }, []);

  /** 追加一条房间消息（走 teams store，基于最新状态 + 200 条封顶） */
  const appendRoomEvent = useTeamsStore((s) => s.appendTeamChatEvent);

  /** 失败自救：房间失败条/任务会话失败条共用 teamChatWorkOrder 的 retryFailedTask */
  const handleRetryFailed = useCallback(async (taskId: string) => {
    try {
      const ok = await retryFailedTask(taskId);
      if (ok) toast.info('已重新排队，AutoWorker 会重新领取执行');
      else toast.error('重试未受理：任务不在失败态或正在执行中');
    } catch (err) {
      toast.error(`重试失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** 房间内一键验收：任务转 done + 房间留一条「老板已验收」 */
  const handleAcceptDelivery = useCallback(
    async (task: KanbanTask) => {
      if (reviewBusy || !team) return;
      setReviewBusy(true);
      try {
        await updateTask(task.id, { status: 'done' });
        await appendRoomEvent(teamId, {
          from: 'user',
          to: team.leaderId,
          content: `✅ 已验收「${task.title}」，这版通过，辛苦了！`,
        });
        toast.success(`已验收「${task.title}」`);
      } catch (err) {
        toast.error(`验收失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setReviewBusy(false);
      }
    },
    [appendRoomEvent, reviewBusy, team, teamId, updateTask],
  );

  /** 房间内打回重做：填意见 → 回 in-progress + 复用编排管线重跑 */
  const handleRejectDelivery = useCallback(
    async (task: KanbanTask) => {
      const feedback = rejectDraft.trim();
      if (!feedback || reviewBusy || !team) return;
      setReviewBusy(true);
      try {
        await appendRoomEvent(teamId, {
          from: 'user',
          to: team.leaderId,
          content: `🔁 「${task.title}」打回重做：${feedback}`,
        });
        // 受理失败（任务被占用）时状态已回 review 并提示，不清理输入方便重试
        const accepted = await rejectDeliveryAndRework(task, feedback, {
          updateTask,
          runWorkOrder: runTeamChatWorkOrder,
          toast,
        });
        if (!accepted) return;
        setRejectTaskId(null);
        setRejectDraft('');
        toast.info('已打回，leader 重新拆解分派中');
      } catch (err) {
        toast.error(`打回失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setReviewBusy(false);
      }
    },
    [appendRoomEvent, rejectDraft, reviewBusy, team, teamId, updateTask],
  );

  /** 立项确认卡处置：确认 → 先立项成功再落 confirmed 并开工（顺序反了会卡片显示已确认但任务没建）；取消 → 搁置 */
  const handleDraftResolution = useCallback(
    async (card: TaskDraftCardData, action: 'confirmed' | 'cancelled') => {
      if (reviewBusy || !team || !leaderId) return;
      setReviewBusy(true);
      try {
        if (action === 'cancelled') {
          await appendRoomEvent(teamId, { from: 'user', to: leaderId, content: buildTaskDraftResolution(card.id, 'cancelled') });
          await appendRoomEvent(teamId, {
            from: leaderId,
            to: 'user',
            content: `好的，「${card.title}」这单先搁置，有新想法随时说。`,
          });
          return;
        }
        await confirmTaskDraftAndRun(card, { id: team.id, name: team.name }, leaderId, {
          createTask,
          appendRoomEvent,
          ensureTeamTaskSession: (t) => useChatStore.getState().ensureTeamTaskSession(t),
          runWorkOrder: runTeamChatWorkOrder,
          toast,
        });
      } catch (err) {
        toast.error(`处理失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setReviewBusy(false);
      }
    },
    [appendRoomEvent, createTask, leaderId, reviewBusy, team, teamId],
  );

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !team) return;
    const mention = parseMentionTarget(text, members.map((a) => ({ id: a.id, name: a.name })));
    const targetId = mention?.targetId ?? leaderId;
    const target = agents.find((a) => a.id === targetId);
    if (!targetId || !target) {
      toast.error('团队还没有可接话的成员，请先检查团队配置');
      return;
    }
    const userText = mention?.cleanText || text;

    setSending(true);
    setDraft('');
    setMentionOpen(false);
    nearBottomRef.current = true;
    try {
      // 历史快照先取：append 是 await，期间并发广播可能插入新事件，
      // 事后按「最后一条是我刚发的」slice(0,-1) 裁剪会裁错消息
      const history = snapshotRoomHistory(
        useTeamsStore.getState().teams.find((t) => t.id === teamId)?.chatEvents ?? [],
      );
      // 1) 老板发言落房间
      await appendRoomEvent(teamId, { from: 'user', to: targetId, content: text });
      // 1.5) @非 leader 成员且语义是派活 → 直派：立项并把 assignee 指到该成员，
      //      生效指令（含【指定执行：@成员】前缀）写进任务描述，随任务走不丢；
      //      leader 模板知会 best-effort，不在执行触发的关键路径上。
      const directAssign = parseDirectAssignTarget(
        text,
        members.map((a) => ({ id: a.id, name: a.name })),
        leaderId,
      );
      if (directAssign) {
        let isWork = false;
        try {
          const verdict = await runRealChat(buildWorkIntentClassifierMessages(directAssign.instruction, false), 8);
          isWork = parseWorkIntent(verdict) !== 'chat';
        } catch {
          /* 分类器失败按闲聊处理，不擅自立项 */
        }
        if (isWork) {
          await runDirectAssign({ id: team.id, name: team.name }, leaderId, directAssign, {
            createTask,
            appendRoomEvent,
            ensureTeamTaskSession: (t) => useChatStore.getState().ensureTeamTaskSession(t),
            runWorkOrder: runTeamChatWorkOrder,
            toast,
          });
          return;
        }
      }
      // 2) 组上下文调真实模型（快照即历史，不再裁「最后一条」）。
      //    流式观感：/api/llm/chat 代理不支持 SSE，runRealChat 拿到全文后前端
      //    分段 reveal（onDelta 累积文本），期间房间显示流式气泡。
      const messages = buildTeamChatMessages(
        {
          id: target.id,
          name: target.name,
          persona: target.persona,
          responsibility: target.responsibility,
          isLeader: targetId === leaderId,
        },
        { teamName: team.name },
        history,
        userText,
      );
      setStreamReply({ agentId: targetId, text: '' });
      const reply = await runRealChat(messages, 2048, undefined, undefined, {
        onDelta: (acc) => setStreamReply({ agentId: targetId, text: acc }),
      });
      const { text: replyText, execute } = parseExecuteMarker(reply);
      await appendRoomEvent(teamId, { from: targetId, to: 'user', content: replyText });
      // final 已落房间：流式气泡被正式气泡取代
      setStreamReply(null);

      // 3) 对 leader 派活 → intake（一次调用完成意图分类 + 需求归纳）。
      //    判定为派活时不直接立项：先出确认卡，老板点头才开工（P0-1），
      //    防止「开工吧」式含糊指令被脑补成错误任务。
      if (targetId === leaderId) {
        let intake = null;
        try {
          intake = parseTaskIntake(await runRealChat(buildTaskIntakeMessages(userText, history, false), 900));
        } catch {
          /* intake 失败保守不立项 */
        }
        const intent = execute ? 'new' : (intake?.intent ?? 'chat');
        if (intent === 'new') {
          // 新草稿出现前，把旧的未处置草稿一律作废（最新生效）
          const events = useTeamsStore.getState().teams.find((t) => t.id === teamId)?.chatEvents ?? [];
          const resolutions = collectTaskDraftResolutions(events);
          for (const e of events) {
            const old = parseTaskDraftEvent(e.content);
            if (old && !resolutions.has(old.id)) {
              await appendRoomEvent(teamId, {
                from: targetId,
                to: 'user',
                content: buildTaskDraftResolution(old.id, 'superseded'),
              });
            }
          }
          const draftTitle = intake?.title ?? taskTitleFromInstruction(userText);
          const draftRequirement = intake?.requirement ?? userText;
          await appendRoomEvent(teamId, {
            from: targetId,
            to: 'user',
            content: buildTaskDraftEvent({ title: draftTitle, requirement: draftRequirement }),
          });
          toast.info('leader 已整理好任务草稿，确认后开工');
        }
      }
    } catch (err) {
      toast.error(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
      setStreamReply(null);
    }
  }, [agents, appendRoomEvent, createTask, draft, leaderId, members, sending, team, teamId]);

  if (!team) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium text-foreground">团队不存在或已解散</p>
        <p className="text-xs text-muted-foreground">这个房间关联的团队找不到了。</p>
      </div>
    );
  }

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const mentionTargetName = (b: TeamChatBubble) => agentOf(b.peerId)?.name ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 团队头（Knowe 风格）：左侧 团队名 + 实时状态行；右侧 任务入口 + 成员头像叠放（点击开花名册） */}
      <div className="shrink-0 border-b border-black/[0.06] px-8 py-3">
        <div className="mx-auto flex max-w-[1000px] items-center gap-3">
          <Users className="h-4 w-4 shrink-0" style={{ color: 'var(--neu-ink)' }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 truncate text-[14px] font-bold text-foreground">{team.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{members.length} 名成员</span>
            </div>
            {busyLine && (
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px]" style={{ color: '#b45309' }}>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: '#f59e0b' }} />
                {busyLine}
              </p>
            )}
          </div>
          {teamTasks.length > 0 && (
            <button
              type="button"
              onClick={() => navigate('/kanban')}
              className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
              style={{ color: 'var(--neu-ink)' }}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              {teamTasks.length} 个任务
            </button>
          )}
          {/* 成员头像叠放：点击打开成员花名册右栏（私聊入口移到花名册里） */}
          <button
            type="button"
            aria-label="打开成员花名册"
            title="查看成员"
            onClick={() => useRightPanelStore.getState().openPanel('roster', team.id)}
            className="flex shrink-0 items-center rounded-full p-0.5 transition-transform hover:scale-105"
          >
            <span className="flex -space-x-2">
              {members.slice(0, 5).map((a) => (
                <AgentAvatar
                  key={a.id}
                  avatar={a.avatar}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.05] text-[13px] ring-2 ring-white"
                />
              ))}
              {members.length > 5 && (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.06] text-[10px] font-bold text-muted-foreground ring-2 ring-white">
                  +{members.length - 5}
                </span>
              )}
            </span>
          </button>
        </div>
      </div>

      {/* 失败自救条：本团队有失败任务时置顶提示，一键重新排队（AutoWorker 重领） */}
      {failedTasks.length > 0 && (
        <div className="shrink-0 border-b border-black/[0.06] px-8 py-2" style={{ background: '#ef444408' }}>
          <div className="mx-auto flex max-w-[1000px] flex-col gap-1.5">
            {failedTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-[12px]" style={{ color: '#ef4444' }}>
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                <span className="font-semibold">「{t.title}」执行失败</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.workError ?? ''}</span>
                <button
                  type="button"
                  onClick={() => void handleRetryFailed(t.id)}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5"
                  style={{ color: '#ef4444' }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  重试
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 房间消息流 */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
          {bubbles.length === 0 && (
            <p className="py-8 text-center text-[12.5px] text-muted-foreground">
              这是 {team.name} 的房间。直接说话默认 {agentOf(team.leaderId)?.name ?? 'leader'} 接话，
              @ 可点名成员；派活会自动立项成看板任务并真正执行。
            </p>
          )}
          {renderItems.map((item) => {
            if (item.draft) {
              const card = item.draft;
              const action = item.draftAction ?? null;
              const speaker = agentOf(team.leaderId);
              return (
                <div key={item.key} className="flex items-start gap-2.5">
                  <AgentAvatar
                    avatar={speaker?.avatar}
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]"
                  />
                  <div className="min-w-0 max-w-[78%]">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                      <span className="font-semibold text-foreground">{speaker?.name ?? 'leader'}</span>
                      {speaker && (
                        <span className="text-muted-foreground">· {memberRoleLabel(speaker)}</span>
                      )}
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>leader</span>
                    </div>
                    {/* Knowe 风格派发确认卡：倒计时/终态纯前端按事件 createdAt 计算，协议不变 */}
                    <TaskDraftCard
                      card={card}
                      createdAt={item.draftCreatedAt}
                      assignee={speaker ? { name: speaker.name, avatar: speaker.avatar, role: memberRoleLabel(speaker) } : null}
                      action={action}
                      busy={reviewBusy}
                      onConfirm={() => void handleDraftResolution(card, 'confirmed')}
                      onReject={() => void handleDraftResolution(card, 'cancelled')}
                      onRevise={() => inputRef.current?.focus()}
                    />
                  </div>
                </div>
              );
            }
            const b = item.bubble!;
            if (b.kind === 'user') {
              const toName = mentionTargetName(b);
              const time = formatBubbleTime(b.createdAt);
              return (
                <div key={b.id} className="group flex items-start justify-end gap-2.5">
                  <div className="min-w-0 max-w-[78%]">
                    <div className="mb-1 flex items-center justify-end gap-1.5 text-[11px]">
                      <span className="text-muted-foreground">你{toName ? ` → ${toName}` : ''}</span>
                      {time && (
                        <span className="text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">{time}</span>
                      )}
                    </div>
                    {/* 品牌暖黄气泡（token --ac），深色文字保证对比度 */}
                    <div className="rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-relaxed" style={{ background: 'var(--ac, #f5b400)', color: '#1A1C1E' }}>
                      {b.text}
                    </div>
                  </div>
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[16px]" style={{ background: 'rgb(var(--ac-rgb, 245 180 0) / 0.15)' }}>
                    👤
                  </span>
                </div>
              );
            }
            const speaker = agentOf(b.actorId);
            const isLeader = b.actorId === leaderId;
            const time = formatBubbleTime(b.createdAt);
            // 交付消息关联到唯一 review 任务才挂验收/打回按钮（多义或已处理不显示）
            const reviewTask = reviewActionByBubble.get(b.id) ?? null;
            return (
              <div key={b.id} className="group flex items-start gap-2.5">
                <AgentAvatar
                  avatar={speaker?.avatar}
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]"
                />
                <div className="min-w-0 max-w-[78%]">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                    <span className="font-semibold text-foreground">{speaker?.name ?? b.actorId}</span>
                    {speaker && (
                      <span className="text-muted-foreground">· {memberRoleLabel(speaker)}</span>
                    )}
                    {isLeader && (
                      <span className="rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>leader</span>
                    )}
                    {time && (
                      <span className="text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">{time}</span>
                    )}
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-black/[0.05] bg-black/[0.03] px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
                    <MarkdownContent content={b.text} className="text-[13px] leading-relaxed" />
                  </div>
                  {reviewTask && (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={reviewBusy}
                          onClick={() => void handleAcceptDelivery(reviewTask)}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5 disabled:opacity-50"
                          style={{ color: '#22c55e' }}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          验收
                        </button>
                        <button
                          type="button"
                          disabled={reviewBusy}
                          onClick={() => {
                            setRejectTaskId(rejectTaskId === reviewTask.id ? null : reviewTask.id);
                            setRejectDraft('');
                          }}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-black/5 disabled:opacity-50"
                          style={{ color: '#ef4444' }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          打回重做
                        </button>
                      </div>
                      {rejectTaskId === reviewTask.id && (
                        <div className="flex items-center gap-2">
                          <input
                            value={rejectDraft}
                            onChange={(e) => setRejectDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const nativeEvent = e.nativeEvent as KeyboardEvent;
                                if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
                                e.preventDefault();
                                void handleRejectDelivery(reviewTask);
                              }
                            }}
                            placeholder="打回意见：哪里不行、要怎么改…"
                            className="min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/70"
                          />
                          <button
                            type="button"
                            disabled={reviewBusy || !rejectDraft.trim()}
                            onClick={() => void handleRejectDelivery(reviewTask)}
                            className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition-opacity disabled:opacity-40"
                            style={{ background: '#ef4444' }}
                          >
                            确认打回
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {/* 编排实况：多成员并行各占一个直播槽位；正式消息落房间后槽位清除 */}
          {roomLive && <TeamLiveBubbles live={roomLive} members={members} />}
          {/* leader/成员回复的流式气泡：reveal 期间显示，final 落房间后移除 */}
          {streamReply && (
            <StreamingReplyBubble
              name={agentOf(streamReply.agentId)?.name ?? streamReply.agentId}
              role={agentOf(streamReply.agentId) ? memberRoleLabel(agentOf(streamReply.agentId)!) : undefined}
              avatar={agentOf(streamReply.agentId)?.avatar}
              text={streamReply.text}
            />
          )}
          {sending && !streamReply && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              成员正在回复…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 对话输入：默认 leader 接话，@ 可点名任意成员 */}
      <div className="shrink-0 border-t border-black/[0.06] px-8 py-3">
        <div className="relative mx-auto max-w-[1000px]">
          {mentionOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[220px] overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
              {mentionCandidates.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => applyMention(a.name)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]"
                >
                  <AgentAvatar avatar={a.avatar} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[13px]" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {a.id === leaderId && (
                    <span className="shrink-0 rounded px-1 py-px text-[9px] font-bold" style={{ background: '#FFD23333', color: '#b8860b' }}>leader</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-black/[0.08] bg-white px-3.5 py-2.5">
            <AtSign
              className="mb-1 h-4 w-4 shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setDraft((prev) => `${prev}${prev.endsWith(' ') || prev === '' ? '' : ' '}@`);
                inputRef.current?.focus();
              }}
            />
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !mentionOpen) {
                  // 中文输入法组词中的 Enter 是选词，不发送（与 ChatInput 同款守卫）
                  const nativeEvent = e.nativeEvent as KeyboardEvent;
                  if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              disabled={sending}
              placeholder={`和 ${team.name} 聊聊…（默认 ${agentOf(team.leaderId)?.name ?? 'leader'} 接话，@ 可点名成员，派活会自动立项执行）`}
              className={cn(
                'max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none',
                'placeholder:text-muted-foreground/70 disabled:opacity-60',
              )}
            />
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || !draft.trim()}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
              style={{ background: 'var(--ac, #f5b400)', color: '#1A1C1E' }}
              aria-label="发送"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizonal className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TeamChatView;
