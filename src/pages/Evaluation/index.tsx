/**
 * src/pages/Evaluation/index.tsx
 * 评估中心主页面（T04 挂载点）。
 *
 * 布局：
 * - 左栏：agent 列表（含评估状态）+ 触发评估 / 软退休 等动作。
 * - 右栏：六维雷达、ROI、生命周期治理、擂台排名四个子面板。
 *
 * 数据流（评估契约）：用户选定 agent（+ 可选 task / runId）→ 本地编排
 * store.runEvaluation（真实 KPI/ROI + MiniCPM-o 裁判）→ 落库 EvaluationProfile
 * 并将 runId↔task 关联写入（T06）。捕获 runId 的入口即在本页（来自
 * gateway.rpc('chat.send') 返回值，可由调用方注入）。
 *
 * i18n：用户可见文案走 common:evaluation.*（含面板标签 / 表单 / 空态）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, AlertTriangle, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useEvaluationStore } from '@/stores/evaluation';
import { useAgentsStore } from '@/stores/agents';
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
import { PreferenceInsightPanel } from '@/components/evaluation/PreferenceInsightPanel';
import { ConvergenceTrajectoryWidget } from '@/components/evaluation/ConvergenceTrajectoryWidget';

type PanelKey =
  | 'radar'
  | 'narration'
  | 'roi'
  | 'lifecycle'
  | 'leaderboard'
  | 'dual'
  | 'dualBoard'
  | 'convergence'
  | 'preference';

const PANELS: Array<{ key: PanelKey; label: string }> = [
  { key: 'radar', label: '雷达' },
  { key: 'narration', label: '讲解' },
  { key: 'roi', label: 'ROI' },
  { key: 'lifecycle', label: '生命周期' },
  { key: 'leaderboard', label: '擂台' },
  { key: 'dual', label: '双轨评分' },
  { key: 'dualBoard', label: '双榜' },
  { key: 'convergence', label: '收敛' },
  { key: 'preference', label: '心智模型' },
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
  const agents = (agentsRaw ?? []) as AgentSummary[];
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

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
    loadAll,
    runEvaluation,
    setLifecycle,
    selectAgent,
    clearError,
    toggleVoice,
  } = useEvaluationStore();

  const [panel, setPanel] = useState<PanelKey>('radar');
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
    void loadAll();
  }, [fetchAgents, loadAll]);

  // 离开评估页时停止播报
  useEffect(() => {
    return () => {
      speech.cancel();
    };
  }, []);

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

  // 收敛面板数据（T18 widget 接入：按当前 trace/score 展示，无则空态）
  const convergenceTrace = useConvergenceStore((s) => s.trace);
  const convergenceScore = useConvergenceStore((s) => s.score);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? null,
    [agentsRaw, selectedAgentId],
  );

  /** 当前选中 agent 的评估档案（含面试基线 interviewBaseline） */
  const selectedProfile = selectedAgentId ? (profiles[selectedAgentId] ?? null) : null;

  const handleRun = async (agent: AgentSummary) => {
    // 会话下拉框属于当前选中的 agent；对未选中的 agent 点「运行评估」时
    // selectAgent 会异步重置选择，这里必须忽略残留的跨 agent 会话，
    // 否则会把 A 的 sessionId 写进 B 的评估与 runlink。
    const session =
      agent.id === selectedAgentId
        ? (sessionOptions.find((s) => s.sessionId === selectedSessionId) ?? null)
        : null;
    selectAgent(agent.id);
    await runEvaluation({
      runId: runIdInput.trim() || null,
      agentId: agent.id,
      agentName: agent.name,
      sessionKey: session?.sessionKey ?? '',
      sessionId: session?.sessionId ?? '',
      taskId: '',
      task: taskTitle.trim()
        ? { title: taskTitle.trim(), description: '', weight: 1 }
        : undefined,
      persona: agent.persona,
    });
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

          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="px-2 py-4 text-sm text-gray-400">
                {t('evaluation.noAgents', '未加载到 agent。')}
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
          <div className="flex gap-1.5 border-b border-white/40 px-6 py-3">
            {PANELS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPanel(p.key)}
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

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {panel === 'radar' ? (
              <div className="space-y-4">
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
                    {t('evaluation.radarSelectHint', '从左侧选择一个 agent 查看雷达。')}
                  </p>
                )}
              </div>
            ) : null}

            {panel === 'narration' ? (
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
            ) : null}

            {panel === 'roi' ? <RoiPanel roi={roiLatest} /> : null}

            {panel === 'lifecycle' ? (
              <LifecyclePanel
                agentId={selectedAgentId}
                state={selectedState}
                busy={streaming}
                onSoftRetire={(id) => void setLifecycle(id, 'RETIRED')}
                onReactivate={(id) => void setLifecycle(id, 'ACTIVE')}
              />
            ) : null}

            {panel === 'leaderboard' ? (
              <Leaderboard
                entries={leaderboard}
                selectedAgentId={selectedAgentId}
                onSelect={(id) => selectAgent(id)}
              />
            ) : null}

            {/* S3 双轨评分卡（客观遥测 + 主观打分 + 0.7/0.3 加权 total） */}
            {panel === 'dual' ? <DualTrackScoreCard agentId={selectedAgentId} /> : null}

            {/* 双榜：客观榜 + 可拖拽主观榜（拖拽即偏好回灌，T39 重写版） */}
            {panel === 'dualBoard' ? (
              <DualLeaderboard
                stage="performance"
                jobType={selectedProfile?.jobType ?? 'all'}
              />
            ) : null}

            {/* 收敛轨迹（Layer3 独立视图，不进客观榜） */}
            {panel === 'convergence' ? (
              <ConvergenceTrajectoryWidget
                trace={convergenceTrace}
                score={convergenceScore}
              />
            ) : null}

            {/* 用户心智模型（userWeight vs 基准 + dimLift） */}
            {panel === 'preference' ? <PreferenceInsightPanel /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Evaluation;
