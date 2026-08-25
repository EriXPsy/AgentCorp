import { useEffect, useState, useMemo, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  MoreHorizontal,
  Users,
  Download,
  Plus,
  Trash2,
  FileText,
  Settings2,
  Send,
  Bot,
  MessageSquare,
  Brain,
  X,
} from 'lucide-react';
import { useTeamsStore } from '@/stores/teams';
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useChatStore } from '@/stores/chat';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { AgentLifecycleStatus, AgentSummary } from '@/types/agent';
import type { TeamSummary } from '@/types/team';

type AssetType = 'team' | 'employee';

interface HumanAsset {
  id: string;
  type: AssetType;
  // Common fields
  name: string;
  avatar?: string;
  initials: string;
  lifecycleStatus: AgentLifecycleStatus;
  healthScore: number; // 0-100
  taskCount: number;
  source: 'marketplace' | 'local' | 'custom';
  // Team-specific
  team?: TeamSummary;
  memberCount?: number;
  leaderName?: string;
  // Employee-specific
  agent?: AgentSummary;
}

// ── Status helpers ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  AgentLifecycleStatus,
  { dot: string; text: string; label: string }
> = {
  active: { dot: 'bg-green-500', text: 'text-green-600', label: 'active' },
  training: { dot: 'bg-blue-500', text: 'text-blue-600', label: 'training' },
  maintenance: { dot: 'bg-yellow-500', text: 'text-yellow-600', label: 'maintenance' },
  onboarding: { dot: 'bg-gray-400', text: 'text-gray-500', label: 'onboarding' },
  retired: { dot: 'bg-gray-800', text: 'text-gray-800', label: 'retired' },
};

function StatusBadge({ status }: { status: AgentLifecycleStatus }) {
  const { t } = useTranslation('common');
  const cfg = STATUS_CONFIG[status];
  return (
    <div className="flex items-center gap-2">
      <span className={cn('h-2 w-2 rounded-full', cfg.dot)} />
      <span className={cn('text-sm font-medium', cfg.text)}>
        {t(`teamOverview.humanAssets.status${cfg.label.charAt(0).toUpperCase() + cfg.label.slice(1)}` as 'teamOverview.humanAssets.statusActive')}
      </span>
    </div>
  );
}

// ── Avatar helpers ───────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-600',
  'bg-amber-100 text-amber-600',
  'bg-emerald-100 text-emerald-600',
  'bg-violet-100 text-violet-600',
  'bg-pink-100 text-pink-600',
  'bg-cyan-100 text-cyan-600',
];

function getAvatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ── Health bar ────────────────────────────────────────────────────────────────

function HealthBar({ score }: { score: number }) {
  const color =
    score >= 70 ? 'bg-green-500' : score >= 40 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-24 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs font-medium text-gray-500 w-8">{score}%</span>
    </div>
  );
}

// ── Health score ─────────────────────────────────────────────────────────────

function computeHealthScore(lifecycle: AgentLifecycleStatus, sessionCount: number): number {
  if (sessionCount > 0) {
    // Active workers get 70-95 based on how busy they are
    const busyness = Math.min(sessionCount / 20, 1); // normalized 0-1
    return Math.round(70 + busyness * 25);
  }
  switch (lifecycle) {
    case 'active': return 85;
    case 'training': return 60;
    case 'maintenance': return 40;
    case 'onboarding': return 50;
    case 'retired': return 10;
    default: return 30;
  }
}

// ── Source badge ─────────────────────────────────────────────────────────────

const SOURCE_CONFIG = {
  marketplace: {
    bg: 'bg-violet-50',
    text: 'text-violet-600',
    dot: 'bg-violet-400',
    labelKey: 'sourceMarketplace',
  },
  local: {
    bg: 'bg-cyan-50',
    text: 'text-cyan-600',
    dot: 'bg-cyan-400',
    labelKey: 'sourceLocal',
  },
  custom: {
    bg: 'bg-amber-50',
    text: 'text-amber-600',
    dot: 'bg-amber-400',
    labelKey: 'sourceCustom',
  },
};

