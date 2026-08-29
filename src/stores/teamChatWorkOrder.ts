/**
 * src/stores/teamChatWorkOrder.ts
 * 会话派活执行器：把团队任务会话里老板对 leader 下的工作指令，
 * 落成一次真实的多成员编排（leader 拆解分派 → 成员执行 → 审阅 → 汇总交付）。
 *
 * 与 autoWorker 的区别：autoWorker 面向看板「待办」任务的自动领取；
 * 这里面向「评审中/已完成」任务的追加指令——复用同一套编排引擎，
 * a2a trace 实时写回任务事件流（会话气泡与看板时间线同步可见），
 * 看板状态随任务状态机流转（in-progress → review）。
 */
import { useApprovalsStore } from '@/stores/approvals';
import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import {
  claimTask,
  releaseClaim,
  isTaskClaimed,
  createThrottledEventSink,
  projectRoutingCandidates,
} from '@/stores/autoWorker';
import { createRoomTraceForwarder } from '@/stores/teamRoomBroadcast';
import { runSquadOrchestration } from '@/engine/squad/squadOrchestration';
import { runRealChat, runRealChatRich } from '@/engine/llm/realExecutor';
import { notifyTaskTerminal } from '@/lib/task-notify';
import { persistA2aTrace } from '@/lib/a2a-trace-persist';
import {
  buildTeamDeliveryArtifacts,
  prepareTeamExecutionResources,
  recordTeamExecutionOutcomes,
  syncTeamDeliveryToLearningLoop,
} from '@/services/team/team-execution';

/**
 * 互斥说明：会话派活与 autoWorker 自动领取共用同一份 claimed 集合
 * （autoWorker 的 claimTask/releaseClaim），受理即占用、结束（含失败）释放；
 * 占用期间 autoWorker 的 _tick 不会重复领取同一任务。
 */
export function isWorkOrderRunning(taskId: string): boolean {
  return isTaskClaimed(taskId);
}

/**
 * 失败自救：把失败任务重新排队（回 待办/idle），AutoWorker 下一轮自动重领。
 * 看板失败卡片、团队房间失败条、任务会话失败条共用这一个入口（DRY）；
 * 与执行通道互斥——任务正被占用时不重排，返回 false。
 */
export async function retryFailedTask(taskId: string): Promise<boolean> {
  const approvals = useApprovalsStore.getState();
  const task = approvals.tasks.find((t) => t.id === taskId);
  if (!task || task.workState !== 'failed') return false;
  if (isTaskClaimed(taskId)) return false;
  await approvals.updateTask(taskId, { status: 'todo', workState: 'idle' });
  return true;
}

/**
 * 执行会话派活。返回是否成功受理（false = 条件不满足或任务已被占用，未启动）。
 * @throws 编排或落库失败时抛错，调用方负责提示。
 */
export async function runTeamChatWorkOrder(taskId: string, instruction: string): Promise<boolean> {
  const approvals = useApprovalsStore.getState();
  const task = approvals.tasks.find((t) => t.id === taskId);
  if (!task?.teamId) return false;
  const team = useTeamsStore.getState().teams.find((t) => t.id === task.teamId);
  if (!team?.leaderId) return false;
  if (!claimTask(taskId)) return false;

  try {
    await approvals.appendTaskExecutionEvent(taskId, {
      type: 'status',
      content: `收到会话指令：「${instruction.slice(0, 120)}」，leader 开始拆解分派…`,
    });
    await approvals.updateTask(taskId, { status: 'in-progress', workState: 'working' });

    const executionResources = await prepareTeamExecutionResources({
      id: team.id,
      name: team.name,
      leaderId: team.leaderId,
      memberIds: team.memberIds,
    });

    const sink = createThrottledEventSink(taskId);
    const forwardRoom = createRoomTraceForwarder(team.id);

    let orch: Awaited<ReturnType<typeof runSquadOrchestration>>;
    try {
      orch = await runSquadOrchestration({
        taskId,
        taskTitle: task.title,
        taskDescription: [
          task.description,
          `【追加要求（来自会话）】${instruction}`,
          task.workResult
            ? `【上一版交付（在此基础上修订：保留与追加要求无关的部分不变，只改反馈涉及的内容）】\n${task.workResult.slice(0, 12000)}`
            : '',
        ].filter(Boolean).join('\n\n'),
        team,
        candidates: projectRoutingCandidates(team),
        personas: executionResources.personas,
        maxRounds: 3,
        qualityMode: task.priority === 'high',
        ...(executionResources.experienceText
          ? { experience: executionResources.experienceText }
          : {}),
        chat: (agentId, messages, hints) =>
          runRealChat(messages, hints?.maxTokens ?? 8192, { taskId, teamId: team.id, agentId }),
        chatRich: (agentId, messages) =>
          runRealChatRich(messages, 8192, { taskId, teamId: team.id, agentId }),
        onTrace: (trace) => {
          sink.push(trace);
          forwardRoom(trace);
          persistA2aTrace(trace);
        },
        // 实况发言 → 房间「直播中」气泡（内存态 roomLive，同 agent 同槽位只更新；
        // 成员名按 agents store 解析；回调异常绝不阻塞编排）。
        onAgentSpeak: (ev) => {
          try {
            const name =
              useAgentsStore.getState().agents.find((a) => a.id === ev.agentId)?.name
              ?? ev.agentName
              ?? ev.agentId;
            useTeamsStore.getState().updateRoomLive(team.id, ev.agentId, {
              agentName: name,
              phase: ev.phase,
              text: ev.text,
              updatedAt: Date.now(),
            });
          } catch {
            /* 实况转发失败不阻塞编排 */
          }
        },
      });
    } finally {
      await sink.flush();
    }

    recordTeamExecutionOutcomes(orch.subtasks);

    const delivery = await buildTeamDeliveryArtifacts({
      taskId,
      teamName: team.name,
      subtasks: orch.subtasks,
      deliverable: orch.deliverable,
    });

    await approvals.updateTask(taskId, {
      status: 'review',
      workState: 'done',
      ...(delivery.deliverableDir ? { deliverableDir: delivery.deliverableDir } : {}),
      workResult: delivery.output.slice(0, 20000),
    });

    notifyTaskTerminal(taskId, 'done', task.title);
    await syncTeamDeliveryToLearningLoop({
      teamId: task.teamId,
      leaderId: team.leaderId,
      taskId,
      taskTitle: task.title,
      realOutput: delivery.output,
      subtasks: orch.subtasks,
    });
    return true;
  } catch (err) {
    const fresh = useApprovalsStore.getState().tasks.find((t) => t.id === taskId);
    await approvals
      .updateTask(taskId, {
        status: fresh?.workResult ? 'review' : 'todo',
        workState: 'failed',
        workError: `会话派活执行失败：${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => {});
    throw err;
  } finally {
    // 编排结束（成功/失败/取消）：清空该团队的全部实况槽位，避免直播气泡残留。
    useTeamsStore.getState().clearRoomLive(team.id);
    releaseClaim(taskId);
  }
}
