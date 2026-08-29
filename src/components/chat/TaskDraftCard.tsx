/**
 * src/components/chat/TaskDraftCard.tsx
 * 立项确认卡（Knowe 风格）：标题行（图标 +「派发任务」+ 剩余 mm:ss 倒计时）、
 * 说明文案、被指派人行（头像 + 名字 · 角色）、引用指令块（浅灰底）、
 * 按钮组「我有新意见 / 确认（深色主按钮）/ 拒绝」。
 *
 * 倒计时与终态只活在前端渲染层：按草稿事件 createdAt 计算 15 分钟窗口，
 * 超时未处置 →「已超时」终态（按钮不再可点）；确认/拒绝/被取代 → 对应终态文案。
 * 协议事件格式与解析不变（见 lib/team-task-chat.ts）。
 */
import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import {
  TASK_DRAFT_TIMEOUT_MS,
  formatDraftRemainingMs,
  getTaskDraftPhase,
  type TaskDraftAction,
  type TaskDraftCard as TaskDraftCardData,
} from '@/lib/team-task-chat';

export interface TaskDraftAssignee {
  name: string;
  avatar?: string | null;
  role?: string;
}

const TERMINAL_TEXT: Record<Exclude<TaskDraftAction | 'expired', never>, string> = {
  confirmed: '✅ 已确认，任务派发中',
  cancelled: '已拒绝，本次不派发',
  superseded: '已被新草稿取代',
  expired: '已超时，请重新发起',
};

export function TaskDraftCard({
  card,
  createdAt,
  assignee,
  action,
  busy = false,
  onConfirm,
  onReject,
  onRevise,
}: {
  card: TaskDraftCardData;
  /** 草稿事件 createdAt（ISO 串），倒计时基准 */
  createdAt?: string;
  assignee?: TaskDraftAssignee | null;
  /** 已落协议的处置结果；null = 待确认 */
  action: TaskDraftAction | null;
  busy?: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onRevise: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const phase = getTaskDraftPhase(action, createdAt, now);

  // 仅 pending 阶段每秒走秒更新倒计时；进入终态后停止计时
  useEffect(() => {
    if (phase !== 'pending') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  const remainingMs = Number.isFinite(createdMs)
    ? createdMs + TASK_DRAFT_TIMEOUT_MS - now
    : TASK_DRAFT_TIMEOUT_MS;

  return (
    <div className="rounded-2xl border border-black/[0.06] bg-white px-4 py-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          <ClipboardList className="h-3.5 w-3.5" style={{ color: '#b8860b' }} />
          派发任务
        </span>
        {phase === 'pending' && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            剩余 {formatDraftRemainingMs(remainingMs)}
          </span>
        )}
      </div>

      <p className="mt-2 text-[12px] text-muted-foreground">需要你确认后，任务才会派发给成员</p>
      <p className="mt-2 text-[13.5px] font-bold text-foreground">{card.title}</p>

      {assignee && (
        <div className="mt-2.5 flex items-center gap-2.5">
          <AgentAvatar
            avatar={assignee.avatar}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[15px]"
          />
          <span className="text-[12.5px] font-semibold text-foreground">{assignee.name}</span>
          {assignee.role && (
            <span className="text-[11.5px] text-muted-foreground">{assignee.role}</span>
          )}
        </div>
      )}

      <blockquote className="mt-2.5 whitespace-pre-wrap rounded-xl bg-black/[0.04] px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground/85">
        {card.requirement}
      </blockquote>

      {phase === 'pending' ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onRevise}
            className="rounded-lg bg-black/[0.05] px-3 py-1.5 text-[12px] font-semibold text-foreground/80 transition-colors hover:bg-black/[0.08] disabled:opacity-50"
          >
            我有新意见
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-[#1A1C1E] px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            确认
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="rounded-lg bg-black/[0.05] px-3 py-1.5 text-[12px] font-semibold text-foreground/80 transition-colors hover:bg-black/[0.08] disabled:opacity-50"
          >
            拒绝
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[11.5px] font-semibold text-muted-foreground">
          {TERMINAL_TEXT[phase]}
        </p>
      )}
    </div>
  );
}

export default TaskDraftCard;
