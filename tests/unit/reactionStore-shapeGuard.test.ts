/**
 * tests/unit/reactionStore-shapeGuard.test.ts
 *
 * 回归：Vercel 白屏（Cannot read properties of undefined (reading 'find')）。
 * hostApiFetch 不校验 HTTP 状态码 —— 静态托管下 /api/favorites、/api/likes/*
 * 不存在时，404 的 HTML/错误 JSON 会被当成功结果返回（truthy 但无期望字段），
 * 下游 BossFavoriteBadge 的 `ranking.ranking.find` 与 marketplace store 的
 * `ranking.ranking.forEach` 直接炸掉整页。
 * 修复：getFavorites / getLike 采信前先校验响应形状，不符按失败走回落。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron-store', () => {
  class FakeStore {
    private data = new Map<string, unknown>();
    set(key: string, val: unknown) {
      this.data.set(key, val);
    }
    get(key: string) {
      return this.data.get(key);
    }
  }
  return { default: FakeStore };
});

// 模拟浏览器预览（Web 预览回落分支：空榜 / 零态，不碰 electron-store）
vi.mock('@/lib/browser-preview', () => ({
  isBrowserPreviewMode: () => true,
}));

const hostApiFetchMock = vi.fn();
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

type ReactionStoreModule = typeof import('@/services/reactionStore');
let reactionStore: ReactionStoreModule;

beforeEach(async () => {
  vi.resetModules();
  hostApiFetchMock.mockReset();
  reactionStore = await import('@/services/reactionStore');
});

describe('getFavorites 响应形状守卫（Vercel 404 回归）', () => {
  it('返回 404 HTML 文本（string）→ 回落空榜，不透出垃圾', async () => {
    hostApiFetchMock.mockResolvedValue('<!doctype html><html>...404...</html>');
    const r = await reactionStore.getFavorites('code');
    expect(r).toEqual({ jobType: 'code', ranking: [] });
  });

  it('返回错误 JSON（无 ranking 数组）→ 回落空榜', async () => {
    hostApiFetchMock.mockResolvedValue({ error: { code: 'NOT_FOUND' } });
    const r = await reactionStore.getFavorites('code');
    expect(r).toEqual({ jobType: 'code', ranking: [] });
  });

  it('返回合法形状 → 原样采信', async () => {
    const good = { jobType: 'code', ranking: [{ agentId: 'a1', count: 3, voters: [], updatedAt: 't' }] };
    hostApiFetchMock.mockResolvedValue(good);
    const r = await reactionStore.getFavorites('code');
    expect(r).toBe(good);
  });
});

describe('getLike 响应形状守卫', () => {
  it('返回 404 HTML 文本 → 回落零态', async () => {
    hostApiFetchMock.mockResolvedValue('<!doctype html>...');
    const rec = await reactionStore.getLike('agent-x');
    expect(rec.agentId).toBe('agent-x');
    expect(rec.count).toBe(0);
    expect(rec.likedByMe).toBe(false);
  });

  it('返回合法 LikeRecord → 原样采信', async () => {
    const good = { agentId: 'agent-x', count: 5, likedByMe: true, users: [], updatedAt: 't' };
    hostApiFetchMock.mockResolvedValue(good);
    const rec = await reactionStore.getLike('agent-x');
    expect(rec).toBe(good);
  });
});
