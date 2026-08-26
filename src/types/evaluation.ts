/**
 * src/types/evaluation.ts
 * ★ AgentCorp 评估层单一类型真相源（Single Source of Truth）。
 *
 * 移植自原 Web Demo 的 src/types/index.ts，作为 AgentCorp（基于 AgentCorp 基底）
 * 评估层的契约根。前端 TS 与后端 `model-service/app/schemas.py`（待扩展）严格镜像。
 *
 * 关键契约：
 * - EvaluationRequest：评估请求（候选媒体以 URL 或 base64 提供）。
 * - EvaluationEvent：SSE 事件流联合类型，五种事件
 *   radar_update / narration / audio / verdict / done。
 *
 * 注：AgentCorp 基底的 src/types 下无 index.ts，评估类型统一收敛到此文件，
 * 其余领域类型见 src/types/agent.ts 等。
 */

/* ===================== 评估层扩展：三阶段 × 三工种 ===================== */
/**
 * 工种类型。权重取向：image 侧重 creativity，text 侧重 comm 与 quality，code 侧重 reliability 与 cost。
 * 严格照搬，不改动既有 RadarDim / Verdict / LifecycleState。
 */
export type JobType = "image" | "text" | "code";
/** 阶段键（S1/S2/S3） */
export type StageKey = "preScreen" | "interview" | "performance";
/** 主观维度（分阶段启用，键名 sub_* 不冲突 */
export type SubjectiveDim =
  | "sub_potential"
  | "sub_aesthetic_lean"
  | "sub_task_feel"
  | "sub_communication"
  | "sub_surprise"
  | "sub_trust"
  | "sub_rehire";
/** 工种 craft 维度（前缀隔离*/
export type CraftDim =
  | "img_composition"
  | "img_style_fit"
  | "img_fidelity"
  | "img_aesthetic_consistency"
  | "img_multimodal_follow"
  | "txt_factuality"
  | "txt_coherence"
  | "txt_tone_fit"
  | "txt_info_density"
  | "txt_instruction_follow"
  | "code_runnability"
  | "code_efficiency"
  | "code_test_coverage"
  | "code_maintainability"
  | "code_security";
/** craft 维元数据 */
export interface CraftDimMeta {
  key: CraftDim;
  jobType: JobType;
  links: RadarDim[]; // 关联通用六维（回灌/加权）
  requiresReal: boolean; // Q6：code_runnability/code_security = true
  anchor: { 0: string; 3: string; 5: string }; // 0–5 锚点
}

/** 六维雷达维度键（顺序即展示顺序） */
export type RadarDim =
  | "task"
  | "quality"
  | "comm"
  | "creativity"
  | "reliability"
  | "cost";

/** 宣判结果枚举（大写，命名约定 §8） */
export type Verdict = "MVP" | "OBSERVE" | "FIRED";

/** 审美取向枚举 */
export type Aesthetic = "minimal" | "rich" | "neutral";

/** 六维分数（0–5，0.5 步进） */
export interface RadarScore {
  task: number;
  quality: number;
  comm: number;
  creativity: number;
  reliability: number;
  cost: number;
}

/* ===================== 老板原型 / 用户个性化（A · 人格化评估） =====================
 * Wang et al. (2025) "The inadequacy of offline LLM evaluations" 核心主张：
 * 离线/无状态评估无法反映真实行为，因为个性化（用户画像、交互历史）根本改变了模型行为。
 * 评估框架必须把「与谁协作」作为基本输入。AgentCorp 据此引入独立的 BossProfile——
 * 与既有的 agent.persona（agent 自己的系统人设）区分，描述「正在评估/雇佣这位 agent 的人」。
 */

/** 经验水平（影响澄清/手艺探针权重） */
export type ExperienceLevel = 'novice' | 'intermediate' | 'expert';
/** 风险厌恶（影响可靠性/越权/冲突类题权重；高分=更看重稳健与合规） */
export type RiskAversion = 'low' | 'medium' | 'high';
/** 沟通风格（影响沟通维权重） */
export type CommunicationStyle = 'concise' | 'detailed' | 'socratic';

