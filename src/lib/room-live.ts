/**
 * src/lib/room-live.ts
 * 团队房间「直播中」实况的展示辅助（纯函数，可单测）。
 * 实况数据本体在 teams store 的 roomLive（内存态，不落盘）。
 */

/** 编排阶段 → 房间实况气泡的中文标签。 */
export const ROOM_LIVE_PHASE_LABELS: Record<string, string> = {
  decompose: '拆解任务',
  assign: '分派任务',
  kickoff: '开工确认',
  execute: '执行任务',
  review: '审阅产出',
  'cross-review': '交叉评审',
  replan: '重规划',
  summarize: '汇总交付',
};

export function roomLivePhaseLabel(phase: string): string {
  return ROOM_LIVE_PHASE_LABELS[phase] ?? phase;
}
