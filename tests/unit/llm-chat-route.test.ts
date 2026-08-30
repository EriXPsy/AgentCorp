/**
 * tests/unit/llm-chat-route.test.ts
 *
 * electron/api/routes/llm-chat.ts（引擎真实执行 LLM 转发）单测：
 * - 上游解析优先级：env LLM_* → env ASCEND_* → provider 默认账号 → 503
 * - 消息规整：{messages[]} 优先 / {system,message} / 空消息 400
 * - 非流式：body 转发（stream:false）、鉴权头、响应映射、上游错误 502
 * - 流式：stream:true 且上游回 SSE 时透传 text/event-stream 分片
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

// provider 注册表替身：默认无配置（各用例按需覆盖）
const getDefaultProviderMock = vi.fn(async () => undefined as string | undefined);
const getProviderMock = vi.fn(async () => null as unknown);
const getApiKeyMock = vi.fn(async () => null as string | null);

vi.mock('@electron/utils/secure-storage', () => ({
  getDefaultProvider: (...args: unknown[]) => getDefaultProviderMock(...(args as [])),
  getProvider: (...args: unknown[]) => getProviderMock(...(args as [])),
  getApiKey: (...args: unknown[]) => getApiKeyMock(...(args as [])),
}));

import { handleLlmChatRoutes } from '@electron/api/routes/llm-chat';
import type { HostApiContext } from '@electron/api/context';

const ctx = {} as HostApiContext;

function makeReq(method: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(stream, { method, headers: {} }) as unknown as IncomingMessage;
}

interface Captured {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  chunks: string[];
  contentType?: string;
}

function makeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, payload: undefined, chunks: [] };
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      if (name.toLowerCase() === 'content-type') captured.contentType = value;
    },
    write: (data: Buffer | string) => {
      captured.chunks.push(String(data));
      return true;
    },
    end(data?: unknown) {
      captured.status = res.statusCode;
      if (typeof data === 'string' && data && captured.contentType?.includes('json')) {
        captured.payload = JSON.parse(data);
      } else if (typeof data === 'string' && data) {
        captured.payload = JSON.parse(data);
      }
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

async function call(method: string, rawUrl: string, body?: unknown) {
  const { res, captured } = makeRes();
  const handled = await handleLlmChatRoutes(
    makeReq(method, body),
    res,
    new URL(rawUrl, 'http://127.0.0.1:3210'),
    ctx,
  );
  return { handled, ...captured };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of events) controller.enqueue(encoder.encode(ev));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

beforeEach(() => {
  vi.stubEnv('LLM_BASE_URL', '');
  vi.stubEnv('LLM_API_KEY', '');
  vi.stubEnv('LLM_MODEL', '');
  vi.stubEnv('ASCEND_BASE_URL', '');
  vi.stubEnv('ASCEND_API_KEY', '');
  vi.stubEnv('ASCEND_MODEL', '');
  getDefaultProviderMock.mockReset().mockResolvedValue(undefined);
  getProviderMock.mockReset().mockResolvedValue(null);
  getApiKeyMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('路由匹配与方法', () => {
  it('非 /api/llm/chat 路径不接管', async () => {
    const { handled } = await call('GET', '/api/other');
    expect(handled).toBe(false);
  });

  it('GET /api/llm/chat → 405', async () => {
    const { handled, status, payload } = await call('GET', '/api/llm/chat');
    expect(handled).toBe(true);
    expect(status).toBe(405);
    expect(payload.error).toBe('method_not_allowed');
  });
});

describe('上游解析优先级', () => {
  it('env LLM_* 齐全 → 直连 env 端点，带 Bearer 头，stream:false', async () => {
    vi.stubEnv('LLM_BASE_URL', 'http://ascend-host:8000/v1');
    vi.stubEnv('LLM_API_KEY', 'sk-env');
    vi.stubEnv('LLM_MODEL', 'deepseek-r1');
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
      usage: { total_tokens: 3 },
      model: 'deepseek-r1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { status, payload } = await call('POST', '/api/llm/chat', {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(status).toBe(200);
    expect(payload.content).toBe('你好');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ascend-host:8000/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-env');
    expect(JSON.parse(String(init.body)).stream).toBe(false);
  });

  it('env 缺失、provider 默认账号为 openai-completions → 走 provider 配置', async () => {
    getDefaultProviderMock.mockResolvedValue('p-ascend');
    getProviderMock.mockResolvedValue({
      id: 'p-ascend',
      name: '昇腾',
      type: 'huawei-ascend',
      baseUrl: 'http://npu.local:8080/v1/',
      apiProtocol: 'openai-completions',
      model: 'qwen2.5-32b',
    });
    getApiKeyMock.mockResolvedValue('sk-ascend');
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { status, payload } = await call('POST', '/api/llm/chat', { message: 'ping' });

    expect(status).toBe(200);
    expect(payload.content).toBe('ok');
    expect(payload.model).toBe('qwen2.5-32b');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://npu.local:8080/v1/chat/completions'); // 末尾斜杠规整
  });

  it('provider 为非 openai-completions 协议 → 不转发，503', async () => {
    getDefaultProviderMock.mockResolvedValue('p-claude');
    getProviderMock.mockResolvedValue({
      id: 'p-claude',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiProtocol: 'anthropic-messages',
      model: 'claude',
    });

    const { status, payload } = await call('POST', '/api/llm/chat', { message: 'hi' });
    expect(status).toBe(503);
    expect(payload.error).toBe('llm_not_configured');
  });

  it('env 与 provider 都缺失 → 503 llm_not_configured', async () => {
    const { status, payload } = await call('POST', '/api/llm/chat', { message: 'hi' });
    expect(status).toBe(503);
    expect(payload.error).toBe('llm_not_configured');
  });
});

describe('消息规整与错误映射', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_BASE_URL', 'http://x/v1');
    vi.stubEnv('LLM_API_KEY', 'k');
    vi.stubEnv('LLM_MODEL', 'm');
  });

  it('空消息 → 400 empty_message', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { status, payload } = await call('POST', '/api/llm/chat', { message: '   ' });
    expect(status).toBe(400);
    expect(payload.error).toBe('empty_message');
  });

  it('上游非 2xx → 502 upstream_error，detail 透传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)));
    const { status, payload } = await call('POST', '/api/llm/chat', { message: 'hi' });
    expect(status).toBe(502);
    expect(payload.error).toBe('upstream_error');
    expect(payload.status).toBe(429);
  });

  it('上游不可达 → 502 upstream_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { status, payload } = await call('POST', '/api/llm/chat', { message: 'hi' });
    expect(status).toBe(502);
    expect(payload.error).toBe('upstream_unreachable');
  });

  it('content 为空时回退 reasoning_content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: '', reasoning_content: '思考链产出' }, finish_reason: 'stop' }],
    })));
    const { payload } = await call('POST', '/api/llm/chat', { message: 'hi' });
    expect(payload.content).toBe('思考链产出');
  });
});

describe('SSE 流式透传', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_BASE_URL', 'http://x/v1');
    vi.stubEnv('LLM_API_KEY', 'k');
    vi.stubEnv('LLM_MODEL', 'm');
  });

  it('stream:true 且上游回 SSE → 分片原样透传，content-type 为 text/event-stream', async () => {
  const events = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

    const { status, chunks, contentType } = await call('POST', '/api/llm/chat', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(status).toBe(200);
    expect(contentType).toBe('text/event-stream');
    expect(chunks.join('')).toBe(events.join(''));
    // 上游请求体带 stream:true
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).stream).toBe(true);
  });

  it('stream:true 但上游回 JSON（不支持流式）→ 回退非流式 JSON 契约', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: '全文' }, finish_reason: 'stop' }],
    })));

    const { status, payload, contentType } = await call('POST', '/api/llm/chat', {
      message: 'hi',
      stream: true,
    });

    expect(status).toBe(200);
    expect(contentType).toContain('json');
    expect(payload.content).toBe('全文');
  });
});