/**
 * 老板原型（用户个性化画像）。纯数据、可序列化、无副作用。
 * id 作为评估套件矩阵（C）的稳定键；neutral 为无个性化基线。
 */
export interface BossProfile {
  /** 稳定键（套件矩阵按此聚合；如 'neutral' / 'boss-growth' / 'boss-risk'） */
  id: string;
  /** 展示名（UI 用，可空） */
  name?: string;
  /** 领域（如「电商增长」「学术研究」） */
  domain?: string;
  /** 经验水平 */
  experienceLevel?: ExperienceLevel;
  /** 风险厌恶 */
  riskAversion?: RiskAversion;
  /** 沟通风格 */
  communicationStyle?: CommunicationStyle;
  /** 约束偏好关键词（'cost' | 'speed' | 'quality' | 'safety' 等，驱动维度强调） */
  constraintPrefs?: string[];
}

/** 中性老板（无个性化基线；所有增量评估的对照锚点） */
export const NEUTRAL_BOSS: BossProfile = {
  id: 'neutral',
  name: '中性老板（无个性化）',
};

/** 六维权重（Σ=1） */
export interface WeightVector {
  task: number;
  quality: number;
  comm: number;
  creativity: number;
  reliability: number;
  cost: number;
}

/** 用户偏好（语音/表单解析所得） */
export interface UserPreference {
  aesthetic: Aesthetic;
  budget_max: number;
  preferred_stack: string[];
  weight: WeightVector;
}

/** 文本 persona 引用 */
export interface PersonaText {
  type: "text/markdown";
  content: string;
}

/** 媒体引用（URL 或 base64 内联） */
export interface MediaRef {
  type: string;
  url: string;
}

/** 代码库引用 */
export interface CodeRef {
  type: "application/zip" | "repo/github";
  url: string;
  lang: string;
}

/** 评估结果（模型生成） */
export interface Evaluation {
  radar: RadarScore;
  user_fit: number;
  verdict: Verdict;
  evidence_trace: string[];
  confidence: number;
}

/** 候选档案（前后端同源契约*/
export interface CandidateProfile {
  id: string;
  name: string;
  declared_tags: string[];
  declared_budget: number;
  persona_text: PersonaText;
  video_demo: MediaRef;
  voice_intro: MediaRef;
  artwork: MediaRef[];
  code_repo: CodeRef;
  evaluation: Evaluation;
}

/** 评估请求（options 用于复现控制，见架构 D7） */
export interface EvaluationRequest {
  candidate: CandidateProfile;
  preference: UserPreference;
  options?: {
    temperature?: number;
    seed?: number;
    frame_sample?: number;
  };
}

/* ===================== SSE 事件流（五种事件） ===================== */

/** 雷达逐维点亮（消费后触发动画） */
export interface RadarUpdateEvent {
  type: "radar_update";
  dim: RadarDim;
  score: number;
  confidence: number;
  evidence: string;
  /** E · 裁判来源（透明披露）：'degraded' = 离线启发式回退，缺省 = 外部 MiniCPM-o 裁判 */
  source?: "judge" | "degraded";
}

/** 讲解文本增量（is_final=true 表示讲解结束） */
export interface NarrationEvent {
  type: "narration";
  delta: string;
  is_final: boolean;
}

/**
 * 语音音频块。
 * chunk 始终为 base64 字符串：
 * - 真实模式：PCM16 / wav 字节（由 useSpeech 解码为 AudioBuffer 播放）。
 * - Mock 模式：UTF-8 文本（由 useSpeech 解码为文本后用 speechSynthesis 朗读）。
 * 两种模式复用同一字段，前端无感。
 */
export interface AudioEvent {
  type: "audio";
  chunk: string;
  format: "pcm16" | "wav";
  sample_rate: number;
}

