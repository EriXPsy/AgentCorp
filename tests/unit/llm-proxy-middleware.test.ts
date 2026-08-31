/**
 * tests/unit/llm-proxy-middleware.test.ts
 *
 * vite-plugin-llm-proxy 中间件行为单测：
 * - env 解析：LLM_* 优先，缺失时回退 ASCEND_*（昇腾端点快捷配置）
 * - 未配置 → 503 llm_not_configured
 * - 非 POST → 405；转发 body 含 stream:false 与模型名；响应映射 content
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { llmProxyPlugin } from '../../vite-plugin-llm-proxy';

type Middleware = (req: IncomingMessage, res: ServerResponse, next?: () => void) => Promise<void>;

function getMiddleware(): Middleware {
  const plugin = llmProxyPlugin();
  let middleware: Middleware | null = null;
  const fakeServer = {
    middlewares: {
      use: (_path: string, fn: Middleware) => {
        middleware = fn;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin.configureServer as (s: unknown) => void)(fakeServer as any);
  if (!middleware) throw new Error('middleware not registered');
  return middleware;
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(stream, { method, headers: {} }) as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; captured: { status: number; payload: Record<string, unknown> } } {
  const captured = { status: 0, payload: {} as Record<string, unknown> };
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end(data?: unknown) {
      captured.status = res.statusCode;
      if (typeof data === 'string' && data) captured.payload = JSON.parse(data);
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

beforeEach(() => {
  for (const k of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'ASCEND_API_KEY', 'ASCEND_BASE_URL', 'ASCEND_MODEL']) {
    vi.stubEnv(k, '');
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('env 解析与配置缺失', () => {
  it('LLM_* 与 ASCEND_* 都缺失 → 503 llm_not_configured', async () => {
    const { res, captured } = makeRes();
    await getMiddleware()(makeReq('POST', { message: 'hi' }), res);
    expect(captured.status).toBe(503);
    expect(captured.payload.error).toBe('llm_not_configured');
  });

  it('仅 ASCEND_* 配置 → 回退使用昇腾端点转发', async () => {
    vi.stubEnv('ASCEND_BASE_URL', 'http://npu:8000/v1');
    vi.stubEnv('ASCEND_API_KEY', 'sk-asc');
    vi.stubEnv('ASCEND_MODEL', 'qwen2.5-7b');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { res, captured } = makeRes();
    await getMiddleware()(makeReq('POST', { message: 'ping' }), res);

    expect(captured.status).toBe(200);
    expect(captured.payload.content).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://npu:8000/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-asc');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('qwen2.5-7b');
    expect(body.stream).toBe(false);
  });

  it('LLM_* 优先于 ASCEND_*', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://llm/v1');
    vi.stubEnv('LLM_API_KEY', 'sk-llm');
    vi.stubEnv('LLM_MODEL', 'm-llm');
    vi.stubEnv('ASCEND_BASE_URL', 'http://asc/v1');
    vi.stubEnv('ASCEND_API_KEY', 'sk-asc');
    vi.stubEnv('ASCEND_MODEL', 'm-asc');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { res } = makeRes();
    await getMiddleware()(makeReq('POST', { message: 'ping' }), res);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://llm/v1/chat/completions');
  });
});

describe('方法与入参', () => {
  it('GET → 405 method_not_allowed', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://x/v1');
    vi.stubEnv('LLM_API_KEY', 'k');
    vi.stubEnv('LLM_MODEL', 'm');
    const { res, captured } = makeRes();
    await getMiddleware()(makeReq('GET'), res);
    expect(captured.status).toBe(405);
  });

  it('空消息 → 400 empty_message', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://x/v1');
    vi.stubEnv('LLM_API_KEY', 'k');
    vi.stubEnv('LLM_MODEL', 'm');
    vi.stubGlobal('fetch', vi.fn());
    const { res, captured } = makeRes();
    await getMiddleware()(makeReq('POST', { message: '  ' }), res);
    expect(captured.status).toBe(400);
    expect(captured.payload.error).toBe('empty_message');
  });
});
