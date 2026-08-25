/**
 * src/services/judgeClient.ts
 * MiniCPM-o 外部裁判客户端。
 *
 * - evaluate(input)：经主进程流代理（ipc 'hostapi:stream'）POST /api/evaluate/run，
 *   解析 SSE 流为 EvaluationEvent（radar_update ×6 + verdict + done）。
 * - 非 200 / 503 / 网络错误时回退 fallbackMock：cost 维由真实 usage 折算，
 *   其余维有真实遥测走 metricsEngine 客观 KPI、无遥测走 transcript 弱信号、
 *   零证据给中性基线并标注「不可评」，离线可用且绝不造分。
 *
 * 鉴权：Host API 会话 token 由主进程代持（不下发渲染进程）——
 * 普通 JSON 请求走 hostApiFetch，SSE 流走 hostApiStream。
 */
import { hostApiFetch, hostApiStream } from '@/lib/host-api';
import type {
  EvaluationEvent,
  TelemetryEvent,
  RadarScore,
  RadarDim,
  Verdict,
  BossProfile,
} from '@/types/evaluation';
import type { ConvergenceScore, TurnState } from '@/types/convergence';
import type {
  ArenaCompareInput,
  ArenaMatch,
  ArenaPickResult,
  ArenaUserPickInput,
} from '@/types/arena';
import { computeKpi } from '@/engine/metricsEngine';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { RADAR_DIM_LABELS } from '@/engine/marketplace/radarSource';
import { traceEmitter } from '@/engine/trace/traceEmitter';

// Host API 端点与鉴权统一起点在 src/lib/host-api.ts（token 由主进程代持）

/** 一次裁判运行的入参（与后端 model-service /api/evaluate-run 契约严格对齐） */
export interface JudgeTask {
  title: string;
  description: string;
  weight: number;
}

export interface JudgeRunInput {
  agentId: string;
  agentName: string;
  persona?: string;
  task: JudgeTask;
  transcript: string;
  /** 真实 token 用量（来自 tokenUsageCollector） */
  usage: TokenUsageHistoryEntryLike[];
  /**
   * 真实逐任务遥测（可选，仅加法；后端 pydantic 默认忽略未知字段，
   * 与下方 convergence 字段同先例）。传入时 fallbackMock 的雷达由客观 KPI
   * 归一化派生；缺失/为空（遥测退化）时改由 agentId 确定性哈希派生，
   * 避免旧实现 usageToTelemetry 伪造全成功事件导致的六维失真。
   */
  telemetry?: TelemetryEvent[];
  preference?: {
    aesthetic?: string;
    budget_max?: number;
    weight?: Partial<Record<string, number>>;
  };
  /**
   * A · 老板原型（用户个性化）：描述「正在评估/雇佣这位 agent 的人」。
   * 与既有 agent.persona（agent 自己的系统人设）区分。后端不识别时忽略该字段；
   * 前端流式裁判当前未消费它，但 /api/chat-judge 路径（judgeChat）已据此注入前缀。
   */
  bossProfile?: BossProfile;
  /**
   * 收敛层开关（仅加法，后端不识别时忽略该字段）。
   * k = 每轮候选数（建议 3–7，保可逆性）；captureSummaries = 是否回传候选摘要文本。
   */
  convergence?: {
    k?: number;
    captureSummaries?: boolean;
  };
  /**
   * B · 状态化多轮会话（历史协作）：与同一 agent 的过往会话摘要，
   * 由渲染层注入裁判上下文（后端不识别时忽略该字段）。
   */
  history?: string[];
}

/* ───────────── 收敛层 SSE 侧信道 ─────────────
 * `convergence_update` / `convergence_score` 不属于 EvaluationEvent 联合类型
 * （评估域契约保持不动），故走独立监听器分发，订阅方（convergenceStore）
 * 自行决定如何落到轨迹上。无人订阅时静默丢弃，不影响评估主流。 */

/** 收敛事件（判别联合） */
export type JudgeConvergenceEvent =
  | { type: 'convergence_update'; runId: string; turn: TurnState }
  | { type: 'convergence_score'; runId: string; score: ConvergenceScore };

type ConvergenceHandler = (event: JudgeConvergenceEvent) => void;

const convergenceHandlers = new Set<ConvergenceHandler>();

/**
 * 订阅收敛事件。
 * @returns 取消订阅函数
 */
export function onConvergenceEvent(handler: ConvergenceHandler): () => void {
  convergenceHandlers.add(handler);
  return () => {
    convergenceHandlers.delete(handler);
  };
}

