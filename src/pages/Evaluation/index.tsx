/**
 * src/pages/Evaluation/index.tsx
 * 评估中心主页面。
 *
 * 布局：
 * - 左栏：agent 列表（含评估状态）+ 触发评估 / 软退休 等动作。
 * - 右栏：六维雷达、ROI、生命周期治理、擂台排名四个子面板。
 *
 * 数据流（评估契约）：用户选定 agent（+ 可选 task / runId）→ 本地编排
 * store.runEvaluation（真实 KPI/ROI + MiniCPM-o 裁判）→ 落库 EvaluationProfile
 * 并将 runId↔task 关联写入。捕获 runId 的入口即在本页（来自
 * gateway.rpc('chat.send') 返回值，可由调用方注入）。
 *
 * i18n：用户可见文案走 common:evaluation.*（含面板标签 / 表单 / 空态）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Play, AlertTriangle, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from 'sonner';

import { useEvaluationStore } from '@/stores/evaluation';
import { useMetaJudgeStore } from '@/stores/metaJudgeStore';
import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import { getActiveBossProfile, listBossProfiles } from '@/stores/bossProfile';
import { listAgentSessions, type AgentSessionOption } from '@/services/evaluationData';
import { speech } from '@/services/speech';
import { useConvergenceStore } from '@/stores/convergenceStore';
import type { AgentSummary } from '@/types/agent';
import RadarChartView from './RadarChart';
import { RoiPanel } from './RoiPanel';
import { LifecyclePanel } from './LifecyclePanel';
import { Leaderboard } from './Leaderboard';
import { DualTrackScoreCard } from '@/components/evaluation/DualTrackScoreCard';
import { DualLeaderboard } from '@/components/evaluation/DualLeaderboard';
import { BossFavoriteLeaderboard } from '@/components/marketplace/BossFavoriteLeaderboard';
import { BossProfileSelector } from '@/components/persona/BossProfileSelector';
import { JudgeHealthPanel } from '@/components/evaluation/JudgeHealthPanel';
import { TraceBrowserPanel } from '@/components/evaluation/TraceBrowserPanel';
import { CapsuleBrowserPanel } from '@/components/evaluation/CapsuleBrowserPanel';
import { SuiteView } from '@/components/evaluation/SuiteView';
import { PreferenceInsightPanel } from '@/components/evaluation/PreferenceInsightPanel';
import { ConvergenceTrajectoryWidget } from '@/components/evaluation/ConvergenceTrajectoryWidget';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
import { StyleMemoryPanel } from '@/components/designer/StyleMemoryPanel';
import { useDesignerStore } from '@/stores/designerStore';
import { resolveDesignerTeamIdForAgent } from '@/services/designer/designer-scope';

/**
 * 页签从 9 个收拢成 4 组：原先「雷达/讲解/ROI/生命周期/擂台/双轨评分/双榜/收敛/心智模型」
 * 平铺，用户无从判断该看哪个。现在按「看结果 → 看排名 → 看偏好 → 管人员」的
 * 使用场景归组，同组内容纵向叠放。
 */
type PanelKey = 'result' | 'ranking' | 'preference' | 'manage' | 'challenge';

const PANELS: Array<{ key: PanelKey; label: string; hint: string }> = [
  { key: 'result', label: '这位员工怎么样', hint: '六维画像、投入产出、模型讲解' },
  { key: 'ranking', label: '谁更合适', hint: '客观榜与主观榜并排对比' },
  { key: 'preference', label: '我的偏好', hint: '你的打分习惯与收敛过程' },
  { key: 'manage', label: '人员状态', hint: '上岗、维护与软退休' },
  { key: 'challenge', label: 'Designer 记忆', hint: 'SPADE 自适应出题 · 语义记忆 · Prompt 进化' },
];

