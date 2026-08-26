/**
 * src/types/craft.ts
 * 工种试做题（craft）契约层 —— 逐字段对齐 model-service 的
 * `app/scoring/craft_tasks.py` / `app/scoring/craft_judge.py`。
 *
 * 这条链路存在的理由：只看仓库 star 数的「初步印象」评分对个人上传的 agent
 * 系统性不公。试做题让所有候选做同一道题、走同一套 rubric，分数只取决于
 * 答案本身是否兑现了可核验要点。
 */

/** 一道试做题（题库不含参考答案，防刷题） */
export interface CraftTask {
  id: string;
  /** 与后端 registry 键一致：image / text / code */
  job_type: string;
  title: string;
  prompt: string;
  /** 本题重点考查的 craft 维 */
  target_dims: string[];
  /** 可核验要点，裁判逐条判定兑现与否 */
  checkpoints: string[];
}

/** 单条要点的判定结果 */
export interface CheckpointVerdict {
  checkpoint: string;
  hit: boolean;
  /** 支持该判定的答案原文片段；空串视为无证据 */
  quote: string;
}

/**
 * 沙盒真实执行结果（仅 code 工种）。镜像后端 `app/sandbox/runner.py` 的 SandboxResult。
 *
 * 与裁判分数是**两条独立证据链**：裁判说「这段代码看起来能跑」，沙盒说「这段代码
 * 真的跑了，4/4 用例通过」。两者可交叉验证，也可能互相打脸——那正是有价值的信号。
 */
export interface SandboxResult {
  /** passed=全通过 / failed=有失败或超时 / no_tests=没写用例 / no_code=没抽到代码 / error=沙盒故障 / disabled=未启用 */
  outcome: 'passed' | 'failed' | 'no_tests' | 'no_code' | 'error' | 'disabled';
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: { name: string; passed: boolean; detail: string }[];
  outputTail: string;
  reason: string;
  codeBytes: number;
  /** 是否真跑过用例（只有 true 才有资格解除 requiresReal 维的降权） */
  verifiable: boolean;
  /** 机器可核验证据文本，如「沙盒执行：4/4 用例通过（212ms）」 */
  evidence: string;
}

/** 一道试做题的裁判结果 */
export interface CraftJudgement {
  task_id: string;
  job_type: string;
  /** craft 维 → 分数（0–5，0.5 步进），仅含本题 target_dims */
  dims: Record<string, number>;
  /** 未被本题覆盖、因此不可评的维度（不补 0，避免「没考到」看起来像「考了但不好」） */
  unscored_dims: string[];
  checkpoints: CheckpointVerdict[];
  /** 空口承诺检测：题面探针命中即为 true */
  padding_detected: boolean;
  padding_note: string;
  confidence: number;
  /** 是否采用参考答案锚定 */
  reference_used: boolean;
  /** 首 token 时延（ms），TTFT 口径 */
  ttft_ms: number | null;
  latency_ms: number;
  backend: string;
  /**
   * 机器可核验证据（craft 维 → 证据文本）。只有真实执行/扫描产出的条目才会出现，
   * 裁判引文不在此列——那是 checkpoints[].quote 的职责。
   * 空对象 = 未验证，下游 stage_scorer 会继续对 requiresReal 维降权 ×0.4。
   */
  verified_evidence?: Record<string, string>;
  /** 沙盒执行详情（非 code 工种或未启用时为 null） */
  sandbox?: SandboxResult | null;
  /**
   * 降级标记：judge 后端不可用时后端返回 200 + degraded=true，
   * 机器证据（sandbox / security_scan / verified_evidence）仍然有效，
   * 但 dims 为空、confidence=0——LLM 评分不可用。前端据此展示
   * 「机器验证通过 / LLM 评分不可用」，不当作完整评测、也不补 0 分。
   */
  degraded?: boolean;
  degraded_reason?: string;
}

/** 评分入参 */
export interface CraftJudgeInput {
  task_id: string;
  answer?: string;
  candidate?: Record<string, unknown>;
  /** 是否执行真实沙盒验证（默认 true；后端另有 SANDBOX_ENABLED 总开关） */
  verify?: boolean;
}
