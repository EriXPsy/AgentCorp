/**
 * OTel GenAI 语义映射（GOAI SP-09 · 2.3 可观测实证）
 * --------------------------------------------------------------------------
 * 把八步闭环的每一步 LoopStep 与每轮 token 用量投影成 OpenTelemetry GenAI
 * 语义约定（gen_ai.* 属性族），使评审方能直接对照 OTel 标准看 AgentCorp 的
 * 可观测性落地（无需引入 otel SDK，仅产出语义对齐的 span/metric 对象）。
 *
 * 映射关系（核心属性族）：
 *   gen_ai.agent.name      ← step.agentName（哪个 Agent 执行的）
 *   gen_ai.agent.role      ← step.agentRole（Agent 角色：boss/recruiter/evaluator/dispatcher）
 *   gen_ai.conversation.id ← ctx.conversationId（一次 Run = 一次会话 = 一条 trace）
 *   gen_ai.request.model   ← ctx.model（评委/模型标识，demo 用 'demo-judge'）
 *   gen_ai.operation.name  ← step.phase（八步闭环阶段）
 *   gen_ai.response.summary← step.summary（该步产出摘要）
 *   gen_ai.usage.*         ← token 估算（input/output/total/cost）
 */
import type { LoopStep } from '../closedLoop';

/** span 上下文：把一次 Run 的元信息喂给每一步的语义投影。 */
export interface GenAiSpanContext {
  /** 一次 Run = 一次会话，作为 OTel trace_id（对应 ATRun.runId） */
  conversationId: string;
  /** 评委 / 模型标识（demo 默认 'demo-judge'） */
  model: string;
  /** 执行该步的 Agent 名称（gen_ai.agent.name） */
  agentName: string;
  /** 执行该步的 Agent 角色（gen_ai.agent.role） */
  agentRole: string;
}

/** 投影出的 OTel 风格 span（不含 SDK 依赖，纯数据对象）。 */
export interface GenAiSpan {
  name: string;
  trace_id: string;
  span_id: string;
  attributes: Record<string, string | number | boolean>;
}

/**
 * 把单步 LoopStep 投影为 OTel GenAI span。
 * trace_id = conversationId（一次 Run 一条链路），span_id 用「链路:阶段:执行者」确保唯一。
 */
export function toGenAiSpan(step: LoopStep, ctx: GenAiSpanContext): GenAiSpan {
  return {
    name: `agent.${ctx.agentRole}.${step.phase}`,
    trace_id: ctx.conversationId,
    span_id: `${ctx.conversationId}:${step.phase}:${ctx.agentName}`,
    attributes: {
      'gen_ai.agent.name': ctx.agentName,
      'gen_ai.agent.role': ctx.agentRole,
      'gen_ai.conversation.id': ctx.conversationId,
      'gen_ai.request.model': ctx.model,
      'gen_ai.operation.name': step.phase,
      'gen_ai.response.summary': step.summary,
      'gen_ai.response.finish_reason': 'stop',
    },
  };
}

/** token 用量入参（估算，闭环无真实 token 计数，用字符数近似）。 */
export interface TokenEntry {
  conversationId: string;
  agentName: string;
  agentRole: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** 投影出的 OTel 风格 metric（token 用量与成本估算）。 */
export interface GenAiMetric {
  name: string;
  attributes: Record<string, string | number | boolean>;
  value: number;
}

/**
 * 把一轮 token 用量投影为 OTel GenAI metric。
 * cost 用统一估算单价（演示用，非真实计费）：
 *   total = input + output；cost = total × 单价（默认 1e-5 / token）。
 */
export function toGenAiMetric(entry: TokenEntry, unitCost = 1e-5): GenAiMetric {
  const total = entry.inputTokens + entry.outputTokens;
  return {
    name: 'gen_ai.token.usage',
    attributes: {
      'gen_ai.agent.name': entry.agentName,
      'gen_ai.agent.role': entry.agentRole,
      'gen_ai.conversation.id': entry.conversationId,
      'gen_ai.request.model': entry.model,
      'gen_ai.usage.input_tokens': entry.inputTokens,
      'gen_ai.usage.output_tokens': entry.outputTokens,
      'gen_ai.usage.total_tokens': total,
      'gen_ai.usage.cost': Number((total * unitCost).toFixed(6)),
    },
    value: total,
  };
}
