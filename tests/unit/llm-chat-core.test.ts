/**
 * api/_llm-core 单元测试（平台无关核心：vite 中间件与 Vercel 函数共用）。
 * 注入 fetchImpl 打桩上游，不触网。
 */
import { describe, expect, it } from 'vitest';
import { handleLlmChat } from '../../api/_llm-core';

const ENV = {
  LLM_API_KEY: 'sk-test',
  LLM_BASE_URL: 'https://llm.example.com/v1',
  LLM_MODEL: 'test-model',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('handleLlmChat 入参校验', () => {
  it('缺配置 → 503 llm_not_configured（不触网）', async () => {
    const fetchMock = async () => {
      throw new Error('不应被调用');
    };
    const r = await handleLlmChat('{"message":"hi"}', {}, fetchMock as typeof fetch);
    expect(r.status).toBe(503);
    expect(r.payload.error).toBe('llm_not_configured');
  });

  it('ASCEND_* 可作为 LLM_* 缺省回退', async () => {
    let calledUrl = '';
    const fetchMock = async (url: unknown) => {
      calledUrl = String(url);
      return jsonResponse(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    const r = await handleLlmChat(
      '{"message":"hi"}',
      { ASCEND_API_KEY: 'k', ASCEND_BASE_URL: 'https://ascend.example.com/v1/', ASCEND_MODEL: 'm' },
      fetchMock as typeof fetch,
    );
    expect(r.status).toBe(200);
    // baseUrl 末尾斜杠被规整
    expect(calledUrl).toBe('https://ascend.example.com/v1/chat/completions');
  });

  it('空 message → 400 empty_message', async () => {
    const r = await handleLlmChat('{"message":"  "}', ENV);
    expect(r.status).toBe(400);
    expect(r.payload.error).toBe('empty_message');
  });

  it('非法 JSON → 400 invalid_json', async () => {
    const r = await handleLlmChat('{不是JSON', ENV);
    expect(r.status).toBe(400);
    expect(r.payload.error).toBe('invalid_json');
  });

  it('messages[] 全空 → 400 empty_message', async () => {
    const r = await handleLlmChat({ messages: [{ role: 'user', content: '  ' }] }, ENV);
    expect(r.status).toBe(400);
    expect(r.payload.error).toBe('empty_message');
  });
});

describe('handleLlmChat 上游交互', () => {
  it('单条 message + system → 组装 messages 并取 content', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        choices: [{ message: { content: '真实回答' }, finish_reason: 'stop' }],
        usage: { total_tokens: 10 },
        model: 'upstream-model',
      });
    };
    const r = await handleLlmChat({ system: 'sys', message: 'hi', maxTokens: 64 }, ENV, fetchMock as typeof fetch);
    expect(r.status).toBe(200);
    expect(r.payload).toMatchObject({
      content: '真实回答',
      finishReason: 'stop',
      usage: { total_tokens: 10 },
      model: 'upstream-model',
    });
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(sentBody.max_tokens).toBe(64);
    expect(sentBody.stream).toBe(false);
  });

  it('content 为空时兜底 reasoning_content（推理模型）', async () => {
    const fetchMock = async () =>
      jsonResponse(200, { choices: [{ message: { content: '', reasoning_content: '推理产出' } }] });
    const r = await handleLlmChat('{"message":"hi"}', ENV, fetchMock as typeof fetch);
    expect(r.status).toBe(200);
    expect(r.payload.content).toBe('推理产出');
  });

  it('上游非 2xx → 502 upstream_error 透传状态与细节', async () => {
    const fetchMock = async () => jsonResponse(429, { error: { message: 'rate limited' } });
    const r = await handleLlmChat('{"message":"hi"}', ENV, fetchMock as typeof fetch);
    expect(r.status).toBe(502);
    expect(r.payload.error).toBe('upstream_error');
    expect(r.payload.status).toBe(429);
  });

  it('fetch 抛异常 → 500 proxy_failure', async () => {
    const fetchMock = async () => {
      throw new Error('network down');
    };
    const r = await handleLlmChat('{"message":"hi"}', ENV, fetchMock as typeof fetch);
    expect(r.status).toBe(500);
    expect(r.payload.error).toBe('proxy_failure');
    expect(String(r.payload.detail)).toContain('network down');
  });
});
