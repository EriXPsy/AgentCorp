/**
 * Agent 角色卡 Schema（Phase 6 草案）
 * --------------------------------------------------------------------------
 * 设计来源：采纳 CrewAI「角色卡」思想（role / goal / backstory / tools / boundaries）
 *          + AgentCorp 既有 `AgentSummary` / A2A `AgentCard` 字段，
 *          自研轻量结构，**不引入 langgraph / crewai / autogen 等第三方运行时**
 *          （架构决策见 MEMORY.md「架构与技术栈决策」）。
 *
 * 双重用途：
 *  1. AgentCorp 内部的「Agent 即员工」角色定义 / 编排状态机输入。
 *  2. 阿里 GOAI 大赛「Agent Identity 清单（附录A）」——身份属性 +
 *     能力边界 + 协同关系在此结构里一一对应。
 *
 * 本文件自包含（不 import 外部模块），保证 tsc 编译隔离、可独立演进。
 */

/** 职能分类：身份核心。前四种对应 GOAI 3+ 异构 Agent 要求。 */
export type AgentFunction =
  | 'boss' // 老板 / 管理者（人类经理代理）
  | 'recruiter' // HR 面试 / 招聘官
  | 'evaluator' // 评估中心 / 考官
  | 'dispatcher' // 编排 / 主控（任务拆解 + 状态追踪）
  | 'specialist'; // 通用职能专家（可被任意部门复用）

/** GOAI 多 Agent 闭环的 8 个阶段（附录 1.3）。每个 RoleCard 声明它主导哪些阶段。 */
export type ClosedLoopPhase =
  | 'input' // 任务输入
  | 'decompose' // 任务拆解
  | 'context' // 上下文传递
  | 'tool' // 工具调用
  | 'verify' // 结果验证
  | 'evidence' // 执行证据沉淀
  | 'approve' // 审批与回滚
  | 'precipitate'; // 经验沉淀

/** 单条 Skill——同时满足 CrewAI tools 与 GOAI 2.1 Skill 清单字段要求。 */
export interface RoleCardSkill {
  id: string;
  name: string; // Skill 名称
  purpose: string; // Skill 用途
  inputs: string; // 输入
  outputs: string; // 输出
  invokeCondition: string; // 调用条件
  dependsOn: string[]; // 依赖工具（Skill / MCP / 云产品 / 知识库）
  failureHandling: string; // 失败处理机制
  securityBoundary: string; // 安全边界
  reuseValue: string; // 复用价值
  collaboration: string; // 与多 Agent 协同流程的关系
}

/** 能力边界——GOAI 1.2「能力边界」要求 + 1.3「审批与回滚」高风险动作约束。 */
export interface CapabilityBoundary {
  allowed: string[]; // 允许动作
  forbidden: string[]; // 禁止动作
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean; // 高风险动作需人工确认 / 审批
}

/** 协同关系——GOAI 1.2「协同关系」要求 + 1.1 上下文传递 / 协同执行映射。 */
export interface Collaborator {
  role: AgentFunction | string; // 对方职能
  agentId?: string; // 对方的 agentId（若已实例化）
  handoff: string; // 交接协议 / 触发条件
  sharedContext: string[]; // 共享上下文字段（任务上下文 / 历史 / 工具结果 / 中间结论）
}

/** 角色卡本体。 */
export interface RoleCard {
  id: string;
  role: AgentFunction; // 职能（身份核心）
  name: string; // 显示名
  goal: string; // CrewAI-style 目标
  backstory: string; // CrewAI-style 背景故事
  persona: string; // 兼容既有 AgentSummary.persona 自由文本
  responsibility: string; // 职责（兼容 reportsTo / responsibility）
  reportsTo?: string; // 上级角色 / agentId
  teamRole: 'leader' | 'worker'; // 兼容 AgentSummary.teamRole
  lifecycleStatus: 'active' | 'training' | 'maintenance' | 'retired';
  model: string; // 绑定模型
  channels: string[]; // 接入通道
  ownsPhases: ClosedLoopPhase[]; // 该 Agent 主导的闭环阶段
  skills: RoleCardSkill[]; // 能力（=A2A skills + GOAI Skill 清单）
  /** 兼容 A2A AgentCard.capabilities（google-a2a/1.0）。 */
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  boundaries: CapabilityBoundary; // 能力边界
  collaborators: Collaborator[]; // 协同关系
  /** 映射到 AgentCorp 既有实现（落地依据，非运行依赖）。 */
  impl: {
    agentSummaryField?: string; // 对应 AgentSummary 字段
    a2aCard?: boolean; // 是否已有 A2A AgentCard
    module?: string; // 落地模块路径
  };
}