function SourceBadge({ source }: { source: 'marketplace' | 'local' | 'custom' }) {
  const { t } = useTranslation('common');
  const cfg = SOURCE_CONFIG[source];
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        cfg.bg,
        cfg.text,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dot)} />
      {t(`teamOverview.humanAssets.${cfg.labelKey}` as 'teamOverview.humanAssets.sourceMarketplace')}
    </div>
  );
}

// ── Action menu ──────────────────────────────────────────────────────────────

interface ActionMenuProps {
  asset: HumanAsset;
  onViewProfile: (asset: HumanAsset) => void;
  onConfig: (asset: HumanAsset) => void;
  onAssignTask: (asset: HumanAsset) => void;
  onEditMemory: (asset: HumanAsset) => void;
  onInitiateConversation: (asset: HumanAsset) => void;
  onDelete: (asset: HumanAsset) => void;
}

function ActionMenu({ asset, onViewProfile, onConfig, onAssignTask, onEditMemory, onInitiateConversation, onDelete }: ActionMenuProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const items = [
    {
      icon: MessageSquare,
      label: '发起对话',
      action: () => { onInitiateConversation(asset); setOpen(false); },
    },
    {
      icon: FileText,
      label: t('teamOverview.humanAssets.viewProfile'),
      action: () => { onViewProfile(asset); setOpen(false); },
    },
    {
      icon: Settings2,
      label: t('teamOverview.humanAssets.configEdit'),
      action: () => { onConfig(asset); setOpen(false); },
    },
    {
      icon: Send,
      label: t('teamOverview.humanAssets.assignTask'),
      action: () => { onAssignTask(asset); setOpen(false); },
    },
    {
      icon: Brain,
      label: '编辑记忆',
      action: () => { onEditMemory(asset); setOpen(false); },
    },
    {
      icon: Trash2,
      label:
        asset.type === 'team'
          ? t('teamOverview.card.confirmDelete')
          : t('teamOverview.humanAssets.deleteEmployee'),
      action: () => { onDelete(asset); setOpen(false); },
      danger: true,
    },
  ];

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1A1C1E] text-white transition-colors hover:bg-[#FF6B4A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD233]/40"
        aria-label="Actions"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {/* 不用 AnimatePresence 退出动画：framer-motion 12 + StrictMode 下退出
          完成回调可能不触发，元素停在 opacity 0 却不卸载，残留幽灵层吞掉点击。
          仅保留入场动画（mount 时播放），关闭即即时卸载。 */}
      {open && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-gray-100"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={item.action}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors',
                item.danger
                  ? 'text-red-500 hover:bg-red-50'
                  : 'text-gray-700 hover:bg-gray-50',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          ))}
        </motion.div>
      )}
    </div>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────────

function KPICard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-[32px] bg-white/50 border border-gray-100 backdrop-blur-md p-6 flex flex-col gap-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold uppercase tracking-[0.15em] text-gray-400">{label}</span>
        <div className="h-8 w-8 rounded-2xl bg-[#F2F0E9] flex items-center justify-center">
          <Icon className="h-4 w-4 text-gray-400" />
        </div>
      </div>
      <span className="text-3xl font-bold text-[#1A1C1E]">{value}</span>
      {sub && <span className="text-xs text-gray-400 mt-0.5">{sub}</span>}
    </div>
  );
}

// ── Table row ────────────────────────────────────────────────────────────────

interface TableRowProps {
  asset: HumanAsset;
  onViewProfile: (asset: HumanAsset) => void;
  onConfig: (asset: HumanAsset) => void;
  onAssignTask: (asset: HumanAsset) => void;
  onEditMemory: (asset: HumanAsset) => void;
  onInitiateConversation: (asset: HumanAsset) => void;
  onDelete: (asset: HumanAsset) => void;
  onClick: (asset: HumanAsset) => void;
}