/** 广播收敛事件（订阅方异常不影响其他订阅方与主流） */
function emitConvergence(event: JudgeConvergenceEvent): void {
  for (const handler of convergenceHandlers) {
    try {
      handler(event);
    } catch {
      // 订阅方自身异常吞掉
    }
  }
}

/** 把 SSE 原始 JSON 解析成 TurnState（字段缺失时给安全默认值） */
function toTurnState(json: Record<string, unknown>): TurnState {
  const rawCandidates = Array.isArray(json.candidates) ? (json.candidates as unknown[]) : [];
  return {
    turn: Number(json.turn ?? 0),
    candidates: rawCandidates.map((item) => {
      const c = (item ?? {}) as Record<string, unknown>;
      return {
        candidate_id: String(c.candidate_id ?? ''),
        turn: Number(c.turn ?? json.turn ?? 0),
        summary_text: String(c.summary_text ?? ''),
        embedding: Array.isArray(c.embedding) ? (c.embedding as unknown[]).map(Number) : [],
        job_type: c.job_type as TurnState['candidates'][number]['job_type'],
      };
    }),
    belief_embedding: Array.isArray(json.belief_embedding)
      ? (json.belief_embedding as unknown[]).map(Number)
      : [],
    // 08-07：透传诚实标注（旧版后端无此字段 → undefined，向后兼容）
    source: json.source === 'projected' || json.source === 'measured' ? json.source : undefined,
    synthetic: typeof json.synthetic === 'boolean' ? json.synthetic : undefined,
  };
}

/** 把 SSE 原始 JSON 解析成 ConvergenceScore（字段缺失时给安全默认值） */
function toConvergenceScore(json: Record<string, unknown>): ConvergenceScore {
  const weights = (json.weights ?? {}) as Record<string, unknown>;
  return {
    run_id: String(json.run_id ?? ''),
    agent_id: String(json.agent_id ?? ''),
    contraction_rate: Number(json.contraction_rate ?? 0),
    // A3：R/St 缺失或为 null 时保持 null（= 未获人类背书，未参与评分），
    // 不能落成 0 —— 0 会被读成「完美对齐」。
    residual: json.residual === null || json.residual === undefined ? null : Number(json.residual),
    stability:
      json.stability === null || json.stability === undefined ? null : Number(json.stability),
    // 语义收缩（SC）：走 A3 数值契约 —— 始终填数值（下游 toFixed/Number 不会崩），
    // 「没算过」与「一项未知都没消解」靠 semantic_scored 区分，不靠 null。
    // 旧版后端无此字段 → 0 + semantic_scored=false，UI 应显示「—」而非 0.000。
    semantic_contraction: Number(json.semantic_contraction ?? 0),
    // 是否真的参与了评分。下游必须读本字段判断，不许靠 semantic_contraction === 0
    // 反推 —— 0 是合法的「未消解」取值，两者不可混。
    semantic_scored: json.semantic_scored === true,
    // 诊断字段：S₀→S_K 的 unknowns 净变化，允许为负（负 = 探索中发现新未知，
    // 是真实信号不是错误）。缺失时 0 表示「无变化」，语义上安全。
    unknowns_delta: Number(json.unknowns_delta ?? 0),
    convergence_score: Number(json.convergence_score ?? 0),
    reversibility: Number(json.reversibility ?? 0),
    convergence_quality: json.convergence_quality === 1 ? 1 : 0,
    weights: {
      w1: Number(weights.w1 ?? 0),
      w2: Number(weights.w2 ?? 0),
      w3: Number(weights.w3 ?? 0),
    },
    ts: String(json.ts ?? new Date().toISOString()),
    // A2：source/synthetic 为必填。旧版后端不发这两个字段时，按最保守方向
    // 兜底为 projected/synthetic —— 未标注的数据不能默认当实测用，
    // 否则一条来路不明的分数会直接进榜单。
    source: json.source === 'measured' ? 'measured' : 'projected',
    synthetic: json.synthetic === false ? false : true,
    persisted: typeof json.persisted === 'boolean' ? json.persisted : undefined,
  };
}

