/**
 * HiClaw / AgentTeams CRD 导出
 * --------------------------------------------------------------------------
 * 背景：AgentTeams 是一个多智能体治理与协作平台，其管理层基于开源项目
 * HiClaw（github.com/agentscope-ai/HiClaw），采用 **K8s-native 声明式 CRD**
 * （apiVersion `hiclaw.io/v1beta1`）描述组织结构，并显式分层为
 * 平台管控（TeamAdmin）→ 业务协作（TeamLeader）→ 执行（Worker）。
 *
 * 为什么需要它：`agentteams-adapter.ts` 提供的是「形态同构」的类型层，
 * 但要论证「可迁移到 AgentTeams」，需要产出**可核对的声明式产物**。
 * 本模块把映射变成一条命令：4 张 RoleCard → HiClaw 声明式 CRD YAML，
 * 可直接对照 HiClaw CRD 规范逐字段核，从而量化迁移成本。
 *
 * 映射对照（这也是迁移对照表的真相源）：
 *
 *   HiClaw CRD          AgentCorp 对应物                      落点
 *   ─────────────────── ───────────────────────────────────── ──────────────────────
 *   Team                AgentTeams Team（4 卡组成的协同单元）   createTeam()
 *   TeamAdmin           boss 角色卡（唯一持录用/回滚授权）      roleCard.ts ROLE_CARDS[0]
 *   TeamLeader          dispatcher 角色卡（拆解/上下文/监控）   roleCard.ts ROLE_CARDS[3]
 *   Worker              recruiter / evaluator（无状态执行）    roleCard.ts ROLE_CARDS[1,2]
 *   Worker.skills       RoleCardSkill → Skill 注册表           skills/registry.ts
 *   人在回路             requiresApproval + 审批门              engine/governance/approvalGate.ts
 *   凭证隔离（Higress）  Host API session token（主进程持有）   electron/api/route-utils.ts
 *
 * 重要边界（诚实标注）：本模块产出的是**符合 HiClaw 形态的声明式描述**，
 * 用于论证「迁移成本 = 协议适配而非重新设计」。它**不代表**已在 HiClaw
 * 控制面上真实 reconcile 过——真机部署为后续工程项。
 *
 * 纯函数、零依赖、无副作用，vitest 与 web demo 均可直接运行。
 */
import type { RoleCard } from '@/engine/agents/roleCard';
import { ROLE_CARDS } from '@/engine/agents/roleCard';

/** HiClaw CRD 的 apiVersion（与 HiClaw v1beta1 规范一致）。 */
export const HICLAW_API_VERSION = 'hiclaw.io/v1beta1';

/** HiClaw 的四种核心 Kind。 */
export type HiclawKind = 'Team' | 'TeamAdmin' | 'TeamLeader' | 'Worker';

