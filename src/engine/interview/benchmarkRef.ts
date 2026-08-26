/**
 * src/engine/interview/benchmarkRef.ts
 * 公开 benchmark 参照知识库 + 任务类型分类纯函数。
 *
 * 设计理念（见内部 benchmark 调研笔记与公开架构蓝图）：
 * AgentCorp 不照搬公开 benchmark 题目（避 contamination + 与真实工作流脱节），
 * 而是把公开 benchmark 作为「对照锚点」——让 AgentCorp 的评估结论有公开参照
 * （「这个 Agent 在我们的 code-issue-fix 任务上 = SWE-bench Verified 的 X 分位」），
 * 题目来源仍是用户真实职场任务（经验胶囊回流进化题库）。
 *
 * 三层纯函数：
 * 1. BENCHMARK_REFS：公开 benchmark 元数据知识库（id/name/domain/metric/feature）
 * 2. classifyTaskType：从任务特征推断任务类型（single-turn/multi-turn-issue-fix/...）
 * 3. benchmarkRefForTaskType：任务类型 → 对应公开 benchmark 参照
 *
 * 纯函数、零外部依赖、可单测。不碰现有 12 题（避免蔓延）。
 */
import type { JobType } from '@/types/evaluation';

/** 任务类型：借鉴公开 benchmark 的任务结构分类 */
export type TaskType =
  | 'single-turn' // 单轮作答（现有 12 题）
  | 'code-issue-fix' // 真实 issue 修复（借鉴 SWE-bench Verified）
  | 'code-multi-file' // 多文件多轮编码（借鉴 SWE-bench Pro/EVO）
  | 'multi-turn-policy' // 多轮交互 + policy 约束（借鉴 τ-bench）
  | 'research-synthesis' // 多步 web 研究 +综合（借鉴 GAIA）
  | 'gui-operation' // GUI 操作（借鉴 OSWorld）
  | 'web-navigation' // 网页操作（借鉴 WebArena）
  | 'enterprise-workflow' // 企业工作流（借鉴 WorkArena，ToB 阶段）
  | 'command-line' // 命令行（借鉴 terminal-bench）
  | 'unknown';

/** 公开 benchmark 参照元数据 */
export interface BenchmarkRef {
  /** 简短 id（用作参照键） */
  id: string;
  /** 全名 */
  name: string;
  /** 领域 */
  domain: string;
  /** 核心度量 */
  metric: string;
  /** 关键设计特征 */
  feature: string;
  /** 2026 SOTA（用于分位对照，可选） */
  sota2026?: string;
  /** AgentCorp 对照维度（哪个 taskType 借鉴它） */
  agentcorpTaskType: TaskType;
  /** 真实职场相关度（★1-5） */
  realWorldRelevance: 1 | 2 | 3 | 4 | 5;
}

/**
 * 公开 benchmark 参照知识库。
 * 数据来源：2026-08-19 WebSearch 调研（rapidclaw.dev/codesota/toloka/agentmarketcap）。
 */
export const BENCHMARK_REFS: BenchmarkRef[] = [
  {
    id: 'swe-bench-verified',
    name: 'SWE-bench Verified',
    domain: '编码（真实 GitHub issue）',
    metric: 'resolve rate（单元测试判过）',
    feature: '500 手工验证任务，agent 出 git patch',
    sota2026: 'Claude Opus 4.7 = 87.6%',
    agentcorpTaskType: 'code-issue-fix',
    realWorldRelevance: 5,
  },
  {
    id: 'swe-evo',
    name: 'SWE-EVO',
    domain: '编码（多文件多轮）',
    metric: 'resolve rate',
    feature: '平均改 21 文件/874 测试，比 Verified 更真实',
    sota2026: 'GPT-5.4+OpenHands = 25%（vs Verified 72.8%）',
    agentcorpTaskType: 'code-multi-file',
    realWorldRelevance: 5,
  },
  {
    id: 'tau-bench',
    name: 'τ-bench (tau-bench)',
    domain: '客服/零售（多轮对话）',
    metric: 'resolve + policy 遵守',
    feature: '模拟用户 + policy 约束 + 跨域（航空/零售，Toloka 2025 扩展）',
    sota2026: 'Claude 3.5 Sonnet = 68.2%(零售)/52.1%(航空)',
    agentcorpTaskType: 'multi-turn-policy',
    realWorldRelevance: 5,
  },
  {
    id: 'gaia',
    name: 'GAIA',
    domain: '通用 assistant（多步推理+web 研究）',
    metric: 'exact-match',
    feature: '三级难度，需多步工具+web',
    sota2026: 'Claude Sonnet 4.5 = 74.6%',
    agentcorpTaskType: 'research-synthesis',
    realWorldRelevance: 4,
  },
  {
    id: 'osworld',
    name: 'OSWorld',
    domain: '桌面 GUI 操作',
    metric: 'success rate',
    feature: '真实 OS 截图操作，computer-use 标杆',
    sota2026: '22%（vs 人类 72.4%）',
    agentcorpTaskType: 'gui-operation',
    realWorldRelevance: 4,
  },
  {
    id: 'webarena',
    name: 'WebArena',
    domain: '网页操作',
    metric: 'success rate',
    feature: '沙箱真实 web app，电商/GitLab/论坛',
    sota2026: '39.5%（vs 人类 78.2%）',
    agentcorpTaskType: 'web-navigation',
    realWorldRelevance: 4,
  },
  {
    id: 'workarena',
    name: 'WorkArena',
    domain: '企业办公（ServiceNow 工作流）',
    metric: 'success rate',
    feature: '真实 CRM/工单工作流',
    agentcorpTaskType: 'enterprise-workflow',
    realWorldRelevance: 5,
  },
  {
    id: 'terminal-bench',
    name: 'terminal-bench',
    domain: 'Bash/Linux',
    metric: 'success rate',
    feature: 'Docker 隔离 shell',
    agentcorpTaskType: 'command-line',
    realWorldRelevance: 3,
  },
];

