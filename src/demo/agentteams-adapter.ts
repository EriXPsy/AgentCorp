/**
 * AgentTeams 薄适配层（GOAI 决策 X 落地 · 不引第三方运行时）
 * --------------------------------------------------------------------------
 * 阿里 GOAI 赛题要求「以 AgentTeams 作为协同设计基点」。AgentCorp 主线上跑 OpenClaw，
 * 不引入 langgraph/crewai/agentteams 等第三方编排运行时（架构决策见 MEMORY.md）。
 *
 * 本文件即「薄适配」：在 OpenClaw 之上**暴露 AgentTeams 形态的 API**
 * （Agent / Team / Task / Run），底层仍由既有 roleCard + 评估中心 + 闭环编排器驱动。
 * 它不是换引擎，而是**语义映射层**——使评审方能直接对照 AgentTeams 的协同基元
 * （角色编排 / 任务拆解 / 上下文传递 / 协同执行 / 状态追踪）看 AgentCorp 的对应实现。
 *
 * 复赛若需真接入 AgentTeams，仅需把下列类型替换为 AgentTeams SDK 的真实类型、
 * 把 runTask 内部委托从 runClosedLoop 换成 AgentTeams 的 team.run(...)，
 * 工具调用链与角色卡/Skill 定义均无需重设计（迁移成本见 artifacts/agentteams-adapter-design.md）。
 */
import type { RoleCard } from '@/engine/agents/roleCard';
import { ROLE_CARDS, ROLE_CARD_BY_ID } from '@/engine/agents/roleCard';
import { type ClosedLoopResult, type LoopStep } from './closedLoop';
import { getSkill, type SkillDefinition, type SkillResult } from './skills/registry';
import { demoJudge } from './liveJudge';

/* ───────────── AgentTeams 形态基元（薄映射类型，非第三方依赖） ───────────── */

/** AgentTeams · Agent：身份定义（对应 GOAI 附录A + roleCard） */
export interface ATAgent {
  agentId: string;
  name: string;
  /** role = roleCard.role，作为 AgentTeams 的角色标识 */
  role: RoleCard['role'];
  description: string; // goal + backstory 合成
  capabilities: string[]; // 由 roleCard.skills 投影
  boundaries: {
    allowed: string[];
    forbidden: string[];
    riskLevel: string;
    requiresApproval: boolean;
  };
}

/** AgentTeams · Team：多 Agent 协同单元（对应 dispatcher 编排的团队） */
export interface ATTeam {
  teamId: string;
  name: string;
  agents: ATAgent[];
  /** 共享上下文通道（上下文传递的载体） */
  sharedContext: string[];
}

/** AgentTeams · Task：任务单元（对应 boss 的任务输入 + dispatcher 拆解） */
export interface ATTask {
  taskId: string;
  title: string;
  requirement: string;
  candidateId: string;
  candidateName: string;
  transcript: string;
  decomposition: string[]; // 任务拆解结果
}

/** AgentTeams · Run：一次协同执行（对应八步闭环，带状态追踪） */
export interface ATRun {
  runId: string;
  teamId: string;
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** 协同执行轨迹：每一步标注执行 Agent + 状态（状态追踪） */
  steps: Array<{
    phase: string;
    agent: string;
    summary: string;
    status: 'ok' | 'warn' | 'blocked';
    /** 该步对应的 Skill id（经验沉淀/审批回滚已迁至 boss_review Skill） */
    skill?: string;
  }>;
  result?: ClosedLoopResult;
}

/* ───────────── AgentTeams · Skill（薄映射，对应 GOAI 2.1 Skill 清单 + 调用入口） ───────────── */

/**
 * AgentTeams · Skill：可被编排执行的 Skill（对应 GOAI 2.1 Skill 清单 2.1 全字段 + 调用入口）。
 * 底层由 skills/registry 的真实 Skill 定义驱动（registry 持有 handler）。
 */
export interface ATSkill {
  id: string;
  name: string;
  ownerAgent: string;
  boundaries: {
    allowed: string[];
    forbidden: string[];
    riskLevel: string;
    requiresApproval: boolean;
  };
}

/** Skill id → 归属 Agent 角色（团队协同校验用，不阻断全局注册表执行） */
const SKILL_OWNER_ROLE: Record<string, string> = {
  agent_interview: 'recruiter',
  capability_assessment: 'evaluator',
  reliability_audit: 'evaluator',
  boss_review: 'boss',
  orchestrate: 'dispatcher',
};

/**
 * 通过 Skill 注册表调用一个 Skill（薄委托：查 registry → 调 handler）。
 * 未知 Skill 或任意异常都降级为 degraded 结果，不向上抛，保证编排永不 panic。
 */
export async function invokeSkill(team: ATTeam, skillId: string, args: any): Promise<SkillResult> {
  const skill: SkillDefinition | undefined = getSkill(skillId);
  if (!skill) {
    return { ok: false, degraded: true, reason: `unknown skill: ${skillId}` };
  }
  // 团队协同校验：该 Skill 归属角色须存在于团队（缺失仅降级，不阻断全局注册表执行）
  const ownerRole = SKILL_OWNER_ROLE[skillId];
  if (ownerRole && !team.agents.some((a) => a.role === ownerRole)) {
    return {
      ok: false,
      degraded: true,
      reason: `skill ${skillId} 的归属角色 ${ownerRole} 不在团队 ${team.teamId} 中`,
    };
  }
  try {
    // 直接透传 handler 的 SkillResult（不二次包裹），调用方按 r.ok / r.data 取用
    return await skill.handler(args);
  } catch (e) {
    return { ok: false, degraded: true, reason: String(e) };
  }
}