/** 通用 CRD 信封。 */
export interface HiclawResource<TSpec = Record<string, unknown>> {
  apiVersion: typeof HICLAW_API_VERSION;
  kind: HiclawKind;
  metadata: {
    name: string;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: TSpec;
}

/**
 * RoleCard 的职能 → HiClaw Kind。
 *
 * 依据 HiClaw 的分层语义：
 *  - TeamAdmin  = 平台管控层（授权、审批、高风险动作把关）→ boss
 *  - TeamLeader = 业务协作层（意图理解、任务拆解、进度监控）→ dispatcher
 *  - Worker     = 执行层（无状态、按 skill 干活）→ 其余职能
 */
export function toHiclawKind(card: RoleCard): HiclawKind {
  if (card.role === 'boss') return 'TeamAdmin';
  if (card.role === 'dispatcher') return 'TeamLeader';
  return 'Worker';
}

/** 把 RoleCard 导出为单个 HiClaw 资源。 */
export function roleCardToHiclawResource(card: RoleCard): HiclawResource {
  const kind = toHiclawKind(card);
  return {
    apiVersion: HICLAW_API_VERSION,
    kind,
    metadata: {
      name: card.id,
      labels: {
        'agentcorp.io/role': card.role,
        'agentcorp.io/team-role': card.teamRole,
        'agentcorp.io/lifecycle': card.lifecycleStatus,
        'hiclaw.io/risk-level': card.boundaries.riskLevel,
      },
      annotations: {
        // 落地模块指针：从 CRD 可直接定位到实现代码
        'agentcorp.io/impl-module': card.impl.module ?? '',
        'agentcorp.io/owns-phases': card.ownsPhases.join(','),
      },
    },
    spec: {
      displayName: card.name,
      goal: card.goal,
      backstory: card.backstory,
      responsibility: card.responsibility,
      ...(card.reportsTo ? { reportsTo: card.reportsTo } : {}),
      model: card.model,
      channels: card.channels,
      /** Worker 的 skill 集合（HiClaw 的动态技能加载对应物） */
      skills: card.skills.map((s) => ({
        name: s.id,
        displayName: s.name,
        description: s.purpose,
        inputs: s.inputs,
        outputs: s.outputs,
        invokeCondition: s.invokeCondition,
        dependsOn: s.dependsOn,
        failureHandling: s.failureHandling,
        securityBoundary: s.securityBoundary,
      })),
      /** 能力边界 → HiClaw 的权限与审批策略 */
      policy: {
        allowed: card.boundaries.allowed,
        forbidden: card.boundaries.forbidden,
        riskLevel: card.boundaries.riskLevel,
        /** 人在回路：高风险动作必须人工确认（对应 approvalGate 的门） */
        requiresHumanApproval: card.boundaries.requiresApproval,
      },
      /** 协同关系 → HiClaw 的 Team 内消息路由意图 */
      collaborators: card.collaborators.map((c) => ({
        role: c.role,
        handoff: c.handoff,
        sharedContext: c.sharedContext,
      })),
      capabilities: card.capabilities,
    },
  };
}

/** 组装 Team 资源（引用其成员）。 */
export function buildHiclawTeam(
  teamName: string,
  cards: RoleCard[] = ROLE_CARDS,
): HiclawResource {
  const admin = cards.find((c) => toHiclawKind(c) === 'TeamAdmin');
  const leader = cards.find((c) => toHiclawKind(c) === 'TeamLeader');
  const workers = cards.filter((c) => toHiclawKind(c) === 'Worker');

  return {
    apiVersion: HICLAW_API_VERSION,
    kind: 'Team',
    metadata: {
      name: teamName,
      labels: { 'agentcorp.io/purpose': 'agent-admission-governance' },
      annotations: {
        'agentcorp.io/closed-loop-phases':
          'input,decompose,context,tool,verify,evidence,approve,precipitate',
      },
    },
    spec: {
      displayName: 'AgentCorp 准入治理团队',
      ...(admin ? { teamAdmin: admin.id } : {}),
      ...(leader ? { teamLeader: leader.id } : {}),
      workers: workers.map((w) => w.id),
      /** 共享上下文通道（HiClaw 的 Matrix 房间 / 共享存储对应物） */
      sharedContext: ['招聘需求', '面试转录', '雷达分', 'pass^k', '偏差审计', '决策理由'],
      /**
       * 通信底座声明。
       * 现状：本项目走 gateway WS RPC + A2aTraceRecord 落盘；
       * HiClaw 生产形态为 Matrix（Tuwunel homeserver）。
       * 二者均为「消息 + 留痕」语义，替换点在传输层，不涉及业务逻辑。
       */
      transport: {
        current: 'openclaw-gateway-ws-rpc',
        hiclawEquivalent: 'matrix',
        traceSink: '~/.openclaw/a2a-traces/*.jsonl',
      },
      /**
       * 凭证托管声明。
       * 现状：Host API per-session token，密钥只存在于 Electron 主进程，渲染层拿不到；
       * HiClaw 生产形态为 Higress AI Gateway 托管真实凭证、Worker 仅持 Consumer Token。
       * 语义一致：执行体不持有真实密钥。
       */
      credentials: {
        current: 'host-api-session-token（主进程持有，渲染层不可见）',
        hiclawEquivalent: 'higress-consumer-token',
        principle: 'worker-never-holds-real-credentials',
      },
    },
  };
}

/* ───────────────────────── YAML 序列化（零依赖） ───────────────────────── */

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // 含特殊字符/换行/中文冒号时用双引号包裹并转义
  if (s === '' || /[:#\-?*&!|>'"%@`{}[\],\n]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return s;
}

function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const block = toYaml(item, indent + 1);
          // 数组元素为对象：首行提到 `- ` 后面
          return `${pad}- ${block.slice((indent + 1) * 2)}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join('\n');
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          const inner = toYaml(v, indent + 1);
          return `${pad}${k}:\n${inner}`;
        }
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`;
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${yamlScalar(v)}`;
      })
      .join('\n');
  }

  return `${pad}${yamlScalar(value)}`;
}

/** 单个资源 → YAML 文档。 */
export function resourceToYaml(res: HiclawResource): string {
  return toYaml(res);
}

/**
 * 导出整个团队的 HiClaw 清单（多文档 YAML，`---` 分隔）。
 * 顺序：Team → TeamAdmin → TeamLeader → Worker（与 K8s 惯例一致：先声明容器再声明成员）。
 */
export function exportHiclawManifest(
  teamName = 'agentcorp-core',
  cards: RoleCard[] = ROLE_CARDS,
): string {
  const order: HiclawKind[] = ['TeamAdmin', 'TeamLeader', 'Worker'];
  const sorted = [...cards].sort(
    (a, b) => order.indexOf(toHiclawKind(a)) - order.indexOf(toHiclawKind(b)),
  );
  const docs = [
    buildHiclawTeam(teamName, cards),
    ...sorted.map(roleCardToHiclawResource),
  ];
  const header = [
    '# HiClaw / AgentTeams 声明式清单（由 AgentCorp RoleCard 自动导出）',
    '# 生成命令：pnpm agentteams:export',
    '#',
    '# 用途：论证可迁移性——4 张角色卡可无损映射为',
    '#       HiClaw 的 Team / TeamAdmin / TeamLeader / Worker 四种 CRD。',
    '# 边界：本清单为形态对齐产物，用于评估迁移成本；尚未在 HiClaw 控制面真实 reconcile。',
    '',
  ].join('\n');
  return header + docs.map(resourceToYaml).join('\n---\n') + '\n';
}

/** 迁移成本自查表（供文档直接引用）。 */
export const MIGRATION_MATRIX: Array<{
  concern: string;
  agentcorpNow: string;
  hiclawTarget: string;
  cost: '协议适配' | '配置替换' | '需新增工程';
}> = [
  {
    concern: '组织结构声明',
    agentcorpNow: 'ROLE_CARDS（TS 常量）',
    hiclawTarget: 'Team/TeamAdmin/TeamLeader/Worker CRD',
    cost: '协议适配',
  },
  {
    concern: 'Skill 定义与调用',
    agentcorpNow: 'Skill 注册表 + invokeSkill（含边界校验）',
    hiclawTarget: 'Worker.skills + HiClaw skill 调用',
    cost: '协议适配',
  },
  {
    concern: '通信底座',
    agentcorpNow: 'gateway WS RPC + A2aTrace JSONL',
    hiclawTarget: 'Matrix（Tuwunel homeserver）',
    cost: '配置替换',
  },
  {
    concern: '凭证托管',
    agentcorpNow: 'Host API session token（主进程持有）',
    hiclawTarget: 'Higress AI Gateway + Consumer Token',
    cost: '配置替换',
  },
  {
    concern: '人在回路审批',
    agentcorpNow: 'approvalGate（门 + 补偿 + 审计流水）',
    hiclawTarget: 'HiClaw 群聊 @ 人工介入',
    cost: '协议适配',
  },
  {
    concern: '控制面 reconcile',
    agentcorpNow: '无（进程内编排）',
    hiclawTarget: 'hiclaw-controller',
    cost: '需新增工程',
  },
];