/** 任务特征输入（用于分类） */
export interface TaskClassificationInput {
  jobType?: JobType | null;
  /** 任务标题/描述文本（用于关键词推断） */
  taskText?: string | null;
  /** 是否多轮交互 */
  multiTurn?: boolean;
  /** 是否带 policy/约束 */
  hasPolicy?: boolean;
  /** 是否需 web 搜索 */
  requiresWebSearch?: boolean;
  /** 是否 GUI/截图操作 */
  isGuiOperation?: boolean;
  /** 是否多文件 */
  multiFile?: boolean;
  /** 是否企业工作流（CRM/工单） */
  isEnterpriseWorkflow?: boolean;
  /** 是否命令行任务 */
  isCommandLine?: boolean;
  /** 是否真实 issue 修复 */
  isIssueFix?: boolean;
}

/** 文本关键词 → 任务类型 的启发式推断 */
function inferFromText(text: string | null | undefined): Partial<TaskClassificationInput> {
  if (!text) return {};
  const t = text.toLowerCase();
  return {
    isIssueFix: /issue|bug\s*fix|缺陷|修复\s*issue|github\s*pr/.test(t),
    multiTurn: /多轮|对话|协商|客服|客户\s*沟通/.test(t),
    hasPolicy: /policy|政策|合规|约束|工单\s*流程/.test(t),
    requiresWebSearch: /调研|研究|search|检索|综合\s*分析/.test(t),
    isGuiOperation: /截图|gui|桌面\s*操作|点击\s*界面/.test(t),
    multiFile: /多文件|跨模块|重构|refactor/.test(t),
    isEnterpriseWorkflow: /crm|工单|客户\s*工单|servicenow|销售\s*流程/.test(t),
    isCommandLine: /shell|bash|命令行|terminal|脚本\s*执行/.test(t),
  };
}

/**
 * 从任务特征推断任务类型（纯函数，可单测）。
 *
 * 优先级（从具体到一般）：
 * 1. 显式标志（isIssueFix/multiTurn+hasPolicy/requiresWebSearch 等）
 * 2. 文本启发式（inferFromText）
 * 3. 工种兜底（code→single-turn, text→single-turn, image→single-turn）
 * 4. unknown
 */
export function classifyTaskType(input: TaskClassificationInput): TaskType {
  // 合并文本启发式
  const inferred = inferFromText(input.taskText);
  const isIssueFix = input.isIssueFix ?? inferred.isIssueFix ?? false;
  const multiTurn = input.multiTurn ?? inferred.multiTurn ?? false;
  const hasPolicy = input.hasPolicy ?? inferred.hasPolicy ?? false;
  const requiresWebSearch = input.requiresWebSearch ?? inferred.requiresWebSearch ?? false;
  const isGuiOperation = input.isGuiOperation ?? inferred.isGuiOperation ?? false;
  const multiFile = input.multiFile ?? inferred.multiFile ?? false;
  const isEnterpriseWorkflow =
    input.isEnterpriseWorkflow ?? inferred.isEnterpriseWorkflow ?? false;
  const isCommandLine = input.isCommandLine ?? inferred.isCommandLine ?? false;

  // 优先级判定
  if (isEnterpriseWorkflow) return 'enterprise-workflow';
  if (isGuiOperation) return 'gui-operation';
  if (multiTurn && hasPolicy) return 'multi-turn-policy';
  if (requiresWebSearch) return 'research-synthesis';
  if (isCommandLine) return 'command-line';
  if (isIssueFix && multiFile) return 'code-multi-file';
  if (isIssueFix) return 'code-issue-fix';

  // 工种兜底（现有 12 题都是单轮作答）
  if (input.jobType === 'code' || input.jobType === 'text' || input.jobType === 'image') {
    return 'single-turn';
  }
  return 'unknown';
}

/** 任务类型 → 对应公开 benchmark 参照（纯函数）。 */
export function benchmarkRefForTaskType(
  taskType: TaskType,
): BenchmarkRef | null {
  return BENCHMARK_REFS.find((b) => b.agentcorpTaskType === taskType) ?? null;
}

/** 任务类型 → 对外可读标签（纯函数，发布会口径）。 */
export function taskTypeLabel(taskType: TaskType): string {
  const labels: Record<TaskType, string> = {
    'single-turn': '单轮作答',
    'code-issue-fix': '真实 issue 修复',
    'code-multi-file': '多文件多轮编码',
    'multi-turn-policy': '多轮交互 + 约束',
    'research-synthesis': '研究综合',
    'gui-operation': 'GUI 操作',
    'web-navigation': '网页操作',
    'enterprise-workflow': '企业工作流',
    'command-line': '命令行',
    unknown: '未分类',
  };
  return labels[taskType];
}

/**
 * 列出所有 benchmark 参照（按真实职场相关度降序）。
 * 供评估中心「公开对照锚点」面板消费。
 */
export function listBenchmarkRefs(): BenchmarkRef[] {
  return [...BENCHMARK_REFS].sort((a, b) => b.realWorldRelevance - a.realWorldRelevance);
}