/** 与 @electron/utils/token-usage-core TokenUsageHistoryEntry 结构对齐的轻量类型 */
export interface TokenUsageHistoryEntryLike {
  timestamp: string;
  sessionId: string;
  agentId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ───────────── 评委调用埋点 ─────────────
 * 用统一 trace 模型的 correlationId 把分散的评委调用串成链，emit span 记录
 * 时延，并可在调用后把 token / cost 归属到 span（接 tokenUsageCollector）。 */

/** 一次评委 trace 的上下文。 */
export interface JudgeTraceContext {
  /** 端到端运行 id（如面试 interviewId / 评估 runId）；缺省内部派生。 */
  runId: string;
  agentId: string;
  /** 跨进程/跨调用关联键；缺省回退 runId。 */
  correlationId?: string;
  kind?: string;
  name?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

/**
 * 包裹任意异步函数为一次评委 trace：开启 span → 执行 → 关闭 span（记录时延）。
 * 异常会照常抛出，但 span 仍被关闭（status='error'），保证 trace 完整可追溯。
 * 返回值允许调用方在成功后用 `traceEmitter.endSpan` 补 cost/tokens 完成成本归因。
 */
export async function withTrace<T>(
  ctx: JudgeTraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  const correlationId = ctx.correlationId ?? ctx.runId;
  const spanId = traceEmitter.startSpan({
    runId: ctx.runId,
    kind: ctx.kind ?? 'judge',
    name: ctx.name ?? 'judge',
    agentId: ctx.agentId,
    correlationId,
    attributes: ctx.attributes,
  });
  const started = Date.now();
  try {
    const result = await fn();
    traceEmitter.endSpan(spanId, {
      status: 'ok',
      latencyMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    traceEmitter.endSpan(spanId, {
      status: 'error',
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}

/** token 由主进程代持（见 host-api.ts），渲染进程不再经手。 */

/**
 * transcript 弱信号（0–1），与 model-service `evaluator._transcript_signals` **严格镜像**。
 *
 * 为什么要镜像而不是各写各的：同一条 transcript 在前端离线回退与后端降级路径下
 * 必须得到同一组分数，否则「同一次运行、换条链路就换个分」，结论不可复现。
 *
 * 只看这一次运行实际产出了什么，与 agent 身份完全无关——
 * 因此个人上传的新 agent 不会因为「没有名气」而吃亏。
 */
export function transcriptSignals(
  transcript: string,
): { volume: number; structure: number; specificity: number } | null {
  const text = (transcript ?? '').trim();
  if (!text) return null;
  const lines = text.split('\n').filter((ln) => ln.trim().length > 0);
  return {
    // 产出体量：以 400 字为饱和点（中文信息密度高，按英文长度校准会误判为「过短」）
    volume: Math.min(1, text.length / 400),
    // 结构化：分点/编号说明在给方法
    structure: Math.min(1, (/(^|\n)\s*(\d+[.、)]|[-*·])/.test(text) ? 1 : 0) + lines.length / 20),
    // 具体性：数字与标识符
    specificity: Math.min(
      1,
      (/\d/.test(text) ? 0.5 : 0) + (/[A-Za-z_]{3,}/.test(text) ? 0.5 : 0),
    ),
  };
}

/** 无证据时的中性基线（0–5 量表中位）。不是「及格分」，而是「未知」。 */
export const NEUTRAL_SCORE = 2.5;


/** 从 SSE 文本块解析单条 EvaluationEvent（容忍未知事件类型） */
function parseBlock(block: string): EvaluationEvent | null {
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      data += line.slice(5).replace(/^\s+/, '');
    }
  }
  if (!data) return null;
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    const type = json.type;
    if (type === 'radar_update') {
      return {
        type: 'radar_update',
        dim: json.dim as RadarDim,
        score: Number(json.score ?? 0),
        confidence: Number(json.confidence ?? 0),
        evidence: String(json.evidence ?? ''),
      } as EvaluationEvent;
    }
    if (type === 'narration') {
      return {
        type: 'narration',
        delta: String(json.delta ?? ''),
        is_final: Boolean(json.is_final),
      } as EvaluationEvent;
    }
    if (type === 'audio') {
      return {
        type: 'audio',
        chunk: String(json.chunk ?? ''),
        format: json.format === 'pcm16' ? 'pcm16' : 'wav',
        sample_rate: Number(json.sample_rate ?? 16000),
      } as EvaluationEvent;
    }
    if (type === 'verdict') {
      return {
        type: 'verdict',
        verdict: json.verdict as Verdict,
        user_fit: Number(json.user_fit ?? 0),
        evidence_trace: Array.isArray(json.evidence_trace)
          ? (json.evidence_trace as unknown[]).map(String)
          : [],
        confidence: Number(json.confidence ?? 0),
      } as EvaluationEvent;
    }
    if (type === 'done') {
      return { type: 'done', evaluation_id: String(json.evaluation_id ?? '') } as EvaluationEvent;
    }
    // 收敛层事件走侧信道，不进入 EvaluationEvent 主流
    if (type === 'convergence_update') {
      emitConvergence({
        type: 'convergence_update',
        runId: String(json.run_id ?? ''),
        turn: toTurnState(json),
      });
      return null;
    }
    if (type === 'convergence_score') {
      emitConvergence({
        type: 'convergence_score',
        runId: String(json.run_id ?? ''),
        score: toConvergenceScore(json),
      });
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 逐块解析 SSE 流，yield EvaluationEvent */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<EvaluationEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) yield ev;
    }
  }
  if (buffer.trim()) {
    const ev = parseBlock(buffer);
    if (ev) yield ev;
  }
}

/**
 * 调用 MiniCPM-o 裁判（Host API 代理）。任何失败回退 Mock。
 */
export async function* evaluate(input: JudgeRunInput): AsyncIterable<EvaluationEvent> {
  try {
    const res = await hostApiStream('/api/evaluate/run', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`judge responded ${res.status}`);
    }
    yield* parseSseStream(res.body);
  } catch {
    // 离线 / 503 / 网络错误：回退客观 KPI 归一化
    yield* fallbackMock(input);
  }
}

/**
 * 离线回退：产出与真实裁判同构的事件流，不依赖网络。
 *
 * 雷达派生（诚实化口径，与 model-service `evaluator._derive_run_radar` 严格镜像）：
 * - cost 维始终由真实 usage 成本折算（预算 1.0 USD 为基准，越低越高分）；
 * - 有真实遥测（input.telemetry 非空）时，其余五维走 metricsEngine 客观 KPI 归一化；
 * - 无遥测但有 transcript 时，由「本次运行实际产出」的弱信号（体量/结构/具体性）折算，
 *   creativity 无法由弱信号判断，保持中性 2.5；
 * - 零证据时全维中性 2.5，明确标注「不可评」。
 *
 * 明确不做的事：**不再用 agentId 哈希派生分数**。
 * 哈希派生会让分数只与 id 字符串有关、与实际表现无关，等于把随机数当评测结论，
 * 也会让相同表现的 agent 因改名而分数变化。后端已废弃该做法，此处同步。
 */
export async function* fallbackMock(input: JudgeRunInput): AsyncIterable<EvaluationEvent> {
  const totalCost = input.usage.reduce(
    (sum, u) => sum + (u.costUsd ?? ((u.totalTokens ?? 0) / 1000) * 0.01),
    0,
  );
  const costScore = totalCost > 0 ? clamp(5 - (totalCost / 1.0) * 5, 0, 5) : NEUTRAL_SCORE;

  const hasTelemetry = (input.telemetry?.length ?? 0) > 0;
  const kpi = hasTelemetry ? computeKpi(input.telemetry ?? [], currentWindow()) : null;
  const signals = kpi ? null : transcriptSignals(input.transcript ?? '');

  let radar: RadarScore;
  let derivation: 'kpi' | 'transcript' | 'none';
  if (kpi) {
    // 真实遥测路径：客观 KPI 归一化到 0–5
    derivation = 'kpi';
    radar = {
      task: clamp(kpi.task_completion_rate * 5, 0, 5),
      quality: clamp(kpi.autonomy_rate * 5, 0, 5),
      comm: clamp((1 - kpi.escalation_rate) * 5, 0, 5),
      creativity: clamp(kpi.cross_task_generalization * 5, 0, 5),
      reliability: clamp(((1 - kpi.rework_rate) + kpi.stability_consistency) * 2.5, 0, 5),
      cost: costScore,
    };
  } else if (signals) {
    // transcript 弱信号路径（镜像后端 _derive_run_radar）
    derivation = 'transcript';
    radar = {
      task: clamp(1.5 + 3.5 * signals.volume, 0, 5),
      quality: clamp(1.5 + 3.5 * (0.5 * signals.structure + 0.5 * signals.specificity), 0, 5),
      comm: clamp(1.5 + 3.5 * signals.structure, 0, 5),
      // 创意无法从体量/结构判断，保持中性而非编造
      creativity: NEUTRAL_SCORE,
      reliability: clamp(1.5 + 3.5 * signals.specificity, 0, 5),
      cost: costScore,
    };
  } else {
    // 零证据：全维中性，不猜测
    derivation = 'none';
    radar = {
      task: NEUTRAL_SCORE,
      quality: NEUTRAL_SCORE,
      comm: NEUTRAL_SCORE,
      creativity: NEUTRAL_SCORE,
      reliability: NEUTRAL_SCORE,
      cost: costScore,
    };
  }

  const dims: Array<keyof RadarScore> = [
    'task',
    'quality',
    'comm',
    'creativity',
    'reliability',
    'cost',
  ];
  const dimEvidence = (dim: keyof RadarScore): string => {
    if (dim === 'cost') {
      return totalCost > 0 ? '真实 usage 成本折算' : 'cost 维无花费数据：中性基线 2.5，不可评';
    }
    if (derivation === 'kpi') return `客观 KPI 归一化（${dim}）`;
    if (derivation === 'transcript') {
      return dim === 'creativity'
        ? 'creativity 无法由弱信号判断：中性基线 2.5，不可评'
        : `${dim} 由本次运行 transcript 弱信号折算（未经模型评测）`;
    }
    return `${dim} 无任何证据：中性基线 2.5，不可评`;
  };
  for (const dim of dims) {
    await sleep(120);
    yield {
      type: 'radar_update',
      dim,
      score: round1(radar[dim]),
      // 降级路径的置信度必须显著低于真实评测（与后端 _stream_mock_run 的 0.35 同口径）
      confidence: derivation === 'kpi' ? 0.8 : 0.35,
      evidence: dimEvidence(dim),
      // E · 透明披露：离线回退路径标记为 degraded（外部裁判不可达）
      source: 'degraded',
    };
  }

  const avg = dims.reduce((s, d) => s + radar[d], 0) / dims.length;
  const verdict = avg >= 4 ? 'MVP' : avg >= 2.5 ? 'OBSERVE' : 'FIRED';
  const userFit = Math.round(avg * 20);
  // 证据留痕：诚实标注派生来源与不可评维度（对齐 model-service _run_radar_evidence）
  const evidenceTrace =
    derivation === 'kpi'
      ? [
          'source=degraded（外部裁判不可达，由本机客观 KPI 归一化）',
          `task_completion_rate=${((kpi as NonNullable<typeof kpi>).task_completion_rate * 100).toFixed(0)}%`,
          `autonomy_rate=${((kpi as NonNullable<typeof kpi>).autonomy_rate * 100).toFixed(0)}%`,
          `total_cost≈$${totalCost.toFixed(4)}`,
        ]
      : derivation === 'transcript'
        ? [
            'source=degraded（外部裁判不可达，未经模型评测）',
            `transcript 弱信号：体量=${signals!.volume.toFixed(2)} 结构=${signals!.structure.toFixed(2)} 具体性=${signals!.specificity.toFixed(2)}`,
            'creativity 维无法由弱信号判断，保持中性 2.5',
            `total_cost≈$${totalCost.toFixed(4)}`,
            `avg_radar=${avg.toFixed(2)}`,
          ]
        : [
            'source=degraded（外部裁判不可达，且无 transcript）',
            '全部能力维为中性基线 2.5，不可评',
            `total_cost≈$${totalCost.toFixed(4)}`,
          ];


  // 讲解文本（离线语音闭环：narration 由渲染层直接 TTS 播报）
  const DIM_LABELS: Record<keyof RadarScore, string> = {
    task: '任务完成',
    quality: '产出质量',
    comm: '沟通协作',
    creativity: '创造泛化',
    reliability: '稳定可靠',
    cost: '性价比',
  };
  const strongest = dims.reduce((a, b) => (radar[a] >= radar[b] ? a : b));
  const weakest = dims.reduce((a, b) => (radar[a] <= radar[b] ? a : b));
  const verdictLabel = verdict === 'MVP' ? 'MVP' : verdict === 'OBSERVE' ? '待观察' : 'You are fired';
  const narrationLines = [
    `${input.agentName ?? input.agentId} 的六维评估已完成。`,
    `最强维度是${DIM_LABELS[strongest]}（${radar[strongest].toFixed(1)} 分），最弱维度是${DIM_LABELS[weakest]}（${radar[weakest].toFixed(1)} 分）。`,
    `综合判定为${verdictLabel}。`,
  ];
  for (const line of narrationLines) {
    await sleep(120);
    yield { type: 'narration', delta: line, is_final: false };
  }
  yield { type: 'narration', delta: '', is_final: true };

  await sleep(150);
  yield {
    type: 'verdict',
    verdict,
    user_fit: userFit,
    evidence_trace: evidenceTrace,
    confidence: derivation === 'kpi' ? 0.8 : 0.35,
    source: 'degraded',
  };

  await sleep(100);
  yield { type: 'done', evaluation_id: `mock-${input.agentId}-${Date.now()}` };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function currentWindow(): string {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - oneJan.getTime()) / 86_400_000 + oneJan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 对话逐轮/整段评分结果（C：live 面试证据 → 模型评测） */
export interface ChatJudgeResult {
  /** judge = 模型评测；degraded = 启发式降级（前端应据此决定展示优先级） */
  source: 'judge' | 'degraded';
  /** 本次采样实际使用的裁判模型（后端回传；跨家族轮转时每次可能不同） */
  judgeModel?: string;
  /** 本次采样温度（0 = 可复现基准运行；>0 = ensemble 扰动运行） */
  temperature?: number;
  radar: RadarScore | null;
  verdict?: Verdict;
  confidence: number;
  evidence_trace: string[];
  /**
   * 裁判思维链 / 推理文本（后端 /api/chat-judge 透传）。
   * 供 metaJudge 做「推理-结论一致性」审计；未启用思考模式或降级时为空串/缺失。
   */
  reasoning?: string;
}

/**
 * A · 构建老板原型前缀（BossProfile 等价物，纯函数可单测）。
 * 把 BossProfile 翻译成裁判 prompt 的「评估上下文」段落，使裁判在
 * 「这位裁判的视角」下评估 Agent 行为（Wang 的个性化评估主张）。
 * 中性原型（id='neutral'）或无画像 → 返回空串（不污染离线基线评估）。
 */
export function buildPersonaPreamble(profile: BossProfile | null | undefined): string {
  if (!profile || profile.id === 'neutral') return '';
  const lines: string[] = [
    '[评估上下文 · 老板原型]',
    '你是正在评估这位 AI Agent 的「裁判」。请基于「从这位裁判的视角」，评估 Agent 在上述对话中的表现——尤其是它是否对齐该裁判的沟通风格、是否在约束下做出合理取舍、是否在风险情境下稳健。',
  ];
  if (profile.name) lines.push(`- 原型名：${profile.name}`);
  if (profile.domain) lines.push(`- 领域：${profile.domain}`);
  if (profile.experienceLevel) lines.push(`- 经验水平：${profile.experienceLevel}`);
  if (profile.riskAversion) lines.push(`- 风险偏好：${profile.riskAversion}`);
  if (profile.communicationStyle) lines.push(`- 沟通风格：${profile.communicationStyle}`);
  if (profile.constraintPrefs?.length) lines.push(`- 约束偏好：${profile.constraintPrefs.join('、')}`);
  return lines.join('\n');
}

/**
 * B · 构建历史协作上下文前缀（等价于历史协作注入，纯函数可单测）。
 * 把「与同一位 agent 的过往会话摘要」注入裁判上下文，使评估从离线/无状态升级为
 * 带记忆的状态化评估（Wang 的 sock-puppet + 交互历史主张）：同一 agent 在不同轮次
 * 里是否前后一致、是否记得此前约定，都应被纳入评判。空历史 → 返回空串。
 */
export function buildHistoryPreamble(history: string[] | null | undefined): string {
  if (!history || history.length === 0) return '';
  const lines: string[] = [
    '[评估上下文 · 历史协作]',
    '以下是你与此 agent 在此前的若干轮协作摘要（按时间正序）。请结合这些历史，评估它在本次对话中是否前后一致、是否记得此前的约定与边界：',
  ];
  history.forEach((h, i) => lines.push(`- 第 ${i + 1} 轮：${h}`));
  return lines.join('\n');
}

/**
 * D · 构建候选风格基线前缀（跨老板漂移检测，纯函数可单测）。
 * 把 agent 在「其他老板原型下」累积的风格基线注入裁判上下文，使裁判能评估
 * 本次回答风格相对该基线是否漂移（表述习惯 / 语气 / 结构一致性）——即「看人下菜」检测。
 * 与 Evaluation 层 StyleMemoryPanel 同源数据；跨老板漂移的*最终判定*由调用方用多 boss
 * 原型跑对比得出（本函数只负责把基线送进裁判上下文，不做跨老板比较）。
 */
export function buildStylePreamble(styleMemory: string): string {
  return [
    '【候选风格基线（跨老板）】',
    styleMemory,
    '请评估本次回答风格相对该基线是否漂移（表述习惯 / 语气 / 结构一致性）。',
  ].join('\n');
}

/**
 * C · 抗偏差评分准则前言（纯函数，可单测）。
 *
 * LLM-as-judge 存在位置/冗长/自我增强/权威等系统偏差（见 MT-Bench 2306.05685、
 * CALM 2410.02736）。后端 /api/chat-judge 是黑盒，但本函数把「抗偏差锚定」指令
 * 注入喂给裁判的 transcript 顶部（与 persona/history 前缀同机制），使裁判在评分时：
 *   1) 只看质量不看长度（对抗冗长/verbosity 偏差）；
 *   2) 每维独立判断、先理由后打分（对抗权威/锚定偏差）；
 *   3) 按 0/5 双端锚定打分（Prometheus 式 rubric，降低主观漂移）；
 *   4) 放弃自我增强偏好（不让"被评模型=裁判家族"抬高分数）。
 *
 * variant 用于维度顺序扰动：k 次 ensemble 各传不同 variant，使维度排列偏差被平均掉
 * （对抗维度顺序偏差），属自洽扰动（self-consistency perturbation）。
 */
export const JUDGE_RUBRIC_ANCHORS: Record<RadarDim, { low: string; high: string }> = {
  task: { low: '几乎没推进交付物', high: '清晰交付且可验收' },
  quality: { low: '含明显错误/遗漏', high: '准确且经得起推敲' },
  comm: { low: '答非所问/堆砌术语', high: '精准对齐裁判意图' },
  creativity: { low: '只有一种套路', high: '多路径且有取舍权衡' },
  reliability: { low: '无失败预案', high: '有回滚与发现机制' },
  cost: { low: '不计成本', high: '在约束内达到最优' },
};

/** 把维度顺序按 variant 旋转（variant=0 不旋转） */
function rotateDims(dims: RadarDim[], variant: number): RadarDim[] {
  if (variant <= 0) return dims;
  const shift = ((variant % dims.length) + dims.length) % dims.length;
  return [...dims.slice(shift), ...dims.slice(0, shift)];
}

export function buildJudgeRubricPreamble(variant = 0): string {
  const ordered = rotateDims(RADAR_DIMS, variant);
  const anchorLines = ordered.map(
    (dim, i) =>
      `   ${i + 1}. ${RADAR_DIM_LABELS[dim]}：0=${JUDGE_RUBRIC_ANCHORS[dim].low}；5=${JUDGE_RUBRIC_ANCHORS[dim].high}`,
  );
  return [
    '[评分准则 · 抗偏差锚定]',
    '你是严谨的面试官评委。请按以下准则独立给分：',
    '1. 只看回答质量，不看长度——长回答不自动高分，短而精准也可满分（对抗冗长偏好）。',
    '2. 先给理由后给分；每个维度独立判断，不要受其他维度牵连（对抗权威/锚定偏差）。',
    '3. 评分锚定（0=最差，5=最佳）：',
    ...anchorLines,
    '4. 不要因为回答来自某个模型家族就偏高或偏低（放弃自我增强偏好）。',
  ].join('\n');
}

/** 评委偏差审计结果（元评估的一部分，纯函数，可单测） */
export interface JudgeBiasAudit {
  /** 逐维 k 次评分极差（max−min），反映该维评委离散度 */
  perDimSpread: Record<RadarDim, number>;
  /** 各维极差均值 */
  meanSpread: number;
  /** 最大极差 */
  maxSpread: number;
  /** 是否存在任一维极差超过阈值（离散度过高→结论不稳定） */
  unstable: boolean;
}

/**
 * 审计 k 次重复裁判的离散度（对抗评委噪声/偏差的元评估）。
 * 若某维极差过大，说明评委对该维判断不稳定（可能受提示/顺序/噪声影响），
 * 调用方应下调置信并升级人工复核。
 */
export function auditJudgeBias(radars: RadarScore[], threshold = 1.5): JudgeBiasAudit {
  const runs = radars.filter((r): r is RadarScore => Boolean(r) && typeof r === 'object');
  const zero = RADAR_DIMS.reduce((acc, d) => {
    acc[d] = 0;
    return acc;
  }, {} as Record<RadarDim, number>);
  if (runs.length < 2) {
    return { perDimSpread: zero, meanSpread: 0, maxSpread: 0, unstable: false };
  }
  const perDimSpread = {} as Record<RadarDim, number>;
  for (const dim of RADAR_DIMS) {
    const vals = runs.map((r) => r[dim] ?? 0);
    const spread = Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10;
    perDimSpread[dim] = spread;
  }
  const spreads = RADAR_DIMS.map((d) => perDimSpread[d]);
  const meanSpread = Math.round((spreads.reduce((a, b) => a + b, 0) / spreads.length) * 10) / 10;
  const maxSpread = Math.max(...spreads);
  return { perDimSpread, meanSpread, maxSpread, unstable: maxSpread > threshold };
}

/**
 * 调用模型裁判对一段面试 transcript 评分（C 挂载点）。
 * 经 Host API 代理 POST /api/chat-judge；任何失败返回 null（调用方回退正则启发式）。
 * persona 非空时，自动在前缀注入老板原型上下文（不改后端字段名，向后兼容）；
 * history 非空时，注入历史协作上下文（状态化多轮评判）；
 * rubricVariant 同时承担两件事：
 *   1) 渲染层：旋转 rubric 的维度顺序，平均掉维度排列偏差；
 *   2) 后端：选择本次采样的模型与温度（variant=0 为温度 0 的可复现基准，
 *      variant>0 走 JUDGE_ENSEMBLE_TEMPERATURE 并按 JUDGE_MODELS 轮转家族）。
 * 二者合起来，k 次重复才是真正的重复测量，而不是同一份输出的复读。
 */
export async function judgeChat(
  agentId: string,
  transcript: string,
  persona?: BossProfile | null,
  history?: string[] | null,
  rubricVariant = 0,
  traceCtx?: { correlationId?: string; runId?: string },
  styleMemory?: string | null,
): Promise<ChatJudgeResult | null> {
  const runId = traceCtx?.runId ?? `judge-${agentId}-${Date.now()}`;
  const correlationId = traceCtx?.correlationId ?? runId;
  try {
    const personaPre = buildPersonaPreamble(persona);
    const historyPre = buildHistoryPreamble(history);
    const stylePre = styleMemory ? buildStylePreamble(styleMemory) : '';
    const rubricPre = buildJudgeRubricPreamble(rubricVariant);
    const preambles = [personaPre, historyPre, stylePre, rubricPre].filter(Boolean).join('\n\n');
    const fullTranscript = preambles ? `${preambles}\n\n${transcript}` : transcript;
    return await withTrace(
      { runId, correlationId, agentId, kind: 'judge', name: 'chat-judge' },
      async () => {
        // variant 决定后端用哪个模型与温度：0 = 可复现基准，>0 = 真实扰动采样。
        // 模型池与凭据留在后端，渲染层只递一个序号 —— 换裁判不必改前端。
        const json = await hostApiFetch<Record<string, unknown>>('/api/chat-judge', {
          method: 'POST',
          body: JSON.stringify({
            agent_id: agentId,
            transcript: fullTranscript,
            variant: rubricVariant,
          }),
        });
        const radar = json.radar;
        return {
          source: json.source === 'judge' ? 'judge' : 'degraded',
          radar: radar && typeof radar === 'object' ? (radar as RadarScore) : null,
          verdict: json.verdict as Verdict | undefined,
          confidence: Number(json.confidence ?? 0),
          evidence_trace: Array.isArray(json.evidence_trace)
            ? (json.evidence_trace as unknown[]).map(String)
            : [],
          judgeModel: typeof json.judge_model === 'string' ? json.judge_model : undefined,
          temperature: typeof json.temperature === 'number' ? json.temperature : undefined,
          // 裁判思维链：供 metaJudge 审计推理-结论一致性；空串/缺失时归一为 undefined
          reasoning: typeof json.reasoning === 'string' && json.reasoning.trim()
            ? json.reasoning
            : undefined,
        };
      },
    );
  } catch {
    return null;
  }
}

/**
 * Arena 个性化对决：POST /api/arena/compare。
 * 经 Host API 代理（127.0.0.1:3210）转发至 model-service；任何失败返回 null，
 * 调用方（arenaStore）据此展示降级提示（后端不可用 / 网络错误）。
 */
export async function arenaCompare(input: ArenaCompareInput): Promise<ArenaMatch | null> {
  try {
    return await hostApiFetch<ArenaMatch>('/api/arena/compare', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch {
    return null;
  }
}

/**
 * Arena 用户主观选择：POST /api/arena/user-pick。
 * 经 Host API 代理转发至 model-service；任何失败返回 null。
 */
export async function arenaUserPick(input: ArenaUserPickInput): Promise<ArenaPickResult | null> {
  try {
    return await hostApiFetch<ArenaPickResult>('/api/arena/user-pick', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch {
    return null;
  }
}

export const judgeClient = { evaluate, fallbackMock, judgeChat, arenaCompare, arenaUserPick };