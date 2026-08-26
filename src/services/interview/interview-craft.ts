import type { CraftTask } from '@/types/craft';
import type { CraftTrialRound } from '@/types/interview';
import { classifyCraftRunMode, normalizeCraftTrialRound } from './interview-progress';

export interface AskAgentForCraft {
  (params: { sessionKey: string; question: string }): Promise<{
    mode: 'agent' | 'manual';
    runId: string | null;
    replyText: string;
    latencyMs: number | null;
    error?: string;
  }>;
}

export interface JudgeCraftTaskFn {
  (input: { task_id: string; answer: string }): Promise<unknown>;
}

export interface RunCraftTrialInput {
  task: CraftTask;
  sessionKey?: string;
  manualAnswer?: string;
  askAgent: AskAgentForCraft;
  judgeCraftTask: JudgeCraftTaskFn;
}

export interface RunCraftTrialResult {
  trial: CraftTrialRound | null;
  craftError: string | null;
}

export async function runCraftTrial(input: RunCraftTrialInput): Promise<RunCraftTrialResult> {
  const craftMode = classifyCraftRunMode(input.sessionKey, input.manualAnswer);
  let answerText = craftMode.initialAnswerText;
  let mode: 'agent' | 'manual' = 'manual';
  let answerLatencyMs: number | null = null;

  if (craftMode.requiresManualInput) {
    return {
      trial: null,
      craftError: '该候选没有可用会话键，请手动粘贴试做题答案',
    };
  }

  if (answerText.length === 0) {
    const ask = await input.askAgent({
      sessionKey: input.sessionKey!,
      question: input.task.prompt,
    });
    answerText = ask.replyText.trim();
    mode = ask.mode;
    answerLatencyMs = ask.latencyMs;
    if (answerText.length === 0) {
      return {
        trial: null,
        craftError: ask.error ?? '未取回试做题答案，请手动粘贴',
      };
    }
  }

  const trial: CraftTrialRound = {
    ...normalizeCraftTrialRound({
      taskId: input.task.id,
      title: input.task.title,
      prompt: input.task.prompt,
      answerText,
      mode,
      answerLatencyMs,
    }),
    judgement: null,
  };

  try {
    const judgement = await input.judgeCraftTask({
      task_id: input.task.id,
      answer: answerText,
    }) as CraftTrialRound['judgement'];
    trial.judgement = judgement;
    if (judgement?.degraded) {
      trial.judgeError = judgement.degraded_reason || 'LLM 评分不可用，仅保留机器验证';
    }
  } catch (error) {
    trial.judgeError = error instanceof Error ? error.message : '评分后端不可用，本题记为未评测';
  }

  return {
    trial,
    craftError: trial.judgeError ?? null,
  };
}
