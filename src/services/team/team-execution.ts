import { buildDeliverableFiles } from '@/engine/squad/deliverableFiles';
import type { SubTaskResult } from '@/engine/squad/squadOrchestration';
import { runRealChat } from '@/engine/llm/realExecutor';
import { invokeIpc } from '@/lib/api-client';
import { useAgentsStore } from '@/stores/agents';
import { useExperienceStore, buildExperienceText, reflectExperience } from '@/stores/experience';
import { usePerformanceStore, subtasksToOutcomes } from '@/stores/performance';
import { useTeamsStore } from '@/stores/teams';

export interface TeamExecutionTarget {
  id: string;
  name: string;
  leaderId: string;
  memberIds: string[];
}

export interface TeamExecutionResources {
  personas: Record<string, string | null>;
  experienceText: string;
}

/**
 * 为团队编排准备共享上下文：
 * - 成员 persona（SOUL.md / agent profile）
 * - 最新绩效快照（供 route/performance 注入）
 * - 团队经验卡文本（供 orchestration prompt 注入）
 */
export async function prepareTeamExecutionResources(
  team: TeamExecutionTarget,
): Promise<TeamExecutionResources> {
  const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));
  const personas: Record<string, string | null> = {};

  await Promise.all(
    memberIds.map(async (agentId) => {
      personas[agentId] = await useAgentsStore.getState().getAgentPersona(agentId).catch(() => null);
    }),
  );

  await usePerformanceStore.getState().fetchMemberStats();
  const experienceText =
    buildExperienceText(await useExperienceStore.getState().getExperience(team.id)) ?? '';

  return { personas, experienceText };
}

/** D：编排结果按子任务归集成成员绩效上报（fire-and-forget，失败静默） */
export function recordTeamExecutionOutcomes(subtasks: SubTaskResult[]): void {
  void usePerformanceStore.getState().recordOutcomes(subtasksToOutcomes(subtasks));
}

/** 团队交付摘要：保持 team room / task review / deliverable 文件统一口径。 */
export function buildTeamDeliveryOutput(
  teamName: string,
  subtasks: SubTaskResult[],
  deliverable: string,
): string {
  const passed = subtasks.filter((subtask) => subtask.approved).length;
  const failedCount = subtasks.filter((subtask) => subtask.error).length;
  return (
    `【团队协同·${teamName}·${subtasks.length} 个子任务：${passed} 通过` +
    `${failedCount ? `，${failedCount} 失败` : ''}】\n${deliverable}`
  );
}

/**
 * 把团队交付文件落到任务目录，并把提示语拼到最终输出后面。
 * 落盘失败时保持 best-effort：不抛错、不阻断任务终态。
 */
export async function buildTeamDeliveryArtifacts(input: {
  taskId: string;
  teamName: string;
  subtasks: SubTaskResult[];
  deliverable: string;
}): Promise<{ output: string; deliverableDir?: string }> {
  let output = buildTeamDeliveryOutput(input.teamName, input.subtasks, input.deliverable);
  let deliverableDir: string | undefined;

  try {
    const files = buildDeliverableFiles(input.subtasks, input.deliverable);
    const saved = await invokeIpc<{ success: boolean; dir?: string; saved?: string[] }>(
      'task:saveDeliverables',
      { taskId: input.taskId, files },
    );
    if (saved.success && saved.dir) {
      deliverableDir = saved.dir;
      output += `\n\n---\n📁 ${saved.saved?.length ?? 0} 个交付文件已保存到本地，点下方「打开交付目录」查看/运行。`;
    }
  } catch {
    // 落盘失败不阻塞交付
  }

  return deliverableDir ? { output, deliverableDir } : { output };
}

/**
 * 团队任务完成后，把交付同步回 team room，并触发 leader 视角经验反思。
 * 这条 wiring 是 operate → learn 的最后一跳，应保持单一口径。
 */
export async function syncTeamDeliveryToLearningLoop(input: {
  teamId: string;
  leaderId?: string | null;
  taskId: string;
  taskTitle: string;
  realOutput: string;
  subtasks?: SubTaskResult[] | null;
}): Promise<void> {
  const team = useTeamsStore.getState().teams.find((entry) => entry.id === input.teamId);
  const speakerId = input.leaderId ?? team?.leaderId ?? input.teamId;

  await useTeamsStore
    .getState()
    .appendTeamChatEvent(input.teamId, {
      from: speakerId,
      to: 'user',
      content:
        `「${input.taskTitle}」交付完成，请验收：\n\n${input.realOutput.slice(0, 4000)}` +
        `\n\n> 交付文件在任务会话/看板任务详情里可直接打开或下载 ZIP。`,
    })
    .catch(() => {
      // 房间同步失败不阻塞交付
    });

  const leaderId = input.leaderId ?? undefined;
  if (leaderId && input.subtasks && input.subtasks.length > 0) {
    void reflectExperience({
      teamId: input.teamId,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      subtasks: input.subtasks,
      chat: (messages) =>
        runRealChat(messages, 512, {
          taskId: input.taskId,
          teamId: input.teamId,
          agentId: leaderId,
        }),
    });
  }
}