function LifecycleDot({ state }: { state: string }) {
  const color =
    state === 'RETIRED'
      ? 'bg-rose-500'
      : state === 'ACTIVE'
        ? 'bg-emerald-500'
        : state === 'TRAINING'
          ? 'bg-sky-500'
          : state === 'MAINTENANCE'
            ? 'bg-violet-500'
            : 'bg-amber-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

export function Evaluation() {
  const { t } = useTranslation('common');
  const agentsRaw = useAgentsStore((s) => s.agents);
  const agents = useMemo(() => (agentsRaw ?? []) as AgentSummary[], [agentsRaw]);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const teams = useTeamsStore((s) => s.teams);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);

  const {
    profiles,
    lifecycle,
    radarLatest,
    roiLatest,
    leaderboard,
    selectedAgentId,
    streaming,
    error,
    narrationText,
    voiceEnabled,
    passKResult,
    passKRunning,
    runPassK,
    loadAll,
    runEvaluation,
    registerAgentNames,
    setLifecycle,
    selectAgent,
    clearError,
    toggleVoice,
  } = useEvaluationStore();

  const [panel, setPanel] = useState<PanelKey>('result');
  // Deep-link：
  // - /evaluation?traceTaskId=<taskId> → trace 面板按任务过滤
  // - /evaluation?agentId=<agentId>&panel=challenge → 打开某个员工的 Designer 学习视图
  const [searchParams] = useSearchParams();
  const traceTaskId = searchParams.get('traceTaskId')?.trim() || undefined;
  const initialAgentId = searchParams.get('agentId')?.trim() || undefined;
  const requestedPanel = searchParams.get('panel')?.trim() || undefined;
  const recordReview = useMetaJudgeStore((s) => s.recordReview);
  const [runIdInput, setRunIdInput] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [sessionOptions, setSessionOptions] = useState<AgentSessionOption[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const narrationRef = useRef<HTMLDivElement>(null);

  // 讲解文本流式追加时自动滚到底部
  useEffect(() => {
    const el = narrationRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [narrationText]);

  useEffect(() => {
    void fetchAgents();
    void fetchTeams();
    void loadAll();
  }, [fetchAgents, fetchTeams, loadAll]);

  useEffect(() => {
    if (requestedPanel && PANELS.some((entry) => entry.key === requestedPanel)) {
      setPanel(requestedPanel as PanelKey);
    }
  }, [requestedPanel]);

  // 榜单显示人名而非 agentId：agent 列表就绪后把 id→name 注册进评估 store。
  // （画像里不存名字，因为名字属 agent 域且可被改名；这里做一次单向注入。）
  useEffect(() => {
    if (agents.length === 0) return;
    const names: Record<string, string> = {};
    for (const a of agents) {
      if (a.id && a.name) names[a.id] = a.name;
    }
    registerAgentNames(names);
  }, [agents, registerAgentNames]);

  // 离开评估页时停止播报
  useEffect(() => {
    return () => {
      speech.cancel();
    };
  }, []);

  useEffect(() => {
    if (!initialAgentId) return;
    if (selectedAgentId === initialAgentId) return;
    if (!agents.some((agent) => agent.id === initialAgentId)) return;
    selectAgent(initialAgentId);
  }, [initialAgentId, selectedAgentId, agents, selectAgent]);

  // 选中 agent 变化时加载其真实会话列表，并重置会话选择
  useEffect(() => {
    setSelectedSessionId('');
    setSessionOptions([]);
    if (!selectedAgentId) return;
    let cancelled = false;
    listAgentSessions(selectedAgentId)
      .then((options) => {
        if (!cancelled) setSessionOptions(options);
      })
      .catch(() => {
        if (!cancelled) setSessionOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId]);

  // 收敛面板数据：按当前 trace 与评分展示，无数据时显示空态
  const convergenceTrace = useConvergenceStore((s) => s.trace);
  const convergenceScore = useConvergenceStore((s) => s.score);

  // Designer 记忆：选中 agent 时同步 teamId 并加载 StyleMemory
  const designerTeamId = useDesignerStore((s) => s.teamId);
  const designerFetchMemory = useDesignerStore((s) => s.fetchMemory);
  const designerReflect = useDesignerStore((s) => s.reflect);
  const designerSelectTeam = useDesignerStore((s) => s.selectTeam);
  const designerReset = useDesignerStore((s) => s.reset);
  // SPADE 闭环（A1）：Designer 出的自适应题。存在时作为本次评估的任务喂给
  // runEvaluation——否则 Designer 出题只在 StyleMemoryPanel 展示、从不被执行。
  const currentChallenge = useDesignerStore((s) => s.currentChallenge);

  const selectedDesignerTeamId = useMemo(
    () =>
      selectedAgentId
        ? resolveDesignerTeamIdForAgent(selectedAgentId, teams)
        : null,
    [selectedAgentId, teams],
  );

  // Designer 记忆：选中 agent 时同步到其所属团队（无团队时回退 agentId）并加载 StyleMemory
  useEffect(() => {
    if (!selectedDesignerTeamId) {
      designerReset();
      return;
    }
    if (designerTeamId !== selectedDesignerTeamId) {
      designerSelectTeam(selectedDesignerTeamId);
    }
    void designerFetchMemory(selectedDesignerTeamId);
  }, [
    selectedDesignerTeamId,
    designerTeamId,
    designerFetchMemory,
    designerReset,
    designerSelectTeam,
  ]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  /** 当前选中 agent 的评估档案（含面试基线 interviewBaseline） */
  const selectedProfile = selectedAgentId ? (profiles[selectedAgentId] ?? null) : null;

  /**
   * 人工抽检：把「我认不认可这个结论」记成元评估样本。
   * gold 只能由人给 —— 让模型为模型的结论背书会陷入无穷回归。
   * 仅在结论确实来自裁判（judge/mixed）时可用：给离线回退分做抽检没有意义。
   */
  const handleReview = useCallback(
    (agreed: boolean) => {
      if (!selectedAgentId || !selectedProfile) return;
      const verdict = selectedProfile.lifecycle === 'RETIRED' ? 'FIRED' : undefined;
      const stages = selectedProfile.stageScores ?? [];
      const lastVerdict =
        verdict ?? stages[stages.length - 1]?.verdict ??
        ((selectedProfile.userFitLatest ?? 0) >= 80
          ? 'MVP'
          : (selectedProfile.userFitLatest ?? 0) >= 50
            ? 'OBSERVE'
            : 'FIRED');
      recordReview({
        agentId: selectedAgentId,
        verdict: lastVerdict,
        confidence: passKResult?.passRate ?? null,
        // 裁判思维链：来自最近一次 pass^k 的 judgeChat 采样（后端 /api/chat-judge 透传）。
        // 供 metaJudge 做「推理-结论一致性」审计；未跑过 pass^k 或裁判未启用思考模式时为 undefined。
        reasoning: passKResult?.reasoning ?? undefined,
        agreed,
        dim: selectedProfile.jobType ?? null,
      });
      toast.success(agreed ? '已记录：认可该结论' : '已记录：不认可该结论');
    },
    [selectedAgentId, selectedProfile, recordReview, passKResult],
  );
  // B · 状态化多轮：当前激活老板原型下、带完整 transcript 的历史会话数（≥2 才够跨会话测）
  const activeBossId = getActiveBossProfile()?.id ?? 'neutral';
  const sessionTranscriptCount = (
    selectedProfile?.sessionsByPersona?.[activeBossId] ?? []
  ).filter((s) => typeof s.transcript === 'string' && s.transcript.length > 0).length;

  const handleRun = async (agent: AgentSummary) => {
    // 会话下拉框属于当前选中的 agent；对未选中的 agent 点「运行评估」时
    // selectAgent 会异步重置选择，这里必须忽略残留的跨 agent 会话，
    // 否则会把 A 的 sessionId 写进 B 的评估与 runlink。
    const session =
      agent.id === selectedAgentId
        ? (sessionOptions.find((s) => s.sessionId === selectedSessionId) ?? null)
        : null;
    selectAgent(agent.id);
    const evaluation = await runEvaluation({
      runId: runIdInput.trim() || null,
      agentId: agent.id,
      agentName: agent.name,
      sessionKey: session?.sessionKey ?? '',
      sessionId: session?.sessionId ?? '',
      taskId: '',
      // SPADE 闭环（A1）：Designer 出自适应题时，用它作为本次评估任务（prompt 作
      // description 喂给裁判）；否则回退用户手输的 taskTitle。让「出题→执行」成环。
      task: currentChallenge?.prompt
        ? {
            title: currentChallenge.title,
            description: currentChallenge.prompt,
            weight: 1,
          }
        : taskTitle.trim()
          ? { title: taskTitle.trim(), description: '', weight: 1 }
          : undefined,
      persona: agent.persona,
      // A · 老板原型：把当前激活的用户个性化画像带入评估（区别于 agent 自身 persona）
      bossProfile: getActiveBossProfile(),
    });

    // 评估完成后异步触发 Designer 反思——不阻塞评估主流程
    // Reflector 会观察代码风格、更新 StyleMemory、定期进化 prompt。
    // 记忆单元优先使用 agent 所属团队，兑现 team-style learning；无团队时回退 agentId。
    if (evaluation?.profile && agent.id) {
      const profile = evaluation.profile;
      const radarScores: Record<string, number> = profile.radarLatest
        ? { ...profile.radarLatest }
        : {};
      const outcome = profile.lifecycle === 'RETIRED' ? 'failed' : 'passed';
      const designerOwnerId = resolveDesignerTeamIdForAgent(agent.id, teams);
      // SPADE 闭环（A2）：把本次评估采集到的真实 transcript 直接从 runEvaluation
      // 返回值拿出来喂给 Reflector，避免页面闭包继续引用上一轮 lastTranscript。
      // 封顶避免 transcript 过长撑爆 LLM 上下文。反思任务身份优先用 Designer 题的
      // task_id，对齐出题记录。
      const submissionAnswer = evaluation.transcript.slice(0, 4000);
      const reflectTaskId =
        currentChallenge?.task_id ?? taskTitle.trim() ?? 'adhoc_eval';
      void designerReflect(
        designerOwnerId,
        reflectTaskId,
        submissionAnswer,
        radarScores,
        outcome,
      );
    }
  };

  const selectedState = selectedAgentId ? (lifecycle[selectedAgentId] ?? 'ONBOARDING') : null;

  return (
    <div className="tech-bg flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-white/40 px-6 py-4">
        <div>
          <h1 className="text-lg font-extrabold text-[#1A1C1E] dark:text-white">
            {t('evaluation.title', '评估中心 · Evaluation')}
          </h1>
          <p className="text-[12px] text-gray-400">
            {t('evaluation.subtitle', '真实工作 + MiniCPM-o 外部裁判 · 本地数据 · 桌面端')}
          </p>
        </div>
        {error ? (
          <button
            type="button"
            onClick={clearError}
            className="flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1.5 text-[12px] font-bold text-rose-600"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：agent 列表 */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-r border-white/40 p-4">
          {/* A · 老板原型选择器：决定「与谁协作」的评估视角（个性化基线） */}
          <div className="mb-3">
            <BossProfileSelector />
          </div>

          <div className="mb-3 space-y-2 rounded-2xl bg-white/70 p-3 dark:bg-white/5">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
              {t('evaluation.sessionLabel', '评估会话（真实运行记录）')}
            </label>
            <select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
            >
              <option value="">{t('evaluation.sessionLocalOnly', '仅本地画像（不关联会话）')}</option>
              {sessionOptions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId.slice(0, 8)}…{s.updatedAt ? ` · ${s.updatedAt.slice(0, 10)}` : ''}
                </option>
              ))}
            </select>
            {selectedAgentId && sessionOptions.length === 0 ? (
              <p className="text-[11px] text-gray-400">
                {t('evaluation.noSessions', '该 agent 暂无运行记录。')}
              </p>
            ) : null}
            {/* runId / 任务标题是排查用的技术字段，默认折叠，避免和主流程抢注意力 */}
            <details className="group">
              <summary className="cursor-pointer list-none text-[11px] font-bold text-gray-400 hover:text-[#1A1C1E] dark:hover:text-white">
                {t('evaluation.advancedToggle', '高级选项（可选）')}
              </summary>
              <div className="mt-2 space-y-2">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                  {t('evaluation.runIdLabel', 'runId（可选，来自 chat.send）')}
                </label>
                <input
                  value={runIdInput}
                  onChange={(e) => setRunIdInput(e.target.value)}
                  placeholder={t('evaluation.runIdPlaceholder', 'run_xxx（缺省不写 runlink）')}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
                />
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                  {t('evaluation.taskTitleLabel', '任务标题（可选）')}
                </label>
                <input
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder={t('evaluation.taskTitlePlaceholder', '评估关联的任务')}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[12px] outline-none focus:border-[#FFD233] dark:bg-white/10"
                />
              </div>
            </details>
          </div>

          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="px-2 py-4 text-sm text-gray-400">
                {t('evaluation.noAgents', '还没有员工可评估，先去人才市场雇一位。')}
              </p>
            ) : (
              agents.map((agent) => {
                const st = lifecycle[agent.id] ?? 'ONBOARDING';
                const evaluated = Boolean(profiles[agent.id]);
                const active = agent.id === selectedAgentId;
                return (
                  <div
                    key={agent.id}
                    className={`rounded-2xl border p-3 transition-all ${
                      active
                        ? 'border-[#FFD233] bg-[#FFD233]/10'
                        : 'border-white/40 bg-white/70 hover:bg-white dark:bg-white/5'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectAgent(agent.id)}
                      className="flex w-full items-center gap-2 text-left"
                    >
                      <LifecycleDot state={st} />
                      <span className="flex-1 truncate text-[13px] font-bold text-[#1A1C1E] dark:text-white">
                        {agent.name}
                      </span>
                      {profiles[agent.id]?.interviewBaseline ? (
                        <span
                          className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-600"
                          title={t('evaluation.baselineTitle', '已有面试基线（S2 → S3 贯通）')}
                        >
                          {t('evaluation.baselineBadge', '基线')}
                        </span>
                      ) : null}
                      {evaluated ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                          {t('evaluation.evaluated', '已评估')}
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-400">
                          {t('evaluation.notEvaluated', '未评估')}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={streaming}
                      onClick={() => void handleRun(agent)}
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-[#1A1C1E] px-3 py-2 text-[12px] font-bold text-white shadow-sm transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
                    >
                      {streaming && selectedAgentId === agent.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {t('evaluation.runEvaluation', '运行评估')}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* 右栏：子面板 */}
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-white/40 px-6 py-3">
            <div className="flex flex-wrap gap-1.5">
              {PANELS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPanel(p.key)}
                  title={p.hint}
                  className={`rounded-full px-4 py-1.5 text-[12px] font-bold transition-all ${
                    panel === p.key
                      ? 'bg-[#FFD233] text-[#1A1C1E]'
                      : 'text-gray-400 hover:bg-white hover:text-[#1A1C1E] dark:hover:bg-white/10'
                  }`}
                >
                  {t(`evaluation.panels.${p.key}`, p.label)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              {PANELS.find((p) => p.key === panel)?.hint}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {panel === 'result' ? (
              <div className="space-y-6">
                {/* 面试基线叠加（interviewBaseline.radar，无则不传，baseline prop 已存在） */}
                <RadarChartView
                  score={radarLatest}
                  baseline={selectedProfile?.interviewBaseline?.radar ?? null}
                  height={320}
                />
                {selectedProfile?.interviewBaseline?.radar ? (
                  <p className="text-[12px] text-gray-400">
                    {t('evaluation.radarBaselineHint', '灰色多边形 = 面试基线（S2），黄色 = 当前绩效（S3）。')}
                  </p>
                ) : null}
                {selectedAgent ? (
                  <p className="text-[12px] text-gray-400">
                    {t('evaluation.radarSelectedPre', '当前选中：')}
                    <span className="font-bold text-[#1A1C1E] dark:text-white">{selectedAgent.name}</span>
                    {t('evaluation.radarSelectedPost', {
                      id: selectedAgent.id,
                      defaultValue: '（{{id}}）— 点击「运行评估」以刷新六维评分。',
                    })}
                  </p>
                ) : (
                  <p className="text-[12px] text-gray-400">
                    {t('evaluation.radarSelectHint', '从左侧选择一位员工，再点「运行评估」查看结果。')}
                  </p>
                )}

                {/* E · 评估机制透明披露：明示本次分数基于哪个 persona / 哪段历史 / 哪个裁判 / k=几 */}
                {(selectedProfile?.lastPersonaId || selectedProfile?.judgeSource) ? (
                  (() => {
                    const evalPersonaId = selectedProfile?.lastPersonaId ?? 'neutral';
                    const evalPersona =
                      listBossProfiles().find((p) => p.id === evalPersonaId);
                    const evalPersonaName =
                      evalPersona?.name ??
                      (evalPersonaId === 'neutral' ? '中性（无个性化）' : evalPersonaId);
                    const historySessions =
                      selectedProfile?.sessionsByPersona?.[evalPersonaId]?.length ?? 0;
                    const judgeLabel =
                      selectedProfile?.judgeSource === 'degraded'
                        ? '离线启发式回退'
                        : selectedProfile?.judgeSource === 'mixed'
                          ? 'MiniCPM-o 裁判（部分维度回退）'
                          : selectedProfile?.judgeSource === 'judge'
                            ? 'MiniCPM-o 外部裁判'
                            : '未知';
                    return (
                      <div className="space-y-2 rounded-2xl border border-white/40 bg-white/60 p-4 text-[11px] dark:bg-white/5">
                        <p className="font-bold text-[#1A1C1E] dark:text-white">
                          评估机制 · 透明披露
                        </p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-500">
                          <span>
                            老板原型：
                            <b className="text-[#1A1C1E] dark:text-white">{evalPersonaName}</b>
                          </span>
                          <span>
                            历史会话（历史协作）：
                            <b className="text-[#1A1C1E] dark:text-white">{historySessions} 段</b>
                          </span>
                          <span>
                            裁判：
                            <b className="text-[#1A1C1E] dark:text-white">{judgeLabel}</b>
                          </span>
                          {passKResult ? (
                            <span>
                              可靠性 k=
                              <b className="text-[#1A1C1E] dark:text-white">{passKResult.k}</b>
                            </span>
                          ) : null}
                        </div>
                        <p className="text-gray-400">
                          同一 agent 对不同老板、不同历史、不同裁判，分数会不同——这是个性化评估的应有之义（Wang 透明披露主张）。
                        </p>

                        {/* 人工抽检：元评估唯一合法的 gold 来源。
                            用模型给模型的结论做 gold 会陷入无穷回归，因此这一票必须由人投。 */}
                        {selectedProfile?.judgeSource === 'judge' ||
                        selectedProfile?.judgeSource === 'mixed' ? (
                          <div className="flex flex-wrap items-center gap-2 border-t border-white/40 pt-2">
                            <span className="text-gray-500">这个结论你认可吗？</span>
                            <button
                              type="button"
                              onClick={() => handleReview(true)}
                              className="rounded-full bg-emerald-500/15 px-3 py-1 font-bold text-emerald-700 transition-colors hover:bg-emerald-500/25"
                            >
                              认可
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReview(false)}
                              className="rounded-full bg-rose-500/15 px-3 py-1 font-bold text-rose-600 transition-colors hover:bg-rose-500/25"
                            >
                              不认可
                            </button>
                            <span className="text-gray-400">
                              抽检结果进入「裁判健康度」，用于监管裁判本身
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })()
                ) : null}

                {/* 裁判元评估：谁来监管裁判 */}
                <JudgeHealthPanel />

                {/* 协作 trace 回放：把已落盘的委派链路变成可回看的视图；
                    看板「查看协作轨迹」入口带 traceTaskId 跳来时按任务过滤 */}
                <TraceBrowserPanel taskId={traceTaskId} />

                {/* 经验胶囊：真实交付回流沉淀的可复用资产 */}
                <CapsuleBrowserPanel />

                {/* C · 基准套件：维度×原型矩阵 + 个性化增量（人格化评估的核心视图） */}
                <SuiteView
                  agentId={selectedAgentId}
                  radarByPersona={selectedProfile?.radarByPersona}
                  profiles={listBossProfiles()}
                  risk={selectedProfile?.personalizationRisk}
                />

                {/* 双轨评分卡（客观遥测 + 主观打分 + 0.7/0.3 加权 total） */}
                <DualTrackScoreCard agentId={selectedAgentId} />

                {/* 可靠性 pass^k（跨家族 ensemble + 重复采样；核心差异化指标） */}
                <div className="space-y-3 rounded-2xl bg-white/70 p-4 dark:bg-white/5">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] font-bold text-[#1A1C1E] dark:text-white">
                      可靠性 pass^k
                    </p>
                    <button
                      type="button"
                      disabled={passKRunning || !selectedAgentId}
                      onClick={() => selectedAgentId && void runPassK(selectedAgentId, 3)}
                      className="rounded-full bg-[#1A1C1E] px-3 py-1.5 text-[11px] font-bold text-white transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
                    >
                      {passKRunning ? '测算中…' : '测可靠性 (pass^k)'}
                    </button>
                    {/* B · 跨会话测（历史协作）：同一原型下多段历史会话各判一次，全过才算可靠 */}
                    <button
                      type="button"
                      disabled={passKRunning || !selectedAgentId || sessionTranscriptCount < 2}
                      onClick={() =>
                        selectedAgentId && void runPassK(selectedAgentId, 3, { useSessions: true })
                      }
                      title={
                        sessionTranscriptCount < 2
                          ? '需在同一老板原型下运行 ≥2 次评估（累积历史会话）后方可跨会话测'
                          : '同一原型下多段会话各判一次，全部全维达标才算可靠'
                      }
                      className="rounded-full border border-[#1A1C1E]/20 px-3 py-1.5 text-[11px] font-bold text-[#1A1C1E] transition-all hover:border-[#FF6B4A] hover:text-[#FF6B4A] disabled:opacity-40 dark:border-white/20 dark:text-white"
                    >
                      跨会话测 ({sessionTranscriptCount})
                    </button>
                  </div>
                  {passKResult ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            passKResult.allPass
                              ? 'bg-emerald-100 text-emerald-600'
                              : 'bg-amber-100 text-amber-600'
                          }`}
                        >
                          {passKResult.allPass ? '可靠（k 次全过）' : '不稳定（未全过）'}
                        </span>
                        <span className="text-[11px] text-gray-400">
                          单轮全维通过率 {Math.round(passKResult.passRate * 100)}% · k=
                          {passKResult.k}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {RADAR_DIMS.map((dim) => {
                          const rate = passKResult.dimPassRate[dim] ?? 0;
                          return (
                            <div key={dim} className="flex items-center gap-2">
                              <span className="w-10 text-[10px] text-gray-400">
                                {RADAR_DIM_LABELS[dim]}
                              </span>
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
                                <div
                                  className="h-full rounded-full bg-[#FFD233]"
                                  style={{ width: `${Math.round(rate * 100)}%` }}
                                />
                              </div>
                              <span className="w-9 text-right text-[10px] text-gray-400">
                                {Math.round(rate * 100)}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-gray-400">
                      对同一条对话重复裁判 k=3 次，仅当每次都全维达标才算「可靠」。需先运行一次评估，再点此测算（依赖联网裁判服务）。
                    </p>
                  )}
                </div>

                {/* 投入产出 */}
                <RoiPanel roi={roiLatest} />

                {/* 模型讲解 */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] text-gray-400">
                      {t('evaluation.narrationStatus', {
                        state: voiceEnabled
                          ? t('evaluation.voiceStateOn', '语音播报开')
                          : t('evaluation.voiceStateOff', '语音播报关'),
                        defaultValue: '模型讲解（{{state}}）',
                      })}
                    </p>
                    <button
                      type="button"
                      onClick={toggleVoice}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold transition-all ${
                        voiceEnabled
                          ? 'bg-[#FFD233] text-[#1A1C1E]'
                          : 'bg-gray-100 text-gray-400 dark:bg-white/10'
                      }`}
                    >
                      {voiceEnabled ? (
                        <Volume2 className="h-3.5 w-3.5" />
                      ) : (
                        <VolumeX className="h-3.5 w-3.5" />
                      )}
                      {voiceEnabled
                        ? t('evaluation.voiceOn', '语音开')
                        : t('evaluation.voiceOff', '语音关')}
                    </button>
                  </div>
                  <div
                    ref={narrationRef}
                    className="h-[360px] overflow-y-auto rounded-2xl bg-white/70 p-4 text-[13px] leading-6 text-[#1A1C1E] dark:bg-white/5 dark:text-white"
                  >
                    {narrationText ? (
                      narrationText
                    ) : (
                      <span className="text-gray-400">
                        {t('evaluation.narrationEmpty', '点击「运行评估」后，模型讲解将在此逐句滚动并语音播报。')}
                      </span>
                    )}
                    {streaming ? (
                      <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400" />
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {/* 双榜：客观榜 + 可拖拽主观榜（拖拽即偏好回灌）+ 擂台名次 */}
            {/* 最受 boss 青睐榜从人才市集迁入：它是测评结果而非选人筛选条件 */}
            {panel === 'ranking' ? (
              <div className="space-y-6">
                <DualLeaderboard
                  stage="performance"
                  jobType={selectedProfile?.jobType ?? 'all'}
                />
                <Leaderboard
                  entries={leaderboard}
                  selectedAgentId={selectedAgentId}
                  onSelect={(id) => selectAgent(id)}
                />
                <BossFavoriteLeaderboard />
              </div>
            ) : null}

            {/* 用户心智模型（userWeight vs 基准 + dimLift）+ 收敛轨迹 */}
            {panel === 'preference' ? (
              <div className="space-y-6">
                <PreferenceInsightPanel />
                <ConvergenceTrajectoryWidget
                  trace={convergenceTrace}
                  score={convergenceScore}
                />
              </div>
            ) : null}

            {panel === 'manage' ? (
              <LifecyclePanel
                agentId={selectedAgentId}
                state={selectedState}
                busy={streaming}
                onSoftRetire={(id) => void setLifecycle(id, 'RETIRED')}
                onReactivate={(id) => void setLifecycle(id, 'ACTIVE')}
              />
            ) : null}

            {/* Designer 记忆：StyleMemory 语义记忆 + PromptEvolver 进化指标 + 自适应出题 */}
            {panel === 'challenge' ? (
              <StyleMemoryPanel />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Evaluation;
