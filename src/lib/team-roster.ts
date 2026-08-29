/**
 * src/lib/team-roster.ts
 * 团队成员花名册与忙闲状态的纯函数层（可单测，无 store/DOM 依赖）。
 *
 * 忙闲推导：成员是任一 in-progress 看板任务的 assignee → busy；
 * 其余沿用 agents store 里的基础状态（默认 online）。
 * 花名册行：leader 在前，角色副标题取 responsibility（缺省回退 teamRole 标签）。
 */
import type { AgentSummary } from '@/types/agent';

export type RosterStatus = 'online' | 'offline' | 'busy';

export interface RosterMember {
  id: string;
  name: string;
  avatar?: string | null;
  /** 展示副标题（Knowe 的「UI/UX 设计」位）：responsibility 优先，回退 teamRole 标签 */
  role: string;
  status: RosterStatus;
  isLeader: boolean;
}

/** in-progress 任务的 assignee 集合 → 忙碌成员 id。 */
export function deriveBusyAgentIds(
  tasks: Array<{ status: string; assigneeId?: string }>,
): Set<string> {
  const busy = new Set<string>();
  for (const t of tasks) {
    if (t.status === 'in-progress' && t.assigneeId) busy.add(t.assigneeId);
  }
  return busy;
}

/** 成员角色副标题：responsibility 优先，缺省回退「负责人 / 成员」。 */
export function memberRoleLabel(
  agent: Pick<AgentSummary, 'responsibility' | 'teamRole'>,
): string {
  const responsibility = agent.responsibility?.trim();
  if (responsibility) return responsibility;
  return agent.teamRole === 'leader' ? '负责人' : '成员';
}

/**
 * 构建团队花名册：leader 在前，agent 找不到的 id 跳过。
 * status：busy 由任务实时推导（优先），否则回退 store 里的基础状态（默认 online）。
 */
export function buildTeamRoster(
  team: { leaderId: string; memberIds: string[] },
  agents: Array<Pick<AgentSummary, 'id' | 'name' | 'avatar' | 'responsibility' | 'teamRole'>>,
  tasks: Array<{ status: string; assigneeId?: string }>,
  baseStatuses: Record<string, RosterStatus | undefined> = {},
): RosterMember[] {
  const busyIds = deriveBusyAgentIds(tasks);
  const ids = [team.leaderId, ...team.memberIds];
  const roster: RosterMember[] = [];
  for (const id of ids) {
    const agent = agents.find((a) => a.id === id);
    if (!agent) continue;
    roster.push({
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar,
      role: memberRoleLabel(agent),
      status: busyIds.has(agent.id) ? 'busy' : baseStatuses[agent.id] ?? 'online',
      isLeader: agent.id === team.leaderId,
    });
  }
  return roster;
}

/** 群头部实时状态行：有成员在忙时「甲、乙 正在工作…」，否则空串（不渲染）。 */
export function buildBusyStatusLine(busyNames: string[]): string {
  if (busyNames.length === 0) return '';
  return `${busyNames.join('、')} 正在工作…`;
}

/** 气泡 hover 时间戳：HH:mm；createdAt 缺失/非法时返回空串（不渲染）。 */
export function formatBubbleTime(createdAt?: string): string {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
