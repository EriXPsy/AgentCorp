import type {
  BossProfile,
  EvaluationProfile,
  LifecycleState,
  Verdict,
} from '@/types/evaluation';

/** 一次评估运行的入参（由 Evaluation 页面在捕获 runId 后传入） */
export interface EvaluationRunInput {
  /** 来自 gateway.rpc('chat.send') 的执行主键；缺失时仅做本地画像（不写 runlink） */
  runId?: string | null;
  agentId: string;
  agentName: string;
  sessionKey: string;
  sessionId: string;
  taskId?: string;
  task?: { title: string; description: string; weight: number };
  persona?: string;
  /** A · 老板原型（用户个性化）：描述「正在评估/雇佣这位 agent 的人」，区别于 agent.persona */
  bossProfile?: BossProfile;
  /**
   * 转录兜底：仅当主进程采集不到会话转录时启用（例如多 Agent 编排路径的
   * LLM 调用不落在某个 gateway 会话里，`collectRunData` 会返回空 transcript）。
   * 空转录会让裁判无证据可依、只能给中性分，那等于白评一次。
   * 有采集到真实转录时**一律以采集为准**，这里只是补位，不是覆盖。
   */
  transcriptFallback?: string;
}

/** store 暴露给页面/回流链路的评估结果。 */
export interface EvaluationRunOutcome {
  profile: EvaluationProfile;
  lifecycle: LifecycleState;
  transcript: string;
  verdict: Verdict | null;
  verdictUserFit: number;
  sawAudio: boolean;
}