/** 终审判定（含 user_fit 与证据留痕） */
export interface VerdictEvent {
  type: "verdict";
  verdict: Verdict;
  user_fit: number;
  evidence_trace: string[];
  confidence: number;
  /**
   * E · 裁判来源（透明披露）：'degraded' = 离线启发式回退，缺省 = 外部 MiniCPM-o 裁判。
   * verdict 是用户最当真的结论（MVP / 待观察 / Not recommended），
   * 哈希派生的 FIRED 与真裁判给的 FIRED 必须可区分。
   */
  source?: "judge" | "degraded";
}

/** 评估完成 */
export interface DoneEvent {
  type: "done";
  evaluation_id: string;
}

/** SSE 事件联合类型（前端统一解析） */
export type EvaluationEvent =
  | RadarUpdateEvent
  | NarrationEvent
  | AudioEvent
  | VerdictEvent
  | DoneEvent;

/** 评估会话状态机 */
export type SessionStatus = "idle" | "streaming" | "done";

/** 运行时评估会话（存于 Zustand store） */
export interface EvaluationSession {
  candidate: CandidateProfile | null;
  preference: UserPreference | null;
  partialRadar: Partial<RadarScore>;
  dimEvidence: Partial<Record<RadarDim, string>>;
  narration: string;
  verdict: Verdict | null;
  userFit: number | null;
  evidenceTrace: string[];
  confidence: number | null;
}

/** 上传表单（P1 交互上传模式） */
export interface UploadForm {
  name: string;
  declared_tags: string[];
  declared_budget: number;
  persona_text: string;
  files: Record<string, File>;
}

/* ===================== 职场生命周期（绩效中心） ===================== */

/**
 * 生命周期五态。
 * 注意：agent 运行时真相为小写 `AgentLifecycleStatus`
 * （见 src/lib/evaluation/lifecycle.ts），此处大写 `LifecycleState` 为评估层内部别名，
 * verdict → 生命周期的统一映射见 types/lifecycle.ts 的 verdictToLifecycleState。
 */
export type LifecycleState =
  | "ONBOARDING"
  | "ACTIVE"
  | "TRAINING"
  | "MAINTENANCE"
  | "RETIRED";

/** 可量化绩效指标 KPI（客观，聚合自运行遥测，见评估） */
export interface KpiRecord {
  agentId: string;
  task_completion_rate: number; // TCR  0–1 任务完成率
  first_success_rate: number; // FSR  0–1 一次成功率
  rework_rate: number; // RR   0–1 返工率
  avg_delivery_latency_ms: number; // ADL  平均交付时延（ms）
  autonomy_rate: number; // AR   0–1 自主完成率
  escalation_rate: number; // ER   0–1 升级/求助率
  cross_task_generalization: number; // CGR  0–1 跨任务泛化率
  stability_consistency: number; // SCR  0–1 稳定性（多轮一致率）
  sample_n: number; // 参与聚合的遥测条数
  window: string; // 考核窗口，如 "2025-W30"
  computedAt: string; // ISO8601 UTC
}

/** ROI / 效率快照（见评估） */
export interface RoiSnapshot {
  agentId: string;
  cost_total: number; // C_total 成本当量 CU
  value_total: number; // V_total 价值当量 CU
  roi: number; // (V−C)/C，可为负
  ipr: number; // V/C 投入产出比
  srpc: number; // 单位成本成功率 = n_success / C
  cps: number; // 归一化投入产出分（IPR → 0–5，见 roiEngine.normCps）
  cost_perf_score: number; // 0–5 性价比分（CPS 与雷达 cost 维融合）
  roi_index: number; // 相对基线 ROI_baseline
  roi_norm?: number; // 群体 z-score（有对照群时填充）
  window: string;
}

/** 生命周期触发事件类型（驱动状态机迁移） */
export type LifecycleTrigger =
  | "probation_pass"
  | "probation_fail"
  | "monthly_arena"
  | "pip_pass"
  | "pip_fail"
  | "roi_drop"
  | "replaced"
  | "manual";

