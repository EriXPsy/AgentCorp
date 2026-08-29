/**
 * src/stores/teamRoomBroadcast.ts
 * 协作过程实时广播（P0-3）：把多成员编排过程中的里程碑 A2A trace
 * 转发到团队房间消息流，让房间里能实时看到「拆解 / 指派 / 审阅 /
 * 改派 / 开工确认 / 交叉评审 / 重规划 / 汇总交付」等关键节点。
 * 非里程碑（成员回交产出等高频事件）不转发，避免刷屏。
 * 广播失败静默吞掉，绝不影响编排主流程。
 */
import { useTeamsStore } from '@/stores/teams';
import type { A2aTraceRecord } from '@/types/evaluation';

/** 里程碑 trace 判定（纯函数，导出便于单测）。 */
export function isMilestoneTrace(trace: A2aTraceRecord): boolean {
  const s = trace.summary;
  return (
    s.startsWith('Leader 拆解') ||
    s.includes('指派给') ||
    s.includes('Leader 审阅') ||
    trace.state === 'failed' ||
    s.includes('改派') ||
    s.includes('汇总交付') ||
    s.includes('重规划') ||
    s.includes('开工确认') ||
    s.includes('交叉评审') ||
    // P2 放宽：成员回交产出也进房间（每子任务每轮一条，有界不刷屏；
    // 高频中间态由 roomLive 直播槽位承担，只更新不追加）
    s.includes('成员回交产出')
  );
}

/**
 * 构造房间转发器：里程碑 trace → 团队房间消息。
 * from 取 trace.delegator 剥掉 `agent:` 前缀；`team:` 开头则用团队 leaderId
 * （查不到团队时保留 delegator 原文）。to 固定 'team'，content 为 trace.summary。
 */
export function createRoomTraceForwarder(teamId: string): (trace: A2aTraceRecord) => void {
  return (trace) => {
    if (!isMilestoneTrace(trace)) return;
    let from = trace.delegator;
    if (from.startsWith('agent:')) {
      from = from.slice('agent:'.length);
    } else if (from.startsWith('team:')) {
      const team = useTeamsStore.getState().teams.find((t) => t.id === teamId);
      from = team?.leaderId ?? from;
    }
    void useTeamsStore
      .getState()
      .appendTeamChatEvent(teamId, { from, to: 'team', content: trace.summary })
      .catch(() => { /* 房间广播失败不阻塞编排 */ });
  };
}
