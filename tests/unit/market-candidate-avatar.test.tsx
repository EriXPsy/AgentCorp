// @vitest-environment jsdom
/**
 * tests/unit/market-candidate-avatar.test.tsx
 *
 * 回归：市集卡片头像裂图（用户截图：所有卡片只剩 alt 文字）。
 * 根因一：Web 预览种子的 avatar 是 emoji（'⚙️'），被直接塞进 <img src>；
 * 根因二：Electron 模板的 avatar 是 dicebear CDN URL，网络不可达时裂图。
 * 修复（CandidateAvatar）：emoji 直接渲染文本；图片 onError 回落名字首字符色块。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { MarketCandidateView } from '@/types/marketplace';

afterEach(cleanup);

// 隔离重组件 / 外部副作用，专注头像逻辑
vi.mock('@/pages/Evaluation/RadarChart', () => ({ RadarChartView: () => null }));
vi.mock('@/components/marketplace/BossFavoriteBadge', () => ({ BossFavoriteBadge: () => null }));
vi.mock('@/stores/likesStore', () => ({
  useLikesStore: (
    selector: (s: { likes: object; toggling: object; hydrate: () => void; toggle: () => void }) => unknown,
  ) => selector({ likes: {}, toggling: {}, hydrate: () => {}, toggle: () => {} }),
  resolveLikeKey: () => 'k',
}));

import { MarketCandidateCard } from '@/components/marketplace/MarketCandidateCard';

function makeCandidate(avatar: string): MarketCandidateView {
  return {
    id: 'c1',
    name: 'Delta',
  } as unknown as MarketCandidateView;
}

function baseCandidate(avatar: string): MarketCandidateView {
  const c = makeCandidate(avatar);
  Object.assign(c, {
    name: 'Delta',
    description: '前端工程与性能优化',
    tags: ['代码审查'],
    price: '¥199/月',
  hiredCount: 0,
    rating: 0,
    hireType: 'single',
    avatar,
  jobType: null,
    match: null,
    radarResolution: { radar: null, source: 'none', stageScoreTotal: null, verdict: null },
  });
  return c;
}

const noop = () => {};

describe('MarketCandidateCard 头像兜底', () => {
  it('emoji 头像直接渲染文本，不渲染 img', () => {
    render(
      <MarketCandidateCard candidate={baseCandidate('⚙️')} onHire={noop} onPrescreen={noop} />,
    );
  expect(screen.getByText('⚙️')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('图片头像正常渲染 img', () => {
    render(
      <MarketCandidateCard
        candidate={baseCandidate('https://cdn.example.com/a.svg')}
        onHire={noop}
        onPrescreen={noop}
      />,
    );
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/a.svg');
  });

  it('图片加载失败（onError）→ 回落名字首字符，裂图消失', () => {
    render(
      <MarketCandidateCard
        candidate={baseCandidate('https://blocked.cdn.example.com/a.svg')}
        onHire={noop}
        onPrescreen={noop}
      />,
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('空头像 → 回落名字首字符（无头像时不裂图）', () => {
    const c = baseCandidate('');
    render(<MarketCandidateCard candidate={c} onHire={noop} onPrescreen={noop} />);
    expect(screen.getByText('D')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
