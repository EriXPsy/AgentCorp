/**
 * TeamSpace — 完整的 Agent 团队展示空间
 *
 * 路由：/team-space/:teamId
 * 内容：团队概览 + 六维雷达 + 成员卡牌 + StyleMemory + 缺口分析
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  Brain,
  ChevronRight,
  Loader2,
  Network,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { useTeamsStore } from '@/stores/teams';
import { useAgentsStore } from '@/stores/agents';
import { useDesignerStore } from '@/stores/designerStore';
import { TeamRadar } from '@/components/team/TeamRadar';
import { cn } from '@/lib/utils';
import type { TeamRadarResponse } from '@/types/designer';
import type { AgentSummary } from '@/types/agent';
import type { TeamSummary } from '@/types/team';

const DIM_LABELS: Record<string, string> = {
  task_completion: '完成度',
  code_quality: '代码质量',
  communication: '沟通',
  creativity: '创造力',
  reliability: '可靠性',
  cost_efficiency: '成本效率',
  code_runnability: '可运行',
  code_efficiency: '效率',
  code_maintainability: '可维护',
  code_security: '安全',
};

function MemberCard({
  agent,
  radar,
  onClick,
}: {
  agent: AgentSummary;
  radar?: Record<string, number>;
  onClick: () => void;
}) {
  const topStrength = radar
    ? Object.entries(radar).sort(([, a], [, b]) => b - a)[0]
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-2xl border border-gray-100 bg-white/80 p-4 text-left transition-all hover:border-[#FFD233]/50 hover:shadow-md"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F2F0E9] text-sm font-bold text-[#1A1C1E]">
          {agent.name.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-[#1A1C1E]">{agent.name}</p>
          <p className="text-[10px] text-gray-400">{agent.modelDisplay ?? agent.responsibility ?? 'agent'}</p>
        </div>
        <ChevronRight size={14} className="text-gray-300 group-hover:text-[#FFD233]" />
      </div>

      {radar && Object.keys(radar).length > 0 ? (
        <div className="space-y-1.5">
          {Object.entries(radar)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([dim, score]) => (
              <div key={dim} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] text-gray-400">
                  {DIM_LABELS[dim] ?? dim}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-[#FFD233]"
                    style={{ width: `${(score / 5) * 100}%` }}
                  />
                </div>
                <span className="w-7 text-right text-[10px] font-bold text-[#1A1C1E]">
                  {score.toFixed(1)}
                </span>
              </div>
            ))}
        </div>
      ) : (
        <p className="text-[10px] text-gray-400">暂无评估数据</p>
      )}

      {topStrength && (
        <div className="mt-auto rounded-xl bg-[#F2F0E9] px-2.5 py-1.5">
          <span className="text-[10px] font-bold text-[#1A1C1E]">
            强项：{DIM_LABELS[topStrength[0]] ?? topStrength[0]}
          </span>
        </div>
      )}
    </button>
  );
}

export function TeamSpace() {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();

  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const teamRadars = useDesignerStore((s) => s.teamRadars);
  const teamGaps = useDesignerStore((s) => s.teamGaps);
  const fetchTeamRadar = useDesignerStore((s) => s.fetchTeamRadar);
  const fetchTeamGaps = useDesignerStore((s) => s.fetchTeamGaps);
  const fetchMemory = useDesignerStore((s) => s.fetchMemory);
  const memory = useDesignerStore((s) => s.memory);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void Promise.all([fetchTeams(), fetchAgents()]).then(() => setLoading(false));
  }, [fetchTeams, fetchAgents]);

  const team: TeamSummary | undefined = useMemo(
    () => teams.find((t) => t.id === teamId),
    [teams, teamId],
  );

  const teamAgents: AgentSummary[] = useMemo(() => {
    if (!team) return [];
    const memberIds = new Set([team.leaderId, ...team.memberIds]);
    return agents.filter((a) => memberIds.has(a.id));
  }, [team, agents]);

  const radar: TeamRadarResponse | null = teamId ? teamRadars[teamId] ?? null : null;
  const gaps = teamId ? teamGaps[teamId] ?? null : null;

  useEffect(() => {
    if (teamId) {
      void fetchTeamRadar(teamId);
      void fetchTeamGaps(teamId);
      void fetchMemory(teamId);
    }
  }, [teamId, fetchTeamRadar, fetchTeamGaps, fetchMemory]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Network className="h-12 w-12 text-gray-300" />
        <p className="text-lg font-bold text-gray-400">团队不存在</p>
        <button
          type="button"
          onClick={() => navigate('/team-overview')}
          className="rounded-full bg-[#1A1C1E] px-6 py-2.5 text-sm font-bold text-white hover:bg-[#FF6B4A]"
        >
          返回团队列表
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 md:p-8 xl:p-10">
      {/* ── 返回 + 标题 ── */}
      <div>
        <button
          type="button"
          onClick={() => navigate('/team-overview')}
          className="mb-4 flex items-center gap-1.5 text-[12px] font-bold text-gray-400 hover:text-[#1A1C1E]"
        >
          <ArrowLeft size={14} />
          返回团队列表
        </button>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#1A1C1E]">{team.name}</h1>
            {team.description && (
              <p className="mt-1 text-[13px] text-gray-500">{team.description}</p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => navigate(`/team-map/${team.id}`)}
              className="rounded-full border border-gray-200 px-4 py-2 text-[11px] font-bold text-gray-500 hover:border-[#FFD233] hover:text-[#1A1C1E]"
            >
              拓扑视图
            </button>
            <button
              type="button"
              onClick={() => navigate(`/team-builder?teamId=${team.id}`)}
              className="rounded-full bg-[#1A1C1E] px-4 py-2 text-[11px] font-bold text-white hover:bg-[#FF6B4A]"
            >
              编辑团队
            </button>
          </div>
        </div>
      </div>

      {/* ── 统计概览 ── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-4">
          <div className="flex items-center gap-2 text-gray-400">
            <Users size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">成员</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-[#1A1C1E]">{team.memberCount}</p>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-4">
          <div className="flex items-center gap-2 text-gray-400">
            <Target size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">任务</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-[#1A1C1E]">{team.activeTaskCount}</p>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-4">
          <div className="flex items-center gap-2 text-gray-400">
            <TrendingUp size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">提交次数</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-[#1A1C1E]">
            {radar?.last_updated_submission ?? 0}
          </p>
        </div>
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-4">
          <div className="flex items-center gap-2 text-gray-400">
            <Brain size={14} />
            <span className="text-[10px] font-bold uppercase tracking-wider">反思轮次</span>
          </div>
          <p className="mt-1 text-2xl font-bold text-[#1A1C1E]">
            {memory?.reflection_count ?? 0}
          </p>
        </div>
      </div>

      {/* ── 雷达 + 缺口 ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 六维雷达 */}
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-5">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold text-[#1A1C1E]">
            <Network size={14} />
            团队能力雷达
          </h2>
          {radar ? (
            <TeamRadar data={radar} />
          ) : (
            <div className="flex flex-col items-center gap-2 py-10">
              <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
              <span className="text-[10px] text-gray-400">加载雷达数据...</span>
            </div>
          )}
        </div>

        {/* 缺口分析 */}
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-5">
          <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold text-[#1A1C1E]">
            <AlertTriangle size={14} />
            团队缺口分析
          </h2>
          {gaps ? (
            <div className="space-y-4">
              <div className={cn(
                'rounded-xl px-4 py-3',
                gaps.hiring_urgency === 'high' ? 'bg-red-50' :
                gaps.hiring_urgency === 'medium' ? 'bg-yellow-50' : 'bg-green-50',
              )}>
                <div className="flex items-center gap-2">
                  {gaps.hiring_urgency === 'high' ? (
                    <AlertTriangle size={14} className="text-red-500" />
                  ) : gaps.hiring_urgency === 'medium' ? (
                    <AlertTriangle size={14} className="text-yellow-500" />
                  ) : (
                    <CheckCircle size={14} className="text-green-500" />
                  )}
                  <span className={cn(
                    'text-[12px] font-bold',
                    gaps.hiring_urgency === 'high' ? 'text-red-600' :
                    gaps.hiring_urgency === 'medium' ? 'text-yellow-600' : 'text-green-600',
                  )}>
                    {gaps.hiring_urgency === 'high' ? '急需补人' :
                     gaps.hiring_urgency === 'medium' ? '建议补人' : '能力均衡'}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-gray-600">
                  {gaps.hiring_reason}
                </p>
              </div>

              {gaps.gaps.length > 0 && (
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">能力缺口</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gaps.gaps.map((g) => (
                      <span key={g} className="rounded-full bg-red-50 px-2.5 py-1 text-[10px] font-bold text-red-600">
                        {DIM_LABELS[g] ?? g}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {gaps.team_strengths.length > 0 && (
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">团队强项</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gaps.team_strengths.map((s) => (
                      <span key={s} className="rounded-full bg-green-50 px-2.5 py-1 text-[10px] font-bold text-green-600">
                        {DIM_LABELS[s] ?? s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {gaps.recommended_skills.length > 0 && (
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">建议补充</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gaps.recommended_skills.map((s) => (
                      <span key={s} className="rounded-full bg-[#FFD233]/20 px-2.5 py-1 text-[10px] font-bold text-[#1A1C1E]">
                        {DIM_LABELS[s] ?? s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {gaps.hiring_urgency !== 'low' && (
                <button
                  type="button"
                  onClick={() => navigate('/marketplace')}
                  className="mt-2 w-full rounded-full bg-[#1A1C1E] py-2.5 text-[12px] font-bold text-white hover:bg-[#FF6B4A]"
                >
                  去市集招人
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10">
              <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
              <span className="text-[10px] text-gray-400">加载缺口分析...</span>
            </div>
          )}
        </div>
      </div>

      {/* ── StyleMemory 摘要 ── */}
      {memory && (memory.current_understanding || memory.next_challenge_hypothesis) && (
        <div className="rounded-2xl border border-gray-100 bg-white/80 p-5">
          <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#1A1C1E]">
            <Sparkles size={14} />
            Designer 观察
          </h2>
          {memory.current_understanding && (
            <div className="mb-3">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">当前理解</p>
              <p className="text-[12px] leading-relaxed text-gray-600">{memory.current_understanding}</p>
            </div>
          )}
          {memory.next_challenge_hypothesis && (
            <div>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">下一轮方向</p>
              <p className="text-[12px] leading-relaxed text-gray-600">{memory.next_challenge_hypothesis}</p>
            </div>
          )}
        </div>
      )}

      {/* ── 成员卡牌 ── */}
      <div>
        <h2 className="mb-4 flex items-center gap-2 text-[13px] font-bold text-[#1A1C1E]">
          <Bot size={14} />
          团队成员
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {teamAgents.map((agent) => (
            <MemberCard
              key={agent.id}
              agent={agent}
              radar={radar?.agent_scores[agent.id]}
              onClick={() => navigate(`/agents/${agent.id}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
