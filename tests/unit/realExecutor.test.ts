/**
 * tests/unit/realExecutor.test.ts
 *
 * runRealChat（src/engine/llm/realExecutor.ts）行为验证：
 * - 上游挂起时按 timeoutMs 中止，抛出带明确中文信息的超时错误
 *   （修复前裸 fetch 无 AbortSignal，发送态会永久卡死）；
 * - 请求携带 AbortSignal；
 * - 正常返回 / 上游报错 / 空产出的既有语义不变。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REAL_CHAT_DEFAULT_TIMEOUT_MS, runRealChat } from '@/engine/llm/realExecutor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runRealChat 超时', () => {
  it('上游挂起时按注入的短 timeout 抛出中文超时错误，不会永久等待', async () => {
    // mock 一个永不 resolve、但响应 abort 的 fetch（模拟上游挂起）
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation timed out.', 'TimeoutError'));
      });
    })));

    await expect(
      runRealChat([{ role: 'user', content: 'hi' }], 2048, 50),
    ).rejects.toThrow('模型响应超时');
  });

  it('默认超时常量为 120s，且请求携带 AbortSignal', async () => {
    expect(REAL_CHAT_DEFAULT_TIMEOUT_MS).toBe(120_000);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({ content: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await runRealChat([{ role: 'user', content: 'hi' }]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('超时错误信息包含秒数（可读的等待时长）', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation timed out.', 'TimeoutError'));
      });
    })));

    await expect(
      runRealChat([{ role: 'user', content: 'hi' }], 2048, 3000),
    ).rejects.toThrow('模型响应超时（3s），请重试');
  });
});

describe('runRealChat 既有语义', () => {
  it('正常返回 content（trim 后）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ content: '  你好，老板  ' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(runRealChat([{ role: 'user', content: 'hi' }])).resolves.toBe('你好，老板');
  });

  it('上游非 2xx 抛出带状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'upstream', detail: 'boom' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(runRealChat([{ role: 'user', content: 'hi' }])).rejects.toThrow('真实执行失败（502');
  });

  it('空产出抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ content: '   ' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(runRealChat([{ role: 'user', content: 'hi' }])).rejects.toThrow('空产出');
  });
});

describe('runRealChat 流式兜底（onDelta）', () => {
  it('拿到全文后逐段 reveal：onDelta 累积单调递增、末次即全文、返回值不变', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ content: '第一段。第二段，第三段！' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const seen: string[] = [];
    const result = await runRealChat([{ role: 'user', content: 'hi' }], 2048, 10_000, undefined, {
      onDelta: (acc) => seen.push(acc),
      revealIntervalMs: 1,
    });

    expect(result).toBe('第一段。第二段，第三段！');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(result);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].startsWith(seen[i - 1])).toBe(true);
    }
  });

  it('不传 stream 选项时 fetch 只调一次、直接返回（既有行为不变）', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ content: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runRealChat([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
