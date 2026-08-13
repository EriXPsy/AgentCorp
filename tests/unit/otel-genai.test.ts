import { describe, it, expect } from 'vitest';
import { toGenAiSpan, toGenAiMetric } from '@/demo/observability/otelGenai';
import type { LoopStep } from '@/demo/closedLoop';

/**
 * SP-09 OTel GenAI 语义映射实证：
 * LoopStep / token 用量投影为 OTel gen_ai.* 语义属性。
 */
describe('OTel GenAI 语义映射（SP-09）', () => {
  const step: LoopStep = {
    phase: 'tool',
    agentRole: 'evaluator',
    agentName: '评估中心',
    summary: '评估中心调用评委 3/3 次成功',
    payload: undefined,
    ts: 123456,
  };
  const ctx = {
    conversationId: 'run-abc',
    model: 'demo-judge',
    agentName: '评估中心',
    agentRole: 'evaluator',
  };

  it('toGenAiSpan 投影 gen_ai.* 语义属性', () => {
    const span = toGenAiSpan(step, ctx);
    expect(span.trace_id).toBe('run-abc');
    expect(span.name).toBe('agent.evaluator.tool');
    expect(span.attributes['gen_ai.agent.name']).toBe('评估中心');
    expect(span.attributes['gen_ai.agent.role']).toBe('evaluator');
    expect(span.attributes['gen_ai.conversation.id']).toBe('run-abc');
    expect(span.attributes['gen_ai.request.model']).toBe('demo-judge');
    expect(span.attributes['gen_ai.operation.name']).toBe('tool');
    expect(span.attributes['gen_ai.response.summary']).toBe('评估中心调用评委 3/3 次成功');
  });

  it('toGenAiMetric 投影 token 用量与成本估算', () => {
    const m = toGenAiMetric({
      conversationId: 'run-abc',
      agentName: '评估中心',
      agentRole: 'evaluator',
      model: 'demo-judge',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(m.name).toBe('gen_ai.token.usage');
    expect(m.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(m.attributes['gen_ai.usage.output_tokens']).toBe(5);
    expect(m.attributes['gen_ai.usage.total_tokens']).toBe(15);
    expect(m.value).toBe(15);
    expect(Number(m.attributes['gen_ai.usage.cost'])).toBeCloseTo(15 * 1e-5, 8);
  });
});