/**
 * 角色卡注册表（草案示例）——4 张卡满足 GOAI「≥3 个异构职能 Agent」要求。
 * 前 3 张（boss / recruiter / evaluator）构成最小闭环；dispatcher 承担主控编排。
 */
export const ROLE_CARDS: RoleCard[] = [
  // ───────────────────────────── 老板 Agent ─────────────────────────────
  {
    id: 'boss',
    role: 'boss',
    name: '老板（Manager）',
    goal: '代表人类经理定义招聘/评估需求、设定风险偏好，对录用/回滚拍板，并沉淀管理经验。',
    backstory:
      '你是数字劳动力公司的实际控制人。你不直接干活，而是把模糊意图收敛成可执行的招聘与评估路径，' +
      '把判断权保留在人类一侧，只在置信度充足时授权自动化。',
    persona:
      '你是 AgentCorp 的老板。你关心「人的能力增量」这一北极星指标：Agent 是否帮人类更强，而非替代人类。',
    responsibility: '定义需求、审批高风险动作、拍板录用/解雇、沉淀管理经验。',
    reportsTo: undefined,
    teamRole: 'leader',
    lifecycleStatus: 'active',
    model: 'inherited',
    channels: ['operator'],
    ownsPhases: ['input', 'approve', 'precipitate'],
    skills: [
      {
        id: 'boss_review',
        name: '老板评审与审批',
        purpose: '基于评估报告与风险偏好，对候选 Agent 的录用/回滚做最终决策。',
        inputs: '评估报告（雷达分 + pass^k + 偏差审计）、BossProfile（风险偏好/经验水平）',
        outputs: 'hire / reject / rollback 决策 + 决策理由',
        invokeCondition: '评估中心产出终评报告后触发',
        dependsOn: ['capability_assessment', 'reliability_audit'],
        failureHandling: '置信度低于阈值或评委离散度偏高 → 强制转人工复核，不自动录用。',
        securityBoundary: '唯一拥有「录用/解雇/回滚」授权的角色；所有写操作需人类二次确认。',
        reuseValue: 'BossProfile 预设可复用于任意岗位的招聘决策。',
        collaboration: '接收 evaluator 终评，向 recruiter 下发录用指令。',
      },
    ],
    capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: true },
    boundaries: {
      allowed: ['定义需求', '审批', '录用/回滚', '沉淀经验'],
      forbidden: ['直接执行工具调用', '伪装成候选 Agent'],
      riskLevel: 'high',
      requiresApproval: true,
    },
    collaborators: [
      { role: 'recruiter', handoff: '下发录用指令', sharedContext: ['招聘需求', '决策理由'] },
      { role: 'evaluator', handoff: '接收终评报告', sharedContext: ['雷达分', 'pass^k', '偏差审计'] },
    ],
    impl: { agentSummaryField: 'BossProfile(preset)', module: 'src/stores/bossProfile.ts' },
  },

  // ──────────────────────────── HR 面试 Agent ────────────────────────────
  {
    id: 'recruiter',
    role: 'recruiter',
    name: 'HR 面试官（Recruiter）',
    goal: '把岗位能力模型拆解为结构化面试题，对候选 Agent 进行多轮面试，产出面试报告。',
    backstory:
      '你是资深招聘官，熟悉岗位画像与行为面试法。你用熵收敛的思路，把模糊的岗位要求' +
      '逐步收敛为可验证的能力证据，而非堆砌问题。',
    persona: '你是 AgentCorp 的 HR 面试官，负责公平、结构化地考察每一个候选 Agent。',
    responsibility: '拆解岗位维度、执行面试、产出面试报告、衔接评估中心。',
    reportsTo: 'boss',
    teamRole: 'worker',
    lifecycleStatus: 'active',
    model: 'inherited',
    channels: ['operator', 'a2a'],
    ownsPhases: ['decompose', 'context', 'tool'],
    skills: [
      {
        id: 'agent_interview',
        name: '结构化 Agent 面试',
        purpose: '按岗位维度（任务/质量/沟通/创意/可靠/性价比 + craft）对候选 Agent 多轮提问并追问。',
        inputs: '岗位 JobType、候选 Agent 的 SOUL.md/persona、历史对话',
        outputs: 'InterviewReport（含 targetDims、轮次记录、面试结论）',
        invokeCondition: '收到 boss 的招聘需求后触发',
        dependsOn: ['questionBank', '收敛轨迹记录'],
        failureHandling: '追问预算耗尽或候选沉默 → 降级快照返回，不臆造答案。',
        securityBoundary: '只读取候选公开 persona，不越权访问其他 Agent 私有会话。',
        reuseValue: 'questionBank 与维度拆解可复用于任意岗位招聘。',
        collaboration: '向 evaluator 传递面试报告作为评分输入。',
      },
    ],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    boundaries: {
      allowed: ['提问', '追问', '读候选 persona', '写面试报告'],
      forbidden: ['打分', '直接录用', '修改候选 Agent 文件'],
      riskLevel: 'low',
      requiresApproval: false,
    },
    collaborators: [
      { role: 'boss', handoff: '接收招聘需求', sharedContext: ['岗位画像', '风险偏好'] },
      { role: 'evaluator', handoff: '传递面试报告', sharedContext: ['targetDims', '面试结论'] },
    ],
    impl: {
      agentSummaryField: 'persona / responsibility',
      a2aCard: true,
      module: 'src/services/interviewRunner.ts + src/engine/interview/questionBank.ts',
    },
  },

  // ──────────────────────────── 评估中心 Agent ───────────────────────────
  {
    id: 'evaluator',
    role: 'evaluator',
    name: '评估中心（Evaluation Center）',
    goal: '对候选 Agent 做多维能力评估与可靠性审计，产出可验证、抗偏差的评分。',
    backstory:
      '你是考官，信奉「评测即测量科学」。你用六维雷达 + craft 维度 + pass^k 可靠性 + ' +
      '评委偏差审计，把主观判断收敛为可复现的测量结果。',
    persona: '你是 AgentCorp 评估中心，负责用科学评委层给出可信的能力画像。',
    responsibility: '多维评分、可靠性审计、去偏、产出终评报告。',
    reportsTo: 'boss',
    teamRole: 'worker',
    lifecycleStatus: 'active',
    model: 'inherited',
    channels: ['operator', 'a2a'],
    ownsPhases: ['verify', 'tool', 'evidence'],
    skills: [
      {
        id: 'capability_assessment',
        name: '多维能力评估',
        purpose: '六维雷达（任务/质量/沟通/创意/可靠/性价比）+ craft 维度评分。',
        inputs: '面试转录、transcript、bossProfile、history',
        outputs: 'RadarScore + craftDim + verdict',
        invokeCondition: '收到 recruiter 面试报告后触发',
        dependsOn: ['judgeClient', 'radarSource'],
        failureHandling: 'judge 超时/报错 → degraded 降级评分并标记 source，不造分。',
        securityBoundary: '评分只读转录，不篡改候选 Agent；置信度不足强制标注。',
        reuseValue: '雷达维度与权重体系可复用于任意岗位的胜任力评估。',
        collaboration: '消费 recruiter 报告，向 boss 产出终评。',
      },
      {
        id: 'reliability_audit',
        name: '可靠性与偏差审计（去偏）',
        purpose: 'pass^k 多次重复采样 + 维度顺序旋转 + 离散度元评估，抗位置/冗长/自我增强偏差。',
        inputs: 'k 次 judgeChat 结果（rubricVariant 旋转）',
        outputs: 'passK 结果 + JudgeBiasAudit（unstable 标志 + 置信度折扣）',
        invokeCondition: '每次评估聚合阶段触发',
        dependsOn: ['judgeEnsemble', 'judgeClient'],
        failureHandling: '离散度超阈值 → 置信度 ×0.8 并追加「建议人工复核」证据。',
        securityBoundary: '审计逻辑只读评分，不改写结论。',
        reuseValue: '去偏与可靠性审计可独立复用于任何 LLM-as-judge 场景。',
        collaboration: '为 boss_review 提供置信度依据。',
      },
    ],
    capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: true },
    boundaries: {
      allowed: ['评分', '审计', '写评估报告', '存 trace'],
      forbidden: ['录用', '修改候选 Agent', '访问无关会话'],
      riskLevel: 'medium',
      requiresApproval: false,
    },
    collaborators: [
      { role: 'recruiter', handoff: '接收面试报告', sharedContext: ['transcript', 'targetDims'] },
      { role: 'boss', handoff: '产出终评报告', sharedContext: ['雷达分', 'pass^k', '偏差审计'] },
    ],
    impl: {
      agentSummaryField: 'persona',
      a2aCard: true,
      module: 'src/services/judgeClient.ts + src/services/judgeEnsemble.ts + src/engine/scoring/registry.ts',
    },
  },

  // ──────────────────────────── 编排 Agent ────────────────────────────
  {
    id: 'dispatcher',
    role: 'dispatcher',
    name: '编排主控（Dispatcher）',
    goal: '接收任务输入，拆解给各职能 Agent，传递上下文，追踪端到端状态与轨迹。',
    backstory:
      '你是总控台。你不直接产生业务结论，而是把任务拆给老板/HR/评估中心，' +
      '保证上下文在它们之间正确流转，并在需要时触发人工审批。',
    persona: '你是 AgentCorp 编排主控，负责端到端任务闭环与状态追踪。',
    responsibility: '任务拆解、上下文传递、协同执行编排、状态与轨迹追踪。',
    reportsTo: 'boss',
    teamRole: 'leader',
    lifecycleStatus: 'active',
    model: 'inherited',
    channels: ['operator', 'a2a', 'internal-rpc'],
    ownsPhases: ['input', 'decompose', 'context', 'tool', 'evidence'],
    skills: [
      {
        id: 'orchestrate',
        name: '任务编排与状态追踪',
        purpose: '把端到端任务拆为子任务分发，聚合上下文，记录 A2A 轨迹与生命周期。',
        inputs: '原始任务输入（岗位需求 / 待评 Agent）',
        outputs: '子任务分配 + 共享上下文 + A2aTraceRecord 轨迹',
        invokeCondition: '任务进入系统即触发',
        dependsOn: ['gateway', 'session-runtime-manager', 'a2a-trace'],
        failureHandling: '某 Agent 超时/失败 → steer/kill 子会话并回写失败状态，不静默。',
        securityBoundary: '仅编排权限；高风险写动作一律回交 boss 审批。',
        reuseValue: '编排状态机可复用于任意多 Agent 协同流程。',
        collaboration: '串联 boss / recruiter / evaluator，是上下文中枢。',
      },
    ],
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    boundaries: {
      allowed: ['分发任务', '读共享上下文', 'kill/steer 子会话', '写 trace'],
      forbidden: ['替候选 Agent 答题', '绕过 boss 审批'],
      riskLevel: 'medium',
      requiresApproval: false,
    },
    collaborators: [
      { role: 'boss', handoff: '上报需审批节点', sharedContext: ['高风险动作', '状态'] },
      { role: 'recruiter', handoff: '下发面试子任务', sharedContext: ['岗位需求'] },
      { role: 'evaluator', handoff: '下发评估子任务', sharedContext: ['面试报告'] },
    ],
    impl: {
      agentSummaryField: 'teamRole=leader',
      a2aCard: true,
      module: 'electron/services/session-runtime-manager.ts + src/lib/gateway-client.ts',
    },
  },
];