const TableRow = memo(function TableRow({
  asset,
  onViewProfile,
  onConfig,
  onAssignTask,
  onEditMemory,
  onInitiateConversation,
  onDelete,
  onClick,
}: TableRowProps) {
  const colorClass = getAvatarColor(asset.id);
  const isTeam = asset.type === 'team';

  return (
    <tr
      className="group border-b border-gray-50 last:border-0 transition-colors hover:bg-[#F2F0E9]/30 cursor-pointer"
      onClick={() => onClick(asset)}
    >
      {/* 员工信息 */}
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            {asset.avatar ? (
              <img src={asset.avatar} alt={asset.name} className="object-cover" />
            ) : (
              <AvatarFallback className={cn('text-xs font-semibold', colorClass)}>
                {asset.initials}
              </AvatarFallback>
            )}
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1A1C1E] truncate">{asset.name}</p>
            <p className="text-xs text-gray-400 mt-0.5 truncate">
              {isTeam
                ? `${asset.memberCount} ${asset.memberCount! > 1 ? 'members' : 'member'}`
                : (asset.agent?.persona ?? asset.agent?.responsibility ?? '')}
            </p>
          </div>
        </div>
      </td>

      {/* 来源 */}
      <td className="px-6 py-4">
        <SourceBadge source={asset.source} />
      </td>

      {/* 生命周期 */}
      <td className="px-6 py-4">
        <StatusBadge status={asset.lifecycleStatus} />
      </td>

      {/* 健康度 */}
      <td className="px-6 py-4">
        <HealthBar score={asset.healthScore} />
      </td>

      {/* 产能 */}
      <td className="px-6 py-4">
        <span className="text-sm font-semibold text-[#1A1C1E]">{asset.taskCount}</span>
        <span className="text-xs text-gray-400 ml-1">tasks</span>
      </td>

      {/* 操作 */}
      <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
        <ActionMenu
          asset={asset}
          onViewProfile={onViewProfile}
          onConfig={onConfig}
          onAssignTask={onAssignTask}
          onEditMemory={onEditMemory}
          onInitiateConversation={onInitiateConversation}
          onDelete={onDelete}
        />
      </td>
    </tr>
  );
});

// ── Action Modals ────────────────────────────────────────────────────────────

type ActionModalMode = null | 'assign' | 'memory' | 'conversation';

interface ActionModalProps {
  asset: HumanAsset | null;
  mode: ActionModalMode;
  onClose: () => void;
  navigate: ReturnType<typeof useNavigate>;
  openDirectAgentSession: (agentId: string, options?: { teamId?: string; teamName?: string; isLeaderChat?: boolean }) => string;
}

