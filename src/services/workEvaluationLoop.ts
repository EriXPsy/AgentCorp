/**
 * src/services/workEvaluationLoop.ts
 * 「用人 → 选人」回流：把一次真实干活的产出，变成下一次选人的证据。
 *
 * 这条链路补上了 AgentCorp 叙事里缺的最后一段。此前是单向的：
 *
 *     选人（评测中心 / 试做题）──→ 用人（看板派活 / 多 Agent 编排）
 *
 * 但真正有说服力的评测不该只发生在「面试」那一刻。一个 agent 面试时表现好、
 * 上岗后天天返工，这件事必须能被系统看见。于是补上回流：
 *
 *     选人 ──→ 用人 ──→ 真实产出与用量回流成新的评测证据 ──→ 榜单/办公室重排
 *
 * 与面试期评测的区别（也是它的价值）：
 * - 面试期证据 = 候选对固定题的作答（可比但人造）；
 * - 上岗期证据 = 真实任务的 transcript + 真实 token 花费 + 真实返工次数（真实但不可比）。
 * 两者并置，才谈得上「面试承诺 vs 上岗表现」的对照 —— 这正是 README 里
 * 「准入评分与上线后真实表现的相关性」那个下一阶段目标所需要的原始数据。
 *
 * 纪律：
 * 1. **best-effort**：任何失败都只吞掉并返回 null，绝不阻塞交付主流程。
 *    评测是观察者，不能成为生产链路的故障点。
 * 2. **不造分**：产出为空 / 没有 agentId 时直接不评，而不是给个默认分。
 * 3. **来源如实**：走的是 judgeClient.evaluate，裁判不可用时事件流自带
 *    source=degraded，最终落到画像的 judgeSource 上，榜单据此分区展示。
 */
import { useEvaluationStore } from '@/stores/evaluation';
import type { EvaluationProfile } from '@/types/evaluation';
import { hostApiFetch } from '@/lib/host-api';
import { buildCapsule } from '@/engine/experience/capsule';

/** 一次已完成的真实工作 */
export interface CompletedWork {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  /** 实际干活的 agent（团队任务取被指派成员，而不是 leader） */
  agentId: string;
  agentName: string;
  /** 真实交付物文本 */
  output: string;
  /** 执行主键（用于 runId ↔ task 关联落库） */
  runId?: string | null;
  sessionId?: string;
  sessionKey?: string;
  /** 团队任务时的 leader（仅用于留痕，不参与打分） */
  leaderId?: string;
  /** 本次任务实际返工轮数（多 Agent 编排回传，无则视为 0） */
  reworkRounds?: number;
  /** 编排是否最终通过验收 */
  approved?: boolean;
}

/** 交付文本长度下限：太短的产出不足以支撑六维判断，宁可不评 */
const MIN_OUTPUT_CHARS = 40;

/**
 * 判断一次工作是否值得回流评测（纯函数，可单测）。
 *
 * 刻意保守：宁可漏评，不可错评。一条「好的」「收到」也会被 judge 打出六个分，
 * 那种分数进了榜单只会污染结论。
 */
export function shouldEvaluateWork(work: Partial<CompletedWork> | null | undefined): boolean {
  if (!work) return false;
  if (!work.agentId || !work.agentName) return false;
  const output = (work.output ?? '').trim();
  if (output.length < MIN_OUTPUT_CHARS) return false;
  return true;
}

/**
 * 把一次真实工作组装成评测入参（纯函数，可单测）。
 *
 * transcript 采用「任务 → 交付」的对话式拼装，与面试期 transcript 同构，
 * 使同一套裁判 rubric 可以直接复用，不必为上岗期另写一套提示词。
 */
export function buildWorkTranscript(work: CompletedWork): string {
  const lines = [
    `# 上岗期真实任务`,
    `任务：${work.taskTitle}`,
  ];
  if (work.taskDescription?.trim()) {
    lines.push(`需求描述：${work.taskDescription.trim()}`);
  }
  if (typeof work.reworkRounds === 'number' && work.reworkRounds > 0) {
    // 返工次数是客观事实，交给裁判自行判断它意味着什么（不预先扣分）
    lines.push(`过程记录：经过 ${work.reworkRounds} 轮返工后交付`);
  }
  if (work.approved === false) {
    lines.push(`过程记录：最终未通过 leader 验收`);
  }
  lines.push('', `## ${work.agentName} 的交付物`, work.output.trim());
  return lines.join('\n');
}

/**
 * 回流入口：真实工作完成后调用。
 *
 * @returns 更新后的评估档案；不满足回流条件或任何异常时返回 null（静默）。
 */
export async function evaluateCompletedWork(
  work: CompletedWork,
): Promise<EvaluationProfile | null> {
  if (!shouldEvaluateWork(work)) return null;
  try {
    const evaluation = await useEvaluationStore.getState().runEvaluation({
      runId: work.runId ?? null,
      agentId: work.agentId,
      agentName: work.agentName,
      taskId: work.taskId,
      sessionId: work.sessionId ?? '',
      sessionKey: work.sessionKey ?? '',
      task: {
        title: work.taskTitle,
        description: work.taskDescription ?? '',
        weight: 1,
      },
      // 多 Agent 编排路径的 LLM 调用不落在某个 gateway 会话里，
      // 主进程采集会返回空转录 —— 用真实交付物兜底，让裁判有证据可依。
      transcriptFallback: buildWorkTranscript(work),
    });
    const profile = evaluation?.profile ?? null;
    // 评测成功后，把这次协作沉淀为经验胶囊（best-effort，绝不阻塞回流）：
    // 胶囊是 G12 eval-in-loop 的回归集原子，也是后续 Agent 适配与群体经验
    // 共享的基础——兑现「真实交付回流成新的评测证据」与「人的能力增量」北极星。
    void persistCapsuleBestEffort(work, profile);
    return profile;
  } catch {
    // 评测是观察者：它自己出问题，不能反过来影响已经交付的工作
    return null;
  }
}

/**
 * best-effort 沉淀经验胶囊：主进程不可达 / 落盘失败时静默吞掉。
 * 与回流闭环同口径——胶囊是观察者，不能成为生产链路的故障点。
 */
async function persistCapsuleBestEffort(
  work: CompletedWork,
  profile: EvaluationProfile | null,
): Promise<void> {
  try {
    const capsule = buildCapsule(work, profile);
    await hostApiFetch('/api/capsules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(capsule),
    });
  } catch {
    // web 预览模式 / 主进程不可达 / 落盘失败——吞掉，回流不受影响
  }
}

export const workEvaluationLoop = { shouldEvaluateWork, buildWorkTranscript, evaluateCompletedWork };
