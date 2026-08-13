/**
 * 候选角色卡（CandidateRoleCard）—— AgentCorp 人才市场的「考生」模型
 * --------------------------------------------------------------------------
 * 设计来源：外部开源角色库（当前接入 `jnMetaCode/agency-agents-zh`，MIT）的
 *           Markdown 人格文件，经 `agencyAgentsBridge` 解析后投影为本结构。
 *
 * 定位：
 *  - 这是「供给层」产物——只描述一个候选 Agent 的人设/边界/交付物/工作流，
 *    **不带 Skill、不带能力评估**。评价与决策由 AgentCorp 自身的 HR 面试闭环
 *    （`closedLoop` + `judgeEnsemble` + `boss_review`）负责。
 *  - 与 `RoleCard`（boss/recruiter/evaluator/dispatcher 四张核心编排卡）正交：
 *    候选卡是「考生」，核心卡是「考官」，二者不互相替换。
 *
 * 本文件自包含（不 import 外部模块），保证 tsc 编译隔离、可独立演进。
 */

/** 候选来源库标识。当前仅接入 agency-agents-zh，预留扩展位。 */
export type CandidateSourceRepo = 'jnMetaCode/agency-agents-zh';

/** 角色来源性质：翻译自上游 / 中国市场原创 / 未知。 */
export type CandidateOrigin = 'translated' | 'china-original' | 'unknown';

/** 溯源信息——MIT 合规与可审计性的硬要求，必须随候选卡一起保留。 */
export interface CandidateProvenance {
  sourceRepo: CandidateSourceRepo;
  license: 'MIT';
  /** 上游英文项目（agency-agents-zh 的翻译基准）。 */
  upstream?: string;
  origin: CandidateOrigin;
  /** 相对仓库根的路径，如 `engineering/engineering-security-engineer.md`。 */
  fileRelPath: string;
  /** 接入 AgentCorp 的日期（ISO），用于版本溯源。 */
  integratedAt: string;
}

/**
 * 候选角色卡本体（只读快照）。
 * `persona / boundaries / deliverables / workflow` 来自源文件正文的四个核心小节，
 * 直接作为面试时「候选 Agent 背景」与「产出验收锚点」。
 */
export interface CandidateRoleCard {
  /** slug 化唯一 id，如 `engineering-security-engineer`。 */
  id: string;
  /** 显示名，如 `安全工程师`。 */
  title: string;
  /** 一句话描述（源 frontmatter.description）。 */
  summary: string;
  /** 部门目录名（英文），如 `engineering`。 */
  department: string;
  /** 部门中文展示名（可选，由目录映射）。 */
  departmentLabel?: string;
  emoji?: string;
  color?: string;
  /** 身份与思维模式 + 关键规则（系统提示词底稿）。 */
  persona: string;
  /** 关键规则提炼为条目数组（面试「红线」）。 */
  boundaries: string[];
  /** 技术交付物（面试产出验收锚点）。 */
  deliverables: string;
  /** 工作流程（面试任务设计参考）。 */
  workflow: string;
  provenance: CandidateProvenance;
}

/** 部门目录 → 中文标签的映射（仅展示用，不影响评价）。 */
export const DEPARTMENT_LABELS: Record<string, string> = {
  academic: '学术',
  design: '设计',
  engineering: '工程',
  finance: '金融',
  'game-development': '游戏开发',
  gis: 'GIS',
  hr: '人力资源',
  integrations: '工具集成',
  legal: '法务',
  marketing: '营销',
  'paid-media': '付费媒体',
  product: '产品',
  'project-management': '项目管理',
  sales: '销售',
  security: '安全',
  'spatial-computing': '空间计算',
  specialized: '专项',
  strategy: '战略',
  'supply-chain': '供应链',
  support: '支持',
  testing: '测试',
};

/** 过滤条件：按部门 / 来源 / 关键词筛选候选池。 */
export interface CandidateFilter {
  department?: string;
  origin?: CandidateOrigin;
  /** 在 title/summary/persona 中模糊匹配。 */
  keyword?: string;
}