function ActionModal({ asset, mode, onClose, navigate, openDirectAgentSession }: ActionModalProps) {
  const [taskContent, setTaskContent] = useState('');
  const [sending, setSending] = useState(false);
  const createTask = useApprovalsStore((s) => s.createTask);

  // Esc 关闭弹窗（与点遮罩 / X 等价，兜住点击热区异常的极端情况）。
  useEffect(() => {
    if (!asset || !mode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [asset, mode, onClose]);

  const handleAssignTask = async () => {
    if (!asset || !taskContent.trim()) return;
    setSending(true);
    try {
      // 走看板链路：创建 KanbanTask（团队任务带 teamId，AutoWorker 开启后自动接管）。
      // 后端落 status:'todo'，isTeamTask = Boolean(teamId)（electron/utils/task-config.ts）。
      const text = taskContent.trim();
      const title = (text.split('\n')[0] ?? text).slice(0, 50);
      if (asset.type === 'team') {
        if (!asset.team) {
          toast.error('无法确定目标团队');
          return;
        }
        await createTask({
          title,
          description: text,
          priority: 'medium',
          teamId: asset.team.id,
          teamName: asset.team.name,
        });
      } else {
        // For employees use agent.id as assignee
        const agentId = asset.agent?.id;
        if (!agentId) {
          toast.error('无法确定目标 Agent');
          return;
        }
        await createTask({
          title,
          description: text,
          priority: 'medium',
          assigneeId: agentId,
          assigneeRole: asset.agent?.persona ?? asset.agent?.responsibility,
        });
      }
      toast.success(`已向「${asset.name}」下达任务`);
      setTaskContent('');
      onClose();
    } catch (err) {
      toast.error(`下达任务失败: ${String(err)}`);
    } finally {
      setSending(false);
    }
  };

  const handleInitiateConversation = () => {
    if (!asset) return;
    const agentId = asset.type === 'team' ? asset.team?.leaderId : asset.agent?.id;
    if (!agentId) return;
    onClose();
    // openDirectAgentSession 在 agent 缺失 / leader-only 受限时会抛错，
    // 兜住并提示，且无论如何都完成跳转，绝不让弹窗卡在半关状态。
    try {
      openDirectAgentSession(agentId, {
        teamId: asset.type === 'team' ? asset.team?.id : undefined,
        teamName: asset.type === 'team' ? asset.team?.name : undefined,
        isLeaderChat: asset.type === 'team',
      });
    } catch (err) {
      toast.error(`发起对话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    navigate('/');
  };

  return (
    // 不用 AnimatePresence 退出动画：framer-motion 12 + StrictMode 下退出完成
    // 回调可能不触发，元素停在 opacity 0 却不卸载，残留的隐形全屏遮罩会吞掉
    // 页面上所有点击（本次「卡死」的根因）。仅保留入场动画，关闭即即时卸载。
    asset && mode && (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12 }}
          onClick={onClose}
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, x: '-50%', y: '-45%' }}
          animate={{ opacity: 1, scale: 1, x: '-50%', y: '-50%' }}
          transition={{ duration: 0.12 }}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md rounded-[32px] bg-white p-8 shadow-2xl"
        >
            {/* Header */}
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-[14px]',
                  mode === 'assign' ? 'bg-[#FF6B4A]/10' :
                  mode === 'memory' ? 'bg-[#FFD233]/10' :
                  'bg-[#10B981]/10',
                )}>
                  {mode === 'assign' ? <Send className="h-5 w-5 text-[#FF6B4A]" /> :
                   mode === 'memory' ? <Brain className="h-5 w-5 text-[#FFD233]" /> :
                   <MessageSquare className="h-5 w-5 text-[#10B981]" />}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-[#1A1C1E]">
                    {mode === 'assign' ? '下达任务' :
                     mode === 'memory' ? '编辑记忆' :
                     '发起对话'}
                  </h3>
                  <p className="text-sm text-gray-400">{asset.name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Assign Task */}
            {mode === 'assign' && (
              <div className="space-y-4">
                <textarea
                  value={taskContent}
                  onChange={(e) => setTaskContent(e.target.value)}
                  placeholder="描述要完成的任务..."
                  rows={5}
                  className="w-full resize-none rounded-2xl border border-gray-100 bg-[#F2F0E9] px-5 py-3 text-sm font-medium text-[#1A1C1E] outline-none transition-all focus:border-[#FF6B4A] focus:ring-2 focus:ring-[#FF6B4A]/10"
                />
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex flex-1 items-center justify-center gap-2 rounded-full border border-gray-200 py-3 text-sm font-semibold text-gray-500 transition-colors hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleAssignTask}
                    disabled={sending || !taskContent.trim()}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold transition-all',
                      taskContent.trim() && !sending
                        ? 'bg-[#1A1C1E] text-white hover:bg-[#FF6B4A]'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed',
                    )}
                  >
                    {sending ? '下发中...' : '确认下发'}
                  </button>
                </div>
              </div>
            )}

            {/* Edit Memory */}
            {mode === 'memory' && (
              <div className="space-y-4">
                <p className="rounded-2xl bg-[#FFD233]/10 px-4 py-3 text-sm text-gray-600">
                  记忆编辑功能规划中。您可以通过对话方式让「{asset.name}」自行更新其人设和工作范围。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const agentId = asset.type === 'team' ? asset.team?.leaderId : asset.agent?.id;
                    if (agentId) {
                      onClose();
                      openDirectAgentSession(agentId, {
                        teamId: asset.type === 'team' ? asset.team?.id : undefined,
                        teamName: asset.type === 'team' ? asset.team?.name : undefined,
                        isLeaderChat: asset.type === 'team',
                      });
                      navigate('/');
                    }
                  }}
                  className="w-full items-center justify-center gap-2 rounded-full bg-[#FFD233] py-3 text-sm font-semibold text-[#1A1C1E] transition-colors hover:bg-[#FFD233]/90"
                >
                  <MessageSquare className="h-4 w-4" />
                  通过对话更新记忆
                </button>
              </div>
            )}

            {/* Initiate Conversation */}
            {mode === 'conversation' && (
              <div className="space-y-4">
                <p className="text-sm text-gray-500">
                  点击确认后，将切换到对话界面，直接与「{asset.name}
                  {asset.type === 'team' ? '（团队负责人）' : ''}」进行对话。
                </p>
                <button
                  type="button"
                  onClick={handleInitiateConversation}
                  className="w-full items-center justify-center gap-2 rounded-full bg-[#10B981] py-3 text-sm font-semibold text-white transition-colors hover:bg-[#10B981]/90"
                >
                  <MessageSquare className="h-4 w-4" />
                  开始对话
                </button>
              </div>
            )}
        </motion.div>
      </>
    )
  );
}

// ── Main component ────────────���──────────────────────────────────────────────

export function TeamOverview() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();

  const openDirectAgentSession = useChatStore((state) => state.openDirectAgentSession);
  const { teams, loading: teamsLoading, fetchTeams, deleteTeam } = useTeamsStore();
  const {
    agents,
    loading: agentsLoading,
    fetchAgents,
    agentLifecycleStatuses,
    agentSessionCounts,
    deleteAgent,
  } = useAgentsStore();

  // Action modal state
  const [actionModalAsset, setActionModalAsset] = useState<HumanAsset | null>(null);
  const [actionModalMode, setActionModalMode] = useState<ActionModalMode>(null);

  useEffect(() => {
    void fetchTeams();
    void fetchAgents();
  }, [fetchTeams, fetchAgents]);

  // ── Build unified asset list ───────────────────────────────────────────────

  const assets = useMemo<HumanAsset[]>(() => {
    const teamAgentIds = new Set<string>();
    for (const team of teams) {
      teamAgentIds.add(team.leaderId);
      for (const id of team.memberIds) {
        teamAgentIds.add(id);
      }
    }

    const rows: HumanAsset[] = [];

    // Teams as rows
    for (const team of teams) {
      const leaderAgent = agents.find((a) => a.id === team.leaderId);
      const lifecycle: AgentLifecycleStatus =
        (agentLifecycleStatuses[team.leaderId] as AgentLifecycleStatus) ?? 'onboarding';
      const sessionCount = agentSessionCounts[team.leaderId] ?? 0;
      const healthScore = computeHealthScore(lifecycle, sessionCount);

      rows.push({
        id: team.id,
        type: 'team',
        name: team.name,
        lifecycleStatus: lifecycle,
        healthScore,
        taskCount: team.activeTaskCount,
        source: leaderAgent?.source ?? 'local',
        team,
        memberCount: team.memberCount,
        leaderName: team.leaderName,
        initials: team.name.slice(0, 2).toUpperCase(),
        avatar: team.memberAvatars?.[0]?.avatar ?? undefined,
      });
    }

    // Unassigned agents as rows
    for (const agent of agents) {
      if (teamAgentIds.has(agent.id)) continue;
      const lifecycle: AgentLifecycleStatus =
        (agentLifecycleStatuses[agent.id] as AgentLifecycleStatus) ?? 'onboarding';
      const sessionCount = agentSessionCounts[agent.id] ?? 0;
      const healthScore = computeHealthScore(lifecycle, sessionCount);
      const initials = agent.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);

      rows.push({
        id: agent.id,
        type: 'employee',
        name: agent.name,
        avatar: agent.avatar ?? undefined,
        lifecycleStatus: lifecycle,
        healthScore,
        taskCount: sessionCount,
        source: agent.source ?? 'custom',
        agent,
        initials,
      });
    }

    // Sort: active first, then by lastActiveTime desc
    return rows.sort((a, b) => {
      const statusOrder: Record<AgentLifecycleStatus, number> = {
        active: 0,
        training: 1,
        onboarding: 2,
        maintenance: 3,
        retired: 4,
      };
      const aOrder = statusOrder[a.lifecycleStatus];
      const bOrder = statusOrder[b.lifecycleStatus];
      if (aOrder !== bOrder) return aOrder - bOrder;

      const aTime = a.team?.lastActiveTime ?? 0;
      const bTime = b.team?.lastActiveTime ?? 0;
      return bTime - aTime;
    });
  }, [teams, agents, agentLifecycleStatuses, agentSessionCounts]);

  // ── KPI data ──────────────────────────────────────────────────────────────

  const kpiData = useMemo(() => {
    const active = assets.filter((a) => a.lifecycleStatus === 'active').length;
    const totalTasks = assets.reduce((sum, a) => sum + a.taskCount, 0);
    const avgHealth =
      assets.length > 0
        ? Math.round(assets.reduce((sum, a) => sum + a.healthScore, 0) / assets.length)
        : 0;
    return { active, totalTasks, avgHealth };
  }, [assets]);

  // ── Button handlers ────────────────────────────────────────────────────────

  const handleLocalImport = async () => {
    try {
      const dir = (await window.electron.ipcRenderer.invoke('dialog:openDirectory')) as string | null;
      if (dir) {
        await (window.electron.ipcRenderer.invoke('workspace:import', dir) as Promise<void>);
        toast.success(t('teamOverview.humanAssets.localImport') + ' ' + t('actions.save'));
        void fetchAgents();
      }
    } catch (err) {
      toast.error(String(err));
    }
  };

  // ── Row action handlers ────────────────────────────────────────────────────

  const handleRowClick = (asset: HumanAsset) => {
    if (asset.type === 'team') {
      navigate(`/team-space/${asset.id}`);
    }
  };

  const handleViewProfile = (asset: HumanAsset) => {
    if (asset.type === 'team') {
      navigate(`/team-space/${asset.id}`);
    } else {
      navigate(`/agents/${asset.id}`);
    }
  };

  const handleConfig = (asset: HumanAsset) => {
    toast.info(`${t('teamOverview.humanAssets.configEdit')}: ${asset.name}`);
  };

  const handleAssignTask = (asset: HumanAsset) => {
    setActionModalAsset(asset);
    setActionModalMode('assign');
  };

  const handleEditMemory = (asset: HumanAsset) => {
    setActionModalAsset(asset);
    setActionModalMode('memory');
  };

  const handleInitiateConversation = (asset: HumanAsset) => {
    setActionModalAsset(asset);
    setActionModalMode('conversation');
  };

  const handleDelete = async (asset: HumanAsset) => {
    if (asset.type === 'team') {
      await deleteTeam(asset.id);
      void fetchTeams();
    } else {
      await deleteAgent(asset.id);
      void fetchAgents();
    }
  };

  const loading = teamsLoading || agentsLoading;

  return (
    <div className="flex h-full flex-col bg-[#F2F0E9]">
      {/* Header */}
      <div className="shrink-0 px-8 pt-8 pb-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-[#1A1C1E]">
              {t('teamOverview.humanAssets.title', { defaultValue: '人力资产' })}
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              {t('teamOverview.humanAssets.subtitle', {
                defaultValue: '管理您的数字员工团队及其全生命周期状态',
              })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleLocalImport}
              className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-[#1A1C1E] shadow-sm ring-1 ring-gray-200 transition-all hover:shadow-md hover:bg-gray-50"
            >
              <Download className="h-4 w-4" />
              {t('teamOverview.humanAssets.localImport', { defaultValue: '本地导入' })}
            </button>
            <button
              type="button"
              onClick={() => navigate('/employee-builder')}
              className="flex items-center gap-2 rounded-full bg-[#1A1C1E] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-[#FF6B4A] hover:shadow-md"
            >
              <Plus className="h-4 w-4" />
              {t('teamOverview.humanAssets.buildEmployee', { defaultValue: '自建员工' })}
            </button>
          </div>
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-3 gap-4">
          <KPICard
            label={t('teamOverview.humanAssets.activeWorkforce', { defaultValue: '在岗运力' })}
            value={String(kpiData.active)}
            sub={t('teamOverview.humanAssets.statusActive', { defaultValue: '服役中' })}
            icon={Bot}
          />
          <KPICard
            label={t('teamOverview.humanAssets.dailyWorkload', { defaultValue: '今日任务负载' })}
            value={String(kpiData.totalTasks)}
            sub={loading ? t('status.loading', { defaultValue: '加载中...' }) : `${assets.length} assets`}
            icon={Users}
          />
          <KPICard
            label={t('teamOverview.humanAssets.resourceConsumption', { defaultValue: '综合消耗评估' })}
            value={`${kpiData.avgHealth}%`}
            sub={t('teamOverview.humanAssets.activeWorkforce', { defaultValue: '健康度均值' })}
            icon={Bot}
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 px-8 pb-8 overflow-hidden">
        <div className="h-full rounded-[40px] bg-white shadow-sm ring-1 ring-gray-100 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-48 text-sm text-gray-400">
              {t('status.loading', { defaultValue: '加载中...' })}
            </div>
          ) : assets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="h-16 w-16 rounded-3xl bg-[#F2F0E9] flex items-center justify-center mb-5">
                <Users className="h-8 w-8 text-gray-300" />
              </div>
              <p className="text-lg font-semibold text-gray-500">
                {t('teamOverview.humanAssets.title', { defaultValue: '人力资产' })}
              </p>
              <p className="mt-2 text-sm text-gray-400 max-w-sm">
                {t('teamOverview.humanAssets.subtitle', { defaultValue: '暂无资产，点击上方按钮添加' })}
              </p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  {[
                    '员工信息',
                    '来源',
                    '生命周期',
                    '健康度',
                    '产能',
                    '',
                  ].map((header, i) => (
                    <th
                      key={i}
                      className={cn(
                        'px-6 py-4 text-left text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em]',
                        i === 0 && 'pl-8',
                        i === 5 && 'pr-8',
                      )}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <TableRow
                    key={asset.id}
                    asset={asset}
                    onViewProfile={handleViewProfile}
                    onConfig={handleConfig}
                    onAssignTask={handleAssignTask}
                    onEditMemory={handleEditMemory}
                    onInitiateConversation={handleInitiateConversation}
                    onDelete={handleDelete}
                    onClick={handleRowClick}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Action Modals */}
      <ActionModal
        asset={actionModalAsset}
        mode={actionModalMode}
        onClose={() => { setActionModalAsset(null); setActionModalMode(null); }}
        navigate={navigate}
        openDirectAgentSession={openDirectAgentSession}
      />
    </div>
  );
}

export default TeamOverview;
