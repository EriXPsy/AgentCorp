/**
 * src/engine/llm/modelAdapter.ts
 * 推理模型注册表（M3a · DSH 式 Agent 的「可切换大模型」原语）
 * --------------------------------------------------------------------------
 * Agent = 大模型 + Harness。Harness（RoleCard 的 skills / ownsPhases / boundaries）
 * 决定「怎么评估」，与「用哪个大模型推理」正交。ModelAdapter 让推理模型可插拔：
 *   - 'inherited'：透传到既有 /api/llm/chat（realExecutor 已支持 Ark / Claude /
 *     Deepseek / MiniCPM-o），即「换裁判不必改前端」。
 *   - 'claude' / 'deepseek' / 'minicpm-o'：显式指定推理后端。
 *
 * 切换点已分散在 /api/llm/chat（前端 realExecutor）与 JUDGE_BACKEND（后端 variant
 * 轮转）。本注册表把它们收口为一个可枚举、可测试、可经 RoleCard.model 引用的契约，
 * 使「推理模型可切换而评估方式（Harness）不变」成为 enforced 事实。
 */
import { ContractViolation } from "../contracts";

export interface ModelInput {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** 透传给宿主运行时的可选元数据（如 variant 轮转、后端选择） */
  meta?: Record<string, unknown>;
}

export interface ModelOutput {
  text: string;
  /** 用量 / 元数据（供 metricsEngine 折算 cost） */
  usage?: { promptTokens?: number; completionTokens?: number };
  meta?: Record<string, unknown>;
}

export interface ModelAdapter {
  readonly id: string;
  readonly label: string;
  chat(input: ModelInput): Promise<ModelOutput>;
}

const MODELS = new Map<string, ModelAdapter>();

export function registerModel(m: ModelAdapter): void {
  if (MODELS.has(m.id)) {
    throw new ContractViolation(`Model 重复注册：${m.id}`);
  }
  MODELS.set(m.id, m);
}

/** 取模型；未命中时回退到 'inherited'（默认透传既有 /api/llm/chat 链路）。 */
export function getModel(id: string): ModelAdapter {
  return MODELS.get(id) ?? MODELS.get("inherited")!;
}

export function listModels(): ModelAdapter[] {
  return [...MODELS.values()];
}

/** 默认透传适配器：未显式注册特定模型时回退到既有宿主 LLM 链路。 */
export const INHERITED_ADAPTER: ModelAdapter = {
  id: "inherited",
  label: "继承宿主 /api/llm/chat 链路",
  chat: async () => {
    // 真实接线在 PR#44：经 realExecutor.runRealChat 透传；
    // 占位实现显式抛错，避免在未接线时被静默当成「空实现」误用。
    throw new ContractViolation(
      "inherited 适配器需要 realExecutor 接线（PR#44）；当前为契约占位",
    );
  },
};

registerModel(INHERITED_ADAPTER);