/** 生命周期迁移事件（可语音播报 reason） */
export interface LifecycleEvent {
  agentId: string;
  from: LifecycleState;
  to: LifecycleState;
  reason: string; // 人类可读触发原因
  trigger: LifecycleTrigger;
  ts: string; // ISO8601 UTC
}

/** 擂台排名层级（含末位淘汰标记） */
export type LeaderboardTier = "MVP" | "NORMAL" | "BOTTOM";

/** 擂台排名条目 */
export interface LeaderboardEntry {
  agentId: string;
  name: string;
  rank: number; // 名次（1=榜首）
  user_fit: number; // 0–100 用户契合度
  roi_norm: number; // z-score，末位判定依据
  state: LifecycleState;
  tier: LeaderboardTier; // MVP / NORMAL / BOTTOM
  radar_delta?: number; // 能力增长轨迹（晋升依据）
  /**
   * 本条排名所依据的评分来源（透明披露）。
   * judge = 全维真实裁判；mixed = 真裁判与回退混合；degraded = 全部回退；
   * null = 无来源标注（历史数据 / 未评估）。
   * 渲染层必须据此把 degraded 条目与真实评测条目**分区展示**，
   * 不得让未经模型评测的分数与真实评测分数并列比较。
   */
  judge_source?: "judge" | "mixed" | "degraded" | null;
}

/* ===================== 运行期遥测（第二条契约，评估） ===================== */

/** 对端模型层回传的逐任务遥测（由 telemetrySynth 确定性合成） */
export interface TelemetryEvent {
  agent_id: string;
  task_id: string;
  success: boolean; // 任务是否成功
  first_try: boolean; // 是否一次成功
  rework: number; // 返工次数
  latency_ms: number; // 交付时延
  human_interventions: number; // 人工介入次数
  escalations: number; // 升级/求助次数
  out_of_domain: boolean; // 是否跨域（泛化）任务
  ts: string; // ISO8601 UTC
}

/* ===================== A2A 委派 trace（a2a-integration §3.4，P1 仅加法） ===================== */

export type A2aTraceKind = "message" | "status" | "artifact";
export type A2aTraceState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

/**
 * A2A 委派 trace 记录（JSONL 每行一条，落盘 ~/.openclaw/a2a-traces/<rootSessionId>.jsonl）。
 * 内部委派（chat.send）与外部 A2A（message/send，P2+）共用同一 schema，
 * 是六维评估 comm/reliability 维的客观证据源；evidence_trace 可引用 trace_id 回放。
 *
 * 末尾三个字段（session_key / root_session_id / trigger）是 P1 在 §3.4 schema
 * 之上的仅加法扩展：root_session_id 是落盘文件名与 collectRunData 的关联键，
 * trigger 标记埋点来源（人工 steer 计入 human_interventions）。
 */
export interface A2aTraceRecord {
  trace_id: string; // uuid
  task_id: string; // 子会话 runtime id（A2A 链路为 A2A task id）
  parent_task_id: string | null; // 父会话 runtime id
  delegator: string; // agent:<leaderId> | external:<clientId>
  delegatee: string; // agent:<workerId> | a2a:<externalUrl>
  round: number; // 同一 task_id 下的委派轮次（spawn=1，每次 steer +1）
  kind: A2aTraceKind;
  state: A2aTraceState;
  rework_of: string | null; // 返工时指向上一轮的 trace_id
  channel: "internal-rpc" | "a2a";
  sent_at: string; // ISO8601 UTC
  completed_at: string | null; // ISO8601 UTC（kill 时 = sent_at）
  summary: string; // 一句话任务/结果摘要（进 judge prompt 用）
  session_key: string; // 子会话完整 sessionKey
  root_session_id: string; // 根会话 ID（trace 文件名 / 评估关联键）
  trigger: "spawn" | "steer" | "kill"; // 埋点来源

