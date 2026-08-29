/**
 * src/components/chat/TeamLiveBubbles.tsx
 * 团队房间「直播中」实况气泡：编排运行时，每个正在工作的成员各占一个槽位
 * （多成员并发互不覆盖），显示 头像 + 名字·角色 + 阶段中文标签 + 呼吸点动画 +
 * 当前进展摘要。数据来自 teams store 的 roomLive（内存态）；
 * 成员的正式消息落房间后槽位被清除，直播气泡随之消失（被正式气泡取代）。
 */
import { AgentAvatar } from '@/components/chat/AgentAvatar';
import { roomLivePhaseLabel } from '@/lib/room-live';
import { memberRoleLabel } from '@/lib/team-roster';
import type { RoomLiveEntry } from '@/stores/teams';
import type { AgentSummary } from '@/types/agent';

export function TeamLiveBubbles({
  live,
  members,
}: {
  /** agentId → 当前实况（teams store roomLive[teamId]） */
  live: Record<string, RoomLiveEntry>;
  /** 团队成员（取头像/角色；找不到的 agentId 也会渲染，退回 entry 自带的名字） */
  members: Array<Pick<AgentSummary, 'id' | 'name' | 'avatar' | 'responsibility' | 'teamRole'>>;
}) {
  const entries = Object.entries(live).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([agentId, entry]) => {
        const speaker = members.find((m) => m.id === agentId);
        return (
          <div key={`live-${agentId}`} data-testid={`live-bubble-${agentId}`} className="flex items-start gap-2.5">
            <AgentAvatar
              avatar={speaker?.avatar}
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]"
            />
            <div className="min-w-0 max-w-[78%]">
              <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                <span className="font-semibold text-foreground">{speaker?.name ?? entry.agentName}</span>
                {speaker && (
                  <span className="text-muted-foreground">· {memberRoleLabel(speaker)}</span>
                )}
                <span
                  className="rounded px-1 py-px text-[9px] font-bold"
                  style={{ background: '#f59e0b22', color: '#b45309' }}
                >
                  {roomLivePhaseLabel(entry.phase)}
                </span>
              </div>
              <div className="rounded-2xl rounded-tl-md border px-3.5 py-2.5" style={{ borderColor: '#f59e0b44', background: '#f59e0b0a' }}>
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full" style={{ background: '#f59e0b', animationDelay: '0ms' }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full" style={{ background: '#f59e0b', animationDelay: '150ms' }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full" style={{ background: '#f59e0b', animationDelay: '300ms' }} />
                  <span className="ml-1 text-[11px] font-semibold" style={{ color: '#b45309' }}>正在工作…</span>
                </div>
                {entry.text && (
                  <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/75">
                    {entry.text}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export default TeamLiveBubbles;
