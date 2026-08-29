/**
 * src/engine/llm/streaming-reveal.ts
 * 全文兜底分段揭示（伪流式）。
 *
 * 背景：/api/llm/chat 代理（vite-plugin-llm-proxy）写死 `stream: false`，
 * 只回完整 JSON，没有 SSE 分片。为了让「leader 回复」有流式观感，
 * 前端拿到全文后按标点/段落切片，以固定间隔逐段 reveal；
 * 对调用方的接口（onDelta 累积回调）与未来真流式路径保持一致。
 */

/** 切分边界：中英文句读标点与换行；单片超过 maxLen 硬切（防长段落无标点憋死）。 */
const REVEAL_BOUNDARY = /[。！？!?；;，,、：:\n]/;

export function splitForReveal(text: string, maxLen = 24): string[] {
  const chunks: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (REVEAL_BOUNDARY.test(ch) || buf.length >= maxLen) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * 逐段揭示：每 intervalMs 把累积文本回调一次（单调递增，末次即全文）。
 * 返回 { done, cancel }；cancel 立即停表并 resolve done（调用方不等剩余片段）。
 */
export function revealText(
  text: string,
  onDelta: (accumulated: string) => void,
  intervalMs = 30,
): { done: Promise<void>; cancel: () => void } {
  const chunks = splitForReveal(text);
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    resolveDone();
  };
  if (chunks.length === 0) {
    onDelta('');
    finish();
    return { done, cancel: finish };
  }
  let i = 0;
  let acc = '';
  timer = setInterval(() => {
    acc += chunks[i];
    i += 1;
    onDelta(acc);
    if (i >= chunks.length) finish();
  }, intervalMs);
  return { done, cancel: finish };
}