  /** —— 扩展字段：与统一 trace 模型对齐（跨进程关联 + 成本归因）——
   *  全部 optional，向后兼容既有落盘 JSONL（旧记录缺这些字段仍可 parse）。 */
  correlation_id?: string | null; // 跨进程/跨调用关联键（≈ TraceSpan.correlationId）
  parent_span_id?: string | null; // 父 span id（≈ TraceSpan.parentSpanId）
  agent_id?: string | null; // 执行主体（≈ TraceSpan.agentId）
  cost_usd?: number | null; // 该 trace 产生的成本（美元）
  tokens?: number | null; // 消耗的 token 数
  latency_ms?: number | null; // 时延（ms）
}

/* ===================== 评估档案落库 ===================== */

/**
 * 评估档案（本地落库，见 docs/architecture-pivot.md §2.D / §3）。
 * 以 agentId 为键存于 electron-store 命名空间 `agentcorp.evaluation`。
 *
 * 注意：`lifecycle` 采用评估层大写别名 `LifecycleState`（与运行时小写
 * `AgentLifecycleStatus` 经 lifecycle.ts 的 LIFECYCLE_TO_STATE 对齐，单源真相在小写侧）。
 */
export interface EvaluationProfile {
  agentId: string;
  radarLatest: RadarScore;
  radarHistory: RadarScore[];
  kpiLatest: KpiRecord;
  kpiHistory: KpiRecord[];
  roiLatest: RoiSnapshot;
  lifecycle: LifecycleState;
  runIds: string[];
  updatedAt: string; // ISO8601 UTC

  /* —— 三模块增量（v1.0-frontend-increment §5.4）——
   * 全部 optional 仅加法，向后兼容既有落库数据；绝不删改上方既有字段。 */
  /** 最近一次裁判 verdict 的用户契合度（0–100）；缺失时 Leaderboard 回退 task*20 */
  userFitLatest?: number;
  /** 最近一次裁判 verdict 的证据留痕 */
  evidenceTraceLatest?: string[];
  /** 工种（S1/S2/S3 评分卡与双榜筛选用） */
  jobType?: JobType;
  /** S1/S2/S3 评分卡（stageScoreStore 同步回写） */
  stageScores?: StageScore[];
  /** 最近一次主观赋分 */
  subjectiveLatest?: SubjectiveScore;
  /** 主观赋分历史 */
  subjectiveHistory?: SubjectiveScore[];
  /** Q7 craft 维最新得分（键为 CraftDim 字符串） */
  craftLatest?: Record<string, number>;
  /**
   * ② 面试 → 绩效基线（来自最新 InterviewReport）。
   * metrics 就地内联定义（与 types/interview.ts 的 InterviewReport['metrics']
   * 结构镜像），避免评估域 → 面试域的跨模块循环依赖。
   */
  interviewBaseline?: {
    /** 面试期六维（finalRadar ?? baselineRadar，可能缺失） */
    radar: RadarScore | null;
    /** 面试期关键能力数据（仅展示/参考，不并入 KpiRecord 聚合） */
    metrics: {
      avgReplyLatencyMs: number | null; // 思考时间基线
      totalTokens: number | null; // token 消耗基线
      clarificationCount: number; // agent 主动澄清次数
      followupCount: number; // 被追问次数
      coverageRatio: number; // targetDims 覆盖比
    };
    reportId: string;
    ts: string;
  };
  /**
   * ③ 人格化评估套件（C · benchmark suite）：按 BossProfile.id 存六维雷达。
   * 用于跨用户原型对比（维度×原型矩阵）与个性化增量（personalization delta）计算。
   * 加法字段：无 persona 评估时保持 undefined，向后兼容既有落库数据。
   */
  radarByPersona?: Record<string, RadarScore>;
  /**
   * B · 个性化风险等级（personalization delta 接风险标红）：由 radarByPersona 的
   * 跨原型最大漂移推导。'high' = 该 agent 表现随协作对象显著漂移（对谁说都不一样），
   * 真实协作里风险更高，需额外把关。无足够数据时为 null。加法字段。
   */
  personalizationRisk?: PersonalizationRisk | null;
  /**
   * B · 状态化多轮会话（历史协作）：按 BossProfile.id 累积的历史会话摘要，
   * 用于把「记忆」注入裁判上下文，使评估从离线/无状态升级为带历史的状态化评估
   * （Wang 的 sock-puppet + 交互历史主张）。仅存摘要 + 可选 transcript，封顶 3 条。
   * 加法字段。
   */
  sessionsByPersona?: Record<string, AgentSessionSummary[]>;
  /**
   * E · 透明披露：本次评估所用的老板原型 id（'neutral' = 无个性化基线）。
   * 供评估卡披露「基于哪个 persona 得出此分」，与当前激活原型对照。
   * 加法字段。
   */
  lastPersonaId?: string;
  /**
   * E · 透明披露：本次评估的裁判来源。'judge' = 全部维度来自外部 MiniCPM-o 裁判；
   * 'degraded' = 全部回退客观 KPI 启发式（agentId 哈希派生）；
   * 'mixed' = 部分维度真裁判、部分回退——此前被并入 'degraded'，
   * 掩盖了「大部分维度其实是真裁判」的事实，故单列一态。
   * 加法字段，缺省 null（历史数据无此标注）。
   */
  judgeSource?: "judge" | "mixed" | "degraded" | null;
}