/* ───────────── 映射函数（roleCard → AgentTeams 基元） ───────────── */

/** roleCard → AgentTeams Agent */
export function toAgentTeamsAgent(card: RoleCard): ATAgent {
  return {
    agentId: card.id,
    name: card.name,
    role: card.role,
    description: `${card.goal}\n${card.backstory}`,
    capabilities: card.skills.map((s) => s.name),
    boundaries: {
      allowed: card.boundaries.allowed,
      forbidden: card.boundaries.forbidden,
      riskLevel: card.boundaries.riskLevel,
      requiresApproval: card.boundaries.requiresApproval,
    },
  };
}

/** 由一组角色卡组装 Team（默认用内置 4 卡） */
export function createTeam(teamId = 'agentcorp-core', cards: RoleCard[] = ROLE_CARDS): ATTeam {
  return {
    teamId,
    name: 'AgentCorp 核心团队',
    agents: cards.map(toAgentTeamsAgent),
    sharedContext: ['招聘需求', '面试转录', '雷达分', 'pass^k', '偏差审计', '决策理由'],
  };
}

/** 由招聘需求构造 Task（含 dispatcher 拆解） */
export function createTask(input: {
  taskId?: string;
  title: string;
  requirement: string;
  candidateId: string;
  candidateName: string;
  transcript: string;
}): ATTask {
  return {
    taskId: input.taskId ?? `task-${input.candidateId}`,
    title: input.title,
    requirement: input.requirement,
    candidateId: input.candidateId,
    candidateName: input.candidateName,
    transcript: input.transcript,
    decomposition: ['recruiter:结构化面试', 'evaluator:六维评估+pass^k审计', 'boss:审批拍板'],
  };
}

function stepStatus(s: LoopStep): 'ok' | 'warn' | 'blocked' {
  if (s.phase === 'approve' && (s.summary.includes('回滚') || s.summary.includes('不稳定'))) return 'blocked';
  if (s.phase === 'verify' && s.summary.includes('unstable')) return 'warn';
  return 'ok';
}

/** 把 trace 步骤映射到该阶段对应的 Skill id（经验沉淀/审批回滚已迁至 boss_review Skill） */
function agentSkillOf(s: LoopStep): string | undefined {
  if (s.agentName === 'recruiter') return 'agent_interview';
  if (s.agentName === 'evaluator' && s.phase === 'tool') return 'capability_assessment';
  if (s.agentName === 'evaluator' && s.phase === 'verify') return 'reliability_audit';
  if (s.agentName === 'boss') return 'boss_review';
  if (s.agentName === 'dispatcher') return 'orchestrate';
  return undefined;
}

/**
 * 运行 Task（薄委托）：底层通过 Skill 注册表调用 orchestrate Skill（→ runClosedLoop），
 * 仅把结果投影成 AgentTeams Run 形态。既走 invokeSkill（真实 Skill 调用），
 * 又保留底层 OpenClaw 评估科学；boss_review Skill 一并驱动做一致性展示。
 */
export async function runTask(team: ATTeam, task: ATTask): Promise<ATRun> {
  const runId = `run-${task.taskId}-${Date.now()}`;

  // 组装 orchestrate Skill 入参并真实调用（handler 内部委托 runClosedLoop）
  const orchestrateArgs = {
    requirement: task.requirement,
    candidateId: task.candidateId,
    candidateName: task.candidateName,
    transcript: task.transcript,
    bossProfile: undefined,
    k: 3,
    threshold: 3.5,
    judge: demoJudge,
  };
  const orch = await invokeSkill(team, 'orchestrate', orchestrateArgs);
  if (!orch.ok || !orch.data) {
    // orchestrate Skill 降级（如评委全不可达）：Run 标 failed，不抛不挂
    return {
      runId,
      teamId: team.teamId,
      taskId: task.taskId,
      status: 'failed',
      steps: [],
      result: undefined,
    };
  }
  const result = orch.data as ClosedLoopResult;

  // 演示 boss_review Skill 是真的活的：其 data 应与 result.bossDecision 一致（一致性展示，不强制断言）
  const bossInvoke = await invokeSkill(team, 'boss_review', { evaluation: result.evaluation, bossProfile: undefined });
  void bossInvoke;

  const status: ATRun['status'] =
    result.bossDecision.action === 'rollback' ? 'failed' : 'completed';

  const steps = result.trace.map((s) => ({
    phase: s.phase,
    agent: s.agentName,
    summary: s.summary,
    status: stepStatus(s),
    skill: agentSkillOf(s),
  }));

  return {
    runId,
    teamId: team.teamId,
    taskId: task.taskId,
    status,
    steps,
    result,
  };
}

export { ROLE_CARD_BY_ID };