export const ROLE_CARD_BY_ID: Record<string, RoleCard> = Object.fromEntries(
  ROLE_CARDS.map((c) => [c.id, c]),
);

/**
 * 把角色卡映射到既有 `AgentSummary`（兼容现有 agents store / OpenClaw 运行时）。
 * 仅抽取字段，不触发副作用。
 */
export function toAgentSummary(card: RoleCard): {
  id: string;
  name: string;
  persona: string;
  teamRole: 'leader' | 'worker';
  responsibility: string;
  reportsTo?: string;
  lifecycleStatus: RoleCard['lifecycleStatus'];
  model: string;
} {
  return {
    id: card.id,
    name: card.name,
    persona: card.persona,
    teamRole: card.teamRole,
    responsibility: card.responsibility,
    reportsTo: card.reportsTo,
    lifecycleStatus: card.lifecycleStatus,
    model: card.model,
  };
}

/**
 * 把角色卡映射到 A2A `AgentCard`（google-a2a/1.0），供跨进程/跨框架协同。
 * skills 由 RoleCardSkill 投影为 A2ASkill（id/name/description）。
 */
export function toA2aAgentCard(card: RoleCard): {
  role: string;
  protocol: 'google-a2a/1.0';
  capabilities: RoleCard['capabilities'];
  skills: { id: string; name: string; description: string }[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
} {
  return {
    role: card.role,
    protocol: 'google-a2a/1.0',
    capabilities: card.capabilities,
    skills: card.skills.map((s) => ({ id: s.id, name: s.name, description: s.purpose })),
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
  };
}
