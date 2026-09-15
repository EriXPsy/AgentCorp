/**
 * src/engine/interview/multiFileIssue.ts
 * 多文件真实 issue 修复任务契约（借鉴 SWE-EVO：多文件多轮编码）。
 *
 * 设计理念（见 benchmark-research-2026-08-19.md）：
 * SWE-bench Verified 是单文件 Python patch，高估了 48 个点；
 * SWE-EVO 平均改 21 文件/874 测试，更贴近真实工程。
 * 本模块定义多文件 issue 任务的契约骨架——
 * 不实现完整多文件沙盒（沙盒在 model-service/sandbox），但搭好评测契约：
 *   - issue 描述 + 仓库上下文 + 涉及文件 + 测试集
 *   - 复杂度估算（文件数/测试数 → 难度分级）
 *   - 与 code 工种现有沙盒（单文件）的扩展对齐
 *
 * 纯函数、零外部依赖、可单测。多文件沙盒执行留 model-service 侧扩展。
 */
/** 多文件 issue 任务难度（与 SWE-EVO 报告口径对齐） */
export type MultiFileIssueDifficulty = 'medium' | 'hard' | 'very-hard';

/** 多文件 issue 任务规约 */
export interface MultiFileIssueSpec {
  id: string;
  issueTitle: string;
  issueDescription: string;
  /** 仓库上下文（语言/框架/模块名） */
  repoContext: string;
  /** 涉及修改的文件列表（相对路径） */
  affectedFiles: string[];
  /** 测试文件列表（相对路径） */
  testFiles: string[];
  /** 期望通过的测试数 */
  expectedTestCount: number;
  /** 难度（可由 estimateComplexity 推导，也可手工标定） */
  difficulty?: MultiFileIssueDifficulty;
  /** 关联公开 benchmark（见 benchmarkRef.ts） */
  benchmarkRefId?: string;
}

/** 复杂度评估结果 */
export interface IssueComplexity {
  fileSpread: number;
  testCount: number;
  /** 复杂度综合分（0–100，越高越复杂） */
  complexityScore: number;
  /** 推导难度 */
  difficulty: MultiFileIssueDifficulty;
}

/**
 * 估算多文件 issue 复杂度（纯函数）。
 *
 * 公式（启发式，与 SWE-EVO 报告口径对齐）：
 *   complexityScore = clamp( fileSpread * 4 + testCount * 0.5 , 0, 100 )
 *   - 1 文件 = 4 分；每多 1 文件 +4 分（文件散布是复杂度主因）
 *   - 1 测试 = 0.5 分（测试多说明行为面广）
 * 难度分级：
 *   < 30 = medium；30–60 = hard；> 60 = very-hard
 */
export function estimateComplexity(spec: MultiFileIssueSpec): IssueComplexity {
  const fileSpread = spec.affectedFiles.length;
  const testCount = spec.expectedTestCount;
  const rawScore = fileSpread * 4 + testCount * 0.5;
  const complexityScore = Math.max(0, Math.min(100, Math.round(rawScore)));
  let difficulty: MultiFileIssueDifficulty = 'medium';
  if (complexityScore >= 60) difficulty = 'very-hard';
  else if (complexityScore >= 30) difficulty = 'hard';
  return { fileSpread, testCount, complexityScore, difficulty };
}

/**
 * 校验 issue 规约完整性（纯函数）。
 * 缺关键字段时返回问题列表，不抛出。
 */
export function validateMultiFileIssueSpec(
  spec: MultiFileIssueSpec,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!spec.id) issues.push('id is required');
  if (!spec.issueTitle) issues.push('issueTitle is required');
  if (!spec.issueDescription) issues.push('issueDescription is required');
  if (!spec.repoContext) issues.push('repoContext is required');
  if (!Array.isArray(spec.affectedFiles) || spec.affectedFiles.length === 0) {
    issues.push('affectedFiles must be a non-empty array');
  }
  if (!Array.isArray(spec.testFiles) || spec.testFiles.length === 0) {
    issues.push('testFiles must be a non-empty array');
  }
  if (typeof spec.expectedTestCount !== 'number' || spec.expectedTestCount < 1) {
    issues.push('expectedTestCount must be a positive number');
  }
  return { ok: issues.length === 0, issues };
}

/** 把单文件 issue 扩展点（现有沙盒）与多文件契约对齐的适配器（纯函数）。 */
export function isMultiFileIssue(spec: MultiFileIssueSpec): boolean {
  return spec.affectedFiles.length > 1;
}

/** 给定复杂度返回人类可读难度标签（发布会口径）。 */
export function difficultyLabel(d: MultiFileIssueDifficulty): string {
  switch (d) {
    case 'medium':
      return '中等';
    case 'hard':
      return '困难';
    case 'very-hard':
      return '极难';
    default:
      return String(d);
  }
}
