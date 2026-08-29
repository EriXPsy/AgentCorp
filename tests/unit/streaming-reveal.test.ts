/**
 * tests/unit/streaming-reveal.test.ts
 *
 * 全文兜底分段揭示（src/engine/llm/streaming-reveal.ts）：
 * - splitForReveal 按中英文标点/换行切片，长片段按 maxLen 硬切；
 * - revealText 逐段累积回调（单调递增，末次即全文），done 在揭示完成后 resolve；
 * - cancel 立即停表并 resolve done。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { revealText, splitForReveal } from '@/engine/llm/streaming-reveal';

afterEach(() => {
  vi.useRealTimers();
});

describe('splitForReveal', () => {
  it('按中英文标点切片，切片拼接回原文', () => {
    const text = '你好，老板！这是第一段。\n第二段开始';
    const chunks = splitForReveal(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('')).toBe(text);
  });

  it('无标点长文按 maxLen 硬切', () => {
    const text = 'a'.repeat(50);
    const chunks = splitForReveal(text, 24);
    expect(chunks).toEqual(['a'.repeat(24), 'a'.repeat(24), 'aa']);
  });

  it('空文本返回空数组', () => {
    expect(splitForReveal('')).toEqual([]);
  });
});

describe('revealText', () => {
  it('逐段累积回调：单调递增，末次即全文，done 随后 resolve', async () => {
    vi.useFakeTimers();
    const text = '第一段。第二段，第三段！';
    const seen: string[] = [];
    const { done } = revealText(text, (acc) => seen.push(acc), 30);

    await vi.advanceTimersByTimeAsync(30 * 50);
    await done;

    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].startsWith(seen[i - 1])).toBe(true);
      expect(seen[i].length).toBeGreaterThan(seen[i - 1].length);
    }
    expect(seen[seen.length - 1]).toBe(text);
  });

  it('cancel 立即停表并 resolve done，之后不再回调', async () => {
    vi.useFakeTimers();
    const text = '一。二。三。四。五。六。七。八。';
    const seen: string[] = [];
    const { done, cancel } = revealText(text, (acc) => seen.push(acc), 30);

    await vi.advanceTimersByTimeAsync(30); // 走一段
    const before = seen.length;
    cancel();
    await done;
    await vi.advanceTimersByTimeAsync(30 * 100); // 剩余时间全部走完

    expect(seen.length).toBe(before); // 停表后无新增
    expect(seen[seen.length - 1]).not.toBe('一。二。三。四。五。六。七。八。');
  });

  it('空文本：回调一次空串并立即完成', async () => {
    const seen: string[] = [];
    const { done } = revealText('', (acc) => seen.push(acc));
    await done;
    expect(seen).toEqual(['']);
  });
});