/** 个性化风险等级（B · personalization delta 接风险标红） */
export type PersonalizationRisk = 'high' | 'medium' | 'low';

/** B · 单条历史会话摘要（历史协作上下文注入用） */
export interface AgentSessionSummary {
  /** ISO8601 UTC */
  ts: string;
  /** 对话摘要（前若干字符，注入裁判前缀用） */
  summary: string;
  /** 完整 transcript（多 session passK 复用；可选，体积敏感） */
  transcript?: string;
}

/**
 * 执行主键关联（runId ↔ taskId ↔ agentId ↔ session）。
 * 以 runId 为键存于 electron-store 命名空间 `agentcorp.runlinks`（见 §2.D）。
 */
export interface RunTaskLink {
  runId: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  evaluatedAt: string; // ISO8601 UTC
}

/* ===================== 评估层扩展：阶段评分与偏好回灌 ===================== */
/**
 * 单次客观维得分（含来源 + 扁平权重，供 Q7 craft 独立存库/工种雷达）。
 * 与后端 schemas.ObjectiveScoreItem 严格镜像。
 */
export interface ObjectiveScoreItem {
  dim: string;
  score: number;
  source: 'judge' | 'telemetry' | 'mixed';
  weight: number;
  evidence?: string;
}

/** 单次主观赋分（人类 owner。镜像后端 schemas.SubjectiveScore */
export interface SubjectiveScore {
  agentId: string;
  stage: StageKey;
  scores: Partial<Record<SubjectiveDim, number>>;
  notes?: string;
  scoredBy: string;
  ts: string;
}

/** craft 维独立存库（Q7）。镜像后端 schemas.CraftScores */
export interface CraftScores {
  jobType: JobType;
  dims: Partial<Record<CraftDim, number>>;
  downweighted: CraftDim[];
  evidence: Partial<Record<CraftDim, string>>;
}

/** 三阶段评分卡（S1/S2/S3 同构）。镜像后端 schemas.StageScore */
export interface StageScore {
  agentId: string;
  stage: StageKey;
  jobType: JobType;
  objective: ObjectiveScoreItem[];
  subjective: SubjectiveScore;
  objectiveWeight: number;
  subjectiveWeight: number;
  objectiveScore: number;
  subjectiveScore: number;
  total: number;
  verdict: 'MVP' | 'OBSERVE' | 'FIRED';
  craftScores: CraftScores;
  window?: string;
  ts: string;
}

