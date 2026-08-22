/**
 * src/stores/metaJudgeStore.ts
 * 评委元评估样本库（「谁来监管裁判」的数据底座）。
 *
 * 为什么必须有人工样本：`engine/evaluation/metaJudge.ts` 的三种诊断
 * （总体一致性 / 漂移 / 逐维薄弱点）全部依赖「gold 标准」，
 * 而 gold 只能来自人 —— 让模型给模型的结论做 gold，会陷入无穷回归。
 *
 * 样本从哪来（这是本模块唯一的设计决策）：
 * 评估结论展示时提供「认可 / 不认可」两个按钮，用户每做一次抽检就产生一条样本：
 *   judgeVerdict = 裁判是否认为该 agent 可用（verdict !== 'FIRED'）
 *   gold         = 人工是否认为该 agent 可用（认可则同裁判，不认可则取反）
 * 于是 accuracy 就是「裁判结论的人工认可率」，α 度量二者的一致性是否超过随机。
 *
 * 刻意的克制：
 * - **不自动造样本**。没人抽检就是没有样本，面板显示「样本不足」，
 *   而不是拿模型自评凑数 —— 那正是元评估要防的东西。
 * - **样本只存本机**（localStorage），不上传。抽检记录里含使用者的判断偏好，
 *   属于个人数据。
 * - 上限 500 条，超出丢弃最旧的（滑动窗口天然适配漂移检测）。
 */
import { create } from 'zustand';

import type { MetaJudgeSample } from '@/engine/evaluation/metaJudge';
import type { Verdict } from '@/types/evaluation';

const STORAGE_KEY = 'agentcorp.metaJudge.samples';
const MAX_SAMPLES = 500;

/** 一次人工抽检的输入 */
export interface HumanReviewInput {
  /** 被复核的 agent */
  agentId: string;
  /** 裁判给出的判定 */
  verdict: Verdict;
  /** 裁判自报的置信度（0–1），用于置信校准分析 */
  confidence?: number | null;
  /** 用户是否认可这个结论 */
  agreed: boolean;
  /** 分组维度：用当前工种，便于诊断「裁判在哪类工种上更不准」 */
  dim?: string | null;
  /** 裁判模型标识（跨家族轮转时可分模型诊断） */
  judgeId?: string;
  /** 裁判给出该结论时的思维链 / 推理文本（可选，供第四种诊断：推理-结论一致性） */
  reasoning?: string | null;
}

function loadSamples(): MetaJudgeSample[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MetaJudgeSample[]) : [];
  } catch {
    return [];
  }
}

function persist(samples: MetaJudgeSample[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
  } catch {
    // 存储配额满 / 隐私模式：内存态仍然可用，不打断抽检
  }
}

/**
 * 把一次人工抽检转成元评估样本（纯函数，可单测）。
 *
 * 二值化口径：把三档 verdict 压成「可用 / 不可用」。
 * 这样做是因为元评估要回答的是「裁判的准入结论靠不靠谱」，
 * 而不是「MVP 与 OBSERVE 的边界画得准不准」——后者需要序数一致性，
 * 样本量要求高一个数量级，不适合放在人工抽检这种低频信号上。
 */
export function toSample(input: HumanReviewInput, now = new Date()): MetaJudgeSample {
  const judgeSaysUsable = input.verdict !== 'FIRED';
  return {
    id: `${input.agentId}-${now.getTime()}`,
    judgeId: input.judgeId ?? 'default',
    judgeVerdict: judgeSaysUsable,
    gold: input.agreed ? judgeSaysUsable : !judgeSaysUsable,
    confidence: input.confidence ?? null,
    dim: input.dim ?? null,
    reasoning: input.reasoning ?? null,
    ts: now.toISOString(),
  };
}

interface MetaJudgeState {
  samples: MetaJudgeSample[];
  /** 记录一次人工抽检 */
  recordReview: (input: HumanReviewInput) => void;
  /** 清空样本（用户主动重置，例如换了裁判模型想重新积累） */
  clear: () => void;
}

export const useMetaJudgeStore = create<MetaJudgeState>((set, get) => ({
  samples: loadSamples(),

  recordReview: (input) => {
    const next = [...get().samples, toSample(input)].slice(-MAX_SAMPLES);
    persist(next);
    set({ samples: next });
  },

  clear: () => {
    persist([]);
    set({ samples: [] });
  },
}));