/** POST /api/evaluate-stage 入参。镜像后端 schemas.StageScoreRequest */
export interface StageScoreRequest {
  agentId: string;
  stage: StageKey;
  jobType: JobType;
  objective: Record<string, number>;
  subjective: Record<string, number>;
  /**
   * 展示用证据（含裁判引文）。**不会**解除 requiresReal 维的降权。
   */
  craftEvidence?: Record<string, string>;
  /**
   * 机器可核验证据：requiresReal 维（code_runnability / code_security）的
   * 真实执行结果（测试通过率 / 构建日志）或真实扫描结果。
   * 只有这里的键能解除后端 Q6 的 ×0.4 降权——裁判模型自己的引文没有这个资格，
   * 否则「缺真实执行则降权」等于让被监管方给自己发合格证。
   * 当前尚无沙盒执行链路，故通常为空；接入沙盒后由执行器填充。
   */
  verifiedEvidence?: Record<string, string>;
  presetId?: string;
  scoredBy?: string;
  window?: string;
}

/** 双 Leaderboard · 客观榜条目（按 objectiveScore 排序）。镜像后端 schemas.LeaderboardEntry */
export interface ObjectiveBoardEntry {
  agentId: string;
  name: string;
  jobType: JobType;
  objectiveScore: number;
  roiNorm: number;
  rank: number;
  state: string;
  tier: 'MVP' | 'NORMAL' | 'BOTTOM';
}

/** 双 Leaderboard · 主观榜条目（可拖拽）。镜像后端 schemas.SubjectiveRankEntry */
export interface SubjectiveBoardEntry {
  agentId: string;
  name: string;
  jobType: JobType;
  subjectiveScore: number;
  objectiveRank: number;
  dragRank: number;
}

/** 客观序 vs 拖拽序发散（自动派生）。镜像后端 schemas.RankDivergence */
export interface RankDivergence {
  agentId: string;
  objectiveRank: number;
  dragRank: number;
  delta: number;
}

/** 双 Leaderboard 聚合（客观榜 + 可拖拽主观榜 + 复核发散）。镜像后端 schemas.DualLeaderboard */
export interface DualLeaderboard {
  stage: StageKey;
  jobType: JobType | 'all';
  objective: ObjectiveBoardEntry[];
  subjective: SubjectiveBoardEntry[];
  divergences: RankDivergence[];
  updatedAt: string;
}

/** 一次拖拽 = 一个偏好信号（Q5 回灌）。镜像后端 schemas.PreferenceSignal */
export interface PreferenceSignal {
  id: string;
  ownerId: string;
  stage: StageKey;
  jobType: JobType;
  agentId: string;
  srcRank: number;
  dstRank: number;
  direction: 'up' | 'down';
  craftScores?: Record<string, number>;
  ts: string;
}

/** 聚合后回灌 UserPreference.weight 的偏好画像。镜像后端 schemas.PreferenceProfile */
export interface PreferenceProfile {
  ownerId: string;
  signals: PreferenceSignal[];
  pairwiseWins: Record<string, number>;
  dimLift: Partial<Record<RadarDim, number>>;
  updatedAt: string;
}

/** 任务集运行结果。镜像后端 schemas.TaskRunResult */
export interface TaskRunResult {
  agentId: string;
  taskSetId: string;
  jobType: JobType;
  objectiveScores: Record<string, number>;
  telemetry: unknown[];
  usage: unknown[];
  craftEvidence: Record<string, string>;
  meta: Record<string, number>;
  /** 难度校准时间戳（ISO 8601）；undefined/null = 未校准，不得当校准过展示 */
  difficultyCalibratedAt?: string | null;
}

/** TaskSet 元数据（前端注册表镜像用）。镜像后端 schemas.TaskSetMeta */
export interface TaskSetMeta {
  id: string;
  title: string;
  description: string;
  applicableJobs: JobType[];
  /** 难度校准时间戳（与 TaskRunResult.difficultyCalibratedAt 同源） */
  difficultyCalibratedAt?: string | null;
}
