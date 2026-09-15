# AgentCorp × A2A（Agent2Agent）通信集成设计

> 通信层集成设计。本文档回答三个问题：A2A 协议现状是什么；AgentCorp 底座已有的 agent 编排能力映射到哪些私有协议；如何分层集成 A2A，并把 A2A trace 变成六维评估的客观证据链（本项目区别于普通 A2A 集成的独特点）。
> 文中关于本仓库现状的论断均给出 `文件:行号` 依据，协议事实附权威来源链接。
> 性质：设计文档，不改代码。

---

## 1. A2A 协议现状调研（截至 2026-08）

### 1.1 版本与治理

- **首发**：2025-04-09 由 Google 官宣，50+ 合作伙伴（Atlassian、Salesforce、SAP、ServiceNow、LangChain 等）。
  来源：https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- **捐赠 Linux Foundation**：2025-06-23，LF 在 Open Source Summit North America 宣布成立 Agent2Agent (A2A) project，Google 捐赠，AWS / Cisco / Google / IBM Research / Microsoft / Salesforce / SAP / ServiceNow 组成 TSC，Apache 2.0。
  来源：https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents ；治理见 https://a2a-protocol.org/latest/
- **当前规范版本：v1.0.0**（2026-03-12 发布），最新补丁 **v1.0.1**（2026-05）。协议协商只用 Major.Minor（`A2A-Version: 1.0` 头），patch 不影响兼容性。
  来源：https://a2a-protocol.org/latest/specification/ ；https://github.com/a2aproject/A2A/releases
- **版本史**：0.1（2025-04 首发草案）→ 0.2.x（2025-05~07）→ 0.3.0（2025-07-30）→ 1.0.0（2026-03-12）。
- **已知破坏性变更（对集成选型关键）**：
  - 0.2→0.3：well-known URI 由 `/.well-known/agent.json` 改名 `/.well-known/agent-card.json`；新增 mTLS、extended card、AgentCard JWS 签名。
  - 0.3→1.0：大量 breaking——AgentCard 顶层 `url` 改为 `supportedInterfaces` 数组；OAuth flow 现代化（移除 implicit/password，加 device code / PKCE）；统一美式拼写 `canceled`；规范重构为「数据模型 / 抽象操作 / 协议绑定」三层（`specification/a2a.proto` 为唯一 normative 源）。
  - 兼容策略：1.0 起客户端必须带 `A2A-Version` 头，服务端不支持则返回 `VersionNotSupportedError`。
  来源：https://github.com/a2aproject/A2A/releases ；https://a2a-protocol.org/latest/specification/ §3.6

**结论**：现在集成直接瞄准 **v1.0**，跳过 0.x（0.x 已被 1.0 多处 break，且无长期支持承诺）。

### 1.2 核心概念（v1.0 spec）

| 概念 | 要点 | 来源 |
|---|---|---|
| **AgentCard** | agent 的能力名片。v1.0 字段：`name` / `description` / `supportedInterfaces`（url + protocolBinding + protocolVersion，取代旧顶层 `url`）/ `provider` / `version` / `capabilities` / `securitySchemes` + `security` / `defaultInputModes` / `defaultOutputModes` / `skills` / `signatures`（0.3 起 JWS 签名）/ `iconUrl` | https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto |
| **发现** | well-known 路径 `/.well-known/agent-card.json`；另有认证后的 extended agent card | spec §5 |
| **Task** | 任务状态机：`submitted` → `working` → 终态 `completed` / `failed` / `canceled` / `rejected`；中断态 `input-required` / `auth-required`（可恢复） | spec §4 |
| **Message / Part** | Message 有 role（user/agent）+ parts；Part 三种：`TextPart` / `FilePart` / `DataPart`（结构化 JSON） | spec §3.7 |
| **Artifact** | 任务的产出物，与通信用 Message 明确分离——「agent 之间只交换任务/消息/产出物，不共享内部状态」 | spec §4 |
| **更新机制** | 轮询（Get Task）、SSE 流式（`text/event-stream`）、push notification（webhook HTTP POST）；v1.0 新增 `tasks/list` 与 `returnImmediately` 阻塞语义 | spec §3.5 |
| **传输绑定** | 三种并列：JSON-RPC 2.0 over HTTP（SSE 流式）、gRPC、HTTP+JSON/REST（`POST /message:send`、`/message:stream` 等） | spec §9–11 |

### 1.3 与 MCP 的分工

官方原话："**MCP is for agent-to-tool communication**；**A2A is for agent-to-agent communication**"；"MCP and A2A are not competitors — they are highly complementary"。口诀：Build with ADK, equip with MCP, communicate with A2A。
来源：https://a2a-protocol.org/latest/ （"How A2A Works with MCP"）

对本项目的含义：OpenClaw 底座的 MCP 集成（`electron/api/routes/mcp.ts`）管「agent→工具」，A2A 管「agent↔agent」，两者不冲突、分层共存。

### 1.4 官方 SDK（a2aproject 组织，版本为 2026-07 实测）

| 语言 | 包 / 仓库 | 最新版本 | 备注 |
|---|---|---|---|
| Python | PyPI `a2a-sdk` / [a2a-python](https://github.com/a2aproject/a2a-python) | 1.1.2（2026-07-22） | 可用于 model-service 侧联调 |
| **JS/TS** | npm `@a2a-js/sdk` / [a2a-js](https://github.com/a2aproject/a2a-js) | **1.0.1（2026-07-28）** | **本项目主选**（Electron 主进程为 Node/TS） |
| Java | [a2a-java](https://github.com/a2aproject/a2a-java) | v1.1.0.Final | — |
| Go | [a2a-go](https://github.com/a2aproject/a2a-go) | v2.4.0 | 实现 spec v1.0 三传输 |
| .NET | [a2a-dotnet](https://github.com/a2aproject/a2a-dotnet) | 1.0.0-preview2（预览） | 未正式 GA |
| Rust | [a2a-rust](https://github.com/a2aproject/a2a-rust) | 无 release | 成熟度未确认 |

### 1.5 安全 / 鉴权

- AgentCard 声明 `securitySchemes` + `security`（仿 OpenAPI），五种 scheme：**APIKey、HTTP Auth（含 Bearer）、OAuth2、OpenID Connect、mTLS**（0.3 起 skill 级也可指定 security）。来源：spec §4.5
- 协议本身不规定凭证获取方式（out-of-band 交换）；提供 `auth-required` 任务状态做 in-task 授权委托。
- **AgentCard JWS 签名**（0.3 起）：给能力描述文件盖加密签名防伪。产品需求已明确这是市集防伪的必选项（「签名 Agent Card 防伪——必须从一开始就焊死」）。

### 1.6 生态

捐赠时 100+ 公司支持；Microsoft 2025-05-07 宣布 Azure AI Foundry 与 Copilot Studio 支持 A2A（https://www.microsoft.com/en-us/microsoft-cloud/blog/2025/05/07/empowering-multi-agent-apps-with-the-open-agent2agent-a2a-protocol）；LangGraph / CrewAI / Semantic Kernel / ADK 均可互连。

---

## 2. 现状映射：AgentCorp 底座已有的 agent 编排能力

AgentCorp 底座（fork 自 OpenClaw）已经有一套**完整但完全私有**的 agent 编排栈。下表逐层列出能力、落点、以及它今天用的私有协议/数据格式。

### 2.1 Gateway 通信层：JSON-RPC 2.0 over WebSocket

- Electron 主进程 fork OpenClaw gateway 子进程，启动参数带 `--token <gatewayToken>`（`electron/gateway/config-sync.ts:388`），token 同时写入 `OPENCLAW_GATEWAY_TOKEN` 环境变量（`config-sync.ts:418`）。
- 连接走 `ws://localhost:<port>/ws`（`electron/gateway/ws-client.ts:209-213`），握手为 `connect.challenge` + `auth.token`（`ws-client.ts:187-188`）。
- 协议类型定义为标准 JSON-RPC 2.0（`electron/gateway/protocol.ts:9-14`），实际线上帧格式是 OpenClaw 私有的 `{ type: "req", id, method, params }`（`electron/gateway/manager.ts:619-621`）。
- 事件推送为私有事件类型枚举（`gateway.status_changed` / `chat.message_received` / `tool.call_started` 等，`protocol.ts:83-98`）。

**协议性质**：私有 JSON-RPC-over-WS，与 A2A 的「JSON-RPC 2.0 over HTTP + SSE」**结构同族但不可互操作**——这是个好消息，桥接成本低。

### 2.2 Host API：Electron 主进程的本地 HTTP 控制面

- `electron/api/server.ts` 起一个只绑 `127.0.0.1` 的 HTTP server（`server.ts:101`），所有请求统一走 `isAuthorizedHostApiRequest`（`server.ts:85-88`），凭证为**每次启动随机生成的 32 字节 hex session token**（`server.ts:58-74`，header `x-clawx-host-session`）。
- 路由按域拆分：`sessions` / `teams` / `tasks` / `evaluate` / `gateway` 等（`server.ts:35-56`）。

**协议性质**：私有 REST + per-session token，纯本地面向 renderer 与 IPC 代理，**不对外**。

### 2.3 team / leader / member 委派

- Team 实体存 sidecar 存储（`readStoredTeams`，`electron/utils/team-config.ts:22-35`），字段为 `leaderId` / `memberIds`；建团队时向 `openclaw.json` 的 `agents.list` 回写 `reportsTo` / `teamRole`（`team-config.ts:174-192`）。
- 委派机制不是独立协议，而是**提示词约定 + 子会话**：leader 的 SOUL.md 被写入「使用 sessions_spawn 创建子会话来委派任务」（`team-config.ts:208`、`team-config.ts:320`；市集模板同样，`electron/utils/openclaw-workspace.ts:727`）。
- 运行期委派由 `SessionRuntimeManager` 落地：`spawn()` 构造子 `sessionKey`，然后走 gateway 私有 RPC `chat.send`（`electron/services/session-runtime-manager.ts:135-198`）；`kill` → `chat.abort`（`session-runtime-manager.ts:219`）；`steer` → 再次 `chat.send`（`session-runtime-manager.ts:229-250`）。Host API 暴露 `/api/sessions/spawn|subagents|kill|steer|wait`（`electron/api/routes/sessions.ts:13-130`）。
- 子会话有完整记录结构 `RuntimeSessionRecord`（父子链 `parentRuntimeId` / `childRuntimeIds` / `depth` / `rootRuntimeId`，`session-runtime-manager.ts:39-63`）——**这棵树天然就是 A2A 的 delegator/delegatee 关系**。

**协议性质**：委派语义靠 SOUL.md 提示词（自然语言约定），执行靠 `chat.send` 私有 RPC。没有机器可读的能力声明、没有跨进程任务状态机。

### 2.4 市集 hire 流程

- 模板即目录：`resources/marketplace/<id>/` 内含 `IDENTITY.md` + `SOUL.md` + `AGENTS.md` + 头像（如 `resources/marketplace/fullstack-dev/`）。
- `IDENTITY.md` 用**正则从 Markdown 解析**元数据（`**Name:**` / `**Emoji:**` / `**Vibe:**` / `**Role:**` / `**Avatar:**` / `**Rating:**`，`openclaw-workspace.ts:347-366`）；`AGENTS.md` 解析能力列表（`openclaw-workspace.ts:368-383`）；capabilities > 1 即判定为团队模板（`openclaw-workspace.ts:413`）。
- `hireFromMarketplaceTemplate`（`openclaw-workspace.ts:468-573`）：拷贝模板目录到 `~/.openclaw/workspace-<slug>`，写定制 SOUL.md，把 agent 注册进 `~/.openclaw/openclaw.json` 的 `agents.list`（`source: 'marketplace'`）。
- `hireTeamFromMarketplaceTemplate`（`openclaw-workspace.ts:575-707`）：为每个 capability 生成一个 worker agent（`teamRole: 'worker'`、`reportsTo: leaderId`、`chatAccess: 'leader_only'`），再调 `createTeam`。
- 注意：`rating` / `hiredCount` 目前是**随机数占位**（`openclaw-workspace.ts:449-450`）。

**协议性质**：hire 是「本地文件拷贝 + 配置注册」，被 hire 的 agent 没有对外身份，没有机器可读的能力契约——**这正是 AgentCard 要补的位置**。

### 2.5 评估证据链

- 数据源：转录文件 `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` + token 用量（`electron/services/evaluation/eval-data.ts:8-11`）。
- `collectRunData(agentId, sessionId)` 一次读盘产出 `{ events, transcript, entries }`（`eval-data.ts:213-277`），经 Host API `POST /api/eval/collect` 暴露（`electron/api/routes/evaluate.ts:60-76`），再经 `POST /api/evaluate/run` 代理给 model-service 的 `/api/evaluate-run`（SSE，`evaluate.ts:1-13` 头注释）。
- **现状硬伤**：`TelemetryEvent`（`src/types/evaluation.ts:321-332`，含 `rework` / `human_interventions` / `escalations` / `first_try`）目前是从用量记录**粗糙合成**的——`collectRunData` 产出的单个事件里 `rework: 0`、`human_interventions: 0`、`escalations: 0` 全是**硬编码零**（`eval-data.ts:259-272`；usage 兜底路径同样，`eval-data.ts:187-206`）。comm / 返工 / 升级这些「协作行为」维度没有真实数据源。
- 裁判模型：model-service 六维雷达 task/quality/comm/creativity/reliability/cost（`model-service/app/evaluator.py:40-57`），裁判后端可替换（`JudgeBackend` 协议：http / local / mock 三实现），无可用后端时走 Mock 并如实标注 source（`model-service/app/judge_backend.py`、`evaluator.py:10`）。

**协议性质**：证据 = 会话转录文本 + token 用量，**协作过程不可见**（委派了几轮、返工几次、谁升级求助，全靠 transcript 文本让 judge 模型间接推断）。

### 2.6 toolPolicy 安全基线（已知失效）

- 设计上要把 `gateway.toolPolicy = { mode: 'read-only', sandbox: true }` 写入 openclaw.json（`electron/utils/openclaw-auth.ts:795-816`），但 OpenClaw 2026.3.22 的 Zod schema 不认识该键、带键即退出码 1，因此 `syncToolPolicyToConfig()` 的调用**整段被注释**（`electron/gateway/config-sync.ts:288-297`），且 sanitize 会主动剥掉残留键（`openclaw-auth.ts:940-952`）。
- **含义：当前 gateway 工具执行没有只读/沙箱约束。** 这对内部 agent 是遗留风险，对接入外部不可信 agent 则是必须先解决的前置条件（见 §5.3）。

### 2.7 私有协议汇总表

| 能力 | 落点 | 现行私有协议/格式 | A2A 对应物 |
|---|---|---|---|
| Electron↔Gateway | `gateway/manager.ts:619` | `{type:"req",method,params}` over WS + token challenge | JSON-RPC binding（同族不同帧） |
| Renderer↔主进程 | `api/server.ts:72` | 私有 REST + `x-clawx-host-session` | —（内部，不进 A2A） |
| leader→worker 委派 | `session-runtime-manager.ts:179` | SOUL.md 提示词约定 + `chat.send` RPC | Task + Message + Artifact |
| agent 能力声明 | `openclaw-workspace.ts:347-383` | IDENTITY.md / AGENTS.md 正则解析 | AgentCard（JSON、可签名） |
| 任务状态 | `session-runtime-manager.ts:3-9` | 私有枚举 running/blocked/completed/killed… | Task 状态机（8 态） |
| 评估证据 | `eval-data.ts:213` | transcript jsonl + usage，rework 等硬编码 0 | **A2A trace（本设计核心，§3.4）** |

---

## 3. 集成设计

### 3.1 分层方案：什么留私有、什么升级 A2A

原则：**内部链路不动（性能与稳定性优先），跨信任边界的链路升级 A2A（互操作优先）**。

| 链路 | 信任边界 | 决策 | 理由 |
|---|---|---|---|
| Electron 主进程 ↔ OpenClaw gateway | 同机同用户 | **保留私有 WS RPC** | 低延迟、事件流成熟（`protocol.ts:83-98`），改它收益为零、风险大 |
| Renderer ↔ Host API | 同进程组 | **保留** session token REST | 纯内部控制面 |
| 内部 leader → 内部 worker（sessions_spawn） | 同组织 | **保留 `chat.send` 委派，但埋点记 A2A 语义 trace**（P1） | 私有协议已可用；trace 才是评估要的 |
| **外部 agent 被 hire 进 AgentCorp**（入站雇佣） | 跨组织 | **升级 A2A client**：市集新增「外部 A2A agent」，委派经 A2A `message/send` | 互操作是 A2A 的主场 |
| **AgentCorp agent 被外部雇佣**（出站服务） | 跨组织 | **升级 A2A server**：暴露 AgentCard + Task endpoint | 市集「出租 agent」的标准姿势 |
| AgentCard 签名防伪 | 跨组织 | A2A `signatures`（JWS） | 产品需求已定调 |

架构上新增一个 **A2A Adapter 层**，放在 **Electron 主进程**（不放 OpenClaw gateway 子进程——gateway 是 fork 的黑盒，帧格式私有（`manager.ts:619`），不应侵入；也不放 model-service——它只做推理）。Adapter 双向桥接：

```
外部 A2A client ──HTTP/JSON-RPC──> [A2A Adapter] ──chat.send──> OpenClaw gateway ──> 内部 agent
内部 leader ──chat.send──> gateway …（委派外部 agent 时）──> [A2A Adapter] ──message/send──> 外部 A2A server
                └──────────────── 两条链路都写同一份 A2A trace（§3.4）──────────────┘
```

SDK 选型：`@a2a-js/sdk@^1.0`（npm，a2aproject 官方 JS SDK，2026-07-28 发布 1.0.1，实现 spec v1.0）。model-service 如需在联调中扮演 A2A 对端，用 Python `a2a-sdk`（1.1.2）。

### 3.2 AgentCard 生成映射表

数据源：市集模板 `IDENTITY.md`（解析逻辑已存在，`openclaw-workspace.ts:347-366`）、`AGENTS.md` capabilities（`openclaw-workspace.ts:368-383`）、`SOUL.md`、`openclaw.json` 的 `agents.list` 条目（`teamRole` / `reportsTo` / `responsibility`，见 `team-config.ts:181-189`）。

| AgentCard 字段（v1.0） | AgentCorp 来源 | 备注 |
|---|---|---|
| `name` | IDENTITY.md `**Name:**` / agents.list `name` | 直接映射 |
| `description` | IDENTITY.md `**Role:**` | 即市集卡片 description（`openclaw-workspace.ts:443`） |
| `skills[]` | AGENTS.md capabilities / agents.list `responsibility` | 团队模板 = leader 一张卡，每个 capability 一个 skill |
| `provider` | 固定 `{ organization: "AgentCorp" }` | 市集治理主体 |
| `version` | 模板目录暂缺版本号 → 先固定 `0.1.0` | 后续给模板加 `VERSION` 文件 |
| `supportedInterfaces` | Adapter 的 A2A endpoint URL（§3.3） | protocolBinding: `JSONRPC`，protocolVersion: `1.0` |
| `defaultInputModes` / `defaultOutputModes` | `["text/plain"]`，code 工种加 `"application/json"`（DataPart） | 与工种 craft 维对齐（`src/types/evaluation.ts:35-50`） |
| `capabilities` | `{ streaming: true, pushNotifications: false }` | 先 SSE 流式，webhook 后置 |
| `securitySchemes` / `security` | HTTP Bearer（§3.3） | — |
| `signatures` | P3 起对上架卡片做 JWS 签名 | 防伪需求 |
| `iconUrl` | 模板 `avatar.png/jpg/svg`（`openclaw-workspace.ts:423-435`） | 当前是 data URL，需改为可访问 URL 或省略 |
| ~~`rating` / `hiredCount`~~ | **不映射**——现在是随机数（`openclaw-workspace.ts:449-450`） | 待评估档案（`EvaluationProfile`）接入后填真实值 |

生成器落点建议：`electron/services/a2a/agent-card.ts`，输入 agentId，读 agents.list + workspace 的 IDENTITY/AGENTS，输出 v1.0 AgentCard JSON。

### 3.3 A2A endpoint 位置与鉴权

**位置**：复用 Host API 的 `node:http` server（`electron/api/server.ts`），新增 `/a2a` 路由前缀与 `/.well-known/agent-card.json`：

- `GET /.well-known/agent-card.json?agentId=<id>` — AgentCard 发现（带 agentId 是因为一个 AgentCorp 实例托管多个 agent；无参时返回聚合目录卡）。
- `POST /a2a` — A2A JSON-RPC binding（`message/send`、`message/stream`、`tasks/get`、`tasks/cancel`）。
- 新路由文件 `electron/api/routes/a2a.ts`，注册进 `server.ts:35-56` 的 handler 列表。

**鉴权：独立 A2A token，不复用 Host API session token。** 理由：Host API token 每次启动随机重生（`server.ts:73-74`）且只发给 renderer；外部雇佣方需要**稳定、可吊销、按雇主隔离**的凭证。设计：

- AgentCard `securitySchemes` 声明 `HTTP Bearer`。
- A2A token 持久化在 electron-store（命名空间 `agentcorp.a2a`），按「雇主」签发多张，支持吊销；复用现有 `withConfigLock` 配置写入模式。
- server.ts 的鉴权链改为：路径以 `/a2a` 或 `/.well-known/` 开头 → 走 A2A Bearer 校验；其余 → 走原 `x-clawx-host-session`（`server.ts:85` 处加一个分支即可）。
- **绑定地址仍是 `127.0.0.1`**（`server.ts:101`）：Demo 阶段外部方通过 SSH 隧道/内网穿透接入；真对外开放是 P4 之后的事，届时再议 TLS 与 mTLS。

### 3.4 A2A trace 作为评估证据（核心独特点）

**问题**：comm / 返工 / 升级这些协作维度今天没有客观数据——`collectRunData` 把 `rework`、`human_interventions`、`escalations` 硬编码为 0（`eval-data.ts:259-272`），judge 只能从 transcript 文本间接猜。

**思路**：委派本身就是结构化事件。无论走私有 `chat.send`（内部）还是 A2A `message/send`（外部），Adapter/RuntimeManager 都按统一 schema 落一份 **A2A trace**，让评估层从「读聊天记录猜协作」升级为「读协作日志算指标」。这也是把内部委派「语义对齐 A2A」的埋点——即使 P1 阶段还没有真正的 A2A wire，trace schema 先按 A2A 概念建模，后续真接 A2A 时数据不断档。

**trace 记录格式（JSONL，每行一条）**：

```json
{
  "trace_id": "uuid",
  "task_id": "a2a-task-or-runtime-id",
  "parent_task_id": "uuid | null",
  "delegator": "agent:<leaderId> | external:<clientId>",
  "delegatee": "agent:<workerId> | a2a:<externalUrl>",
  "round": 1,
  "kind": "message | status | artifact",
  "state": "submitted | working | input-required | completed | failed | canceled",
  "rework_of": "上一轮的 trace_id | null",
  "channel": "internal-rpc | a2a",
  "sent_at": "ISO8601",
  "completed_at": "ISO8601 | null",
  "summary": "一句话任务/结果摘要（进 judge prompt 用）"
}
```

- **落盘**：`~/.openclaw/a2a-traces/<rootTaskId>.jsonl`，沿用 sessions jsonl 的既有模式（`eval-data.ts:9`）。
- **采集点**：
  - 内部委派：`SessionRuntimeManager.spawn / steer / kill`（`session-runtime-manager.ts:135/229/215`）各写一条；父子关系现成（`parentRuntimeId` / `rootRuntimeId`，`session-runtime-manager.ts:148-151`），`depth` 即委派层级。
  - A2A 链路：Adapter 的 `message/send` 收发两侧各写一条，state 直接取 A2A Task 状态机。
  - **返工判定**：同一 `parent_task_id` 下对同一 delegatee 的再次 `message/send`（prompt 语义未变即 steer），记 `rework_of` 指向上轮；leader 把任务打回（A2A 的 `input-required` 往返）也计返工。
  - **升级判定**：worker 侧出现 `input-required`（向 leader 求助）或人工 steer（`/api/sessions/subagents/:id/steer`，`sessions.ts:105-118`）计一次 escalation/human_intervention。

**喂评估层**（改动集中在 `eval-data.ts`，对外契约不变）：

1. `collectRunData` 增加第三数据源：按 `task_id/sessionId` 读对应 trace 文件。
2. 有 trace 时，`TelemetryEvent` 从 trace **客观计算**而非硬编码：
   - `rework` = `rework_of != null` 的记录数；
   - `first_try` = rework == 0 且无 input-required 往返；
   - `escalations` = delegatee 发出的 `input-required` 状态数；
   - `human_interventions` = channel=internal-rpc 且由人工 steer 触发的记录数；
   - `latency_ms` = 终态 `completed_at − 首条 submitted sent_at`。
3. trace 摘要（delegator/delegatee/轮次/耗时/返工链）拼进 `JudgeRunRequest`，作为 judge 的**结构化证据**输入；`evidence_trace`（`src/types/evaluation.ts:127`）引用具体 `trace_id`，做到「分数可回放到某条委派记录」。
4. KPI 聚合直接受益：`KpiRecord.rework_rate / escalation_rate / autonomy_rate`（`src/types/evaluation.ts:252-265`）从「恒 0」变成真实值。

**为什么这是独特点**：普通 A2A 集成止步于「能通」，AgentCorp 把 A2A 消息流变成 HR 评估的**客观证据源**——通信协议即绩效日志。六维里的 comm、reliability（多轮一致性）由此获得可复核的量化输入，而不是 transcript 的印象分。

### 3.5 与裁判后端的关系

- trace 是纯结构化短文本，天然适合进 judge prompt（`model-service/app/prompt_templates.py`），与 transcript 并列作为证据段；无可用推理后端时 Mock 路径（`evaluator.py:10`）可消费合成 trace 先行联调，**P1 完全不依赖任何特定硬件环境**。
- P4 真机联调时，model-service 消费真实 A2A trace 出六维分（后端按 `JUDGE_BACKEND` 选择：云端 OpenAI 兼容服务 / 本机权重 / 异构加速卡），叙事闭环：**「A2A 协议通信 → 可替换裁判评估 → 双榜单治理」**。

---

## 4. 分阶段落地计划

每阶段独立可演示；文件改动均为预估，实施时以实际 diff 为准。

### P1：trace 采集进评估（内部委派埋点，无真 A2A wire）

- **做什么**：定义 A2aTraceRecord schema；`SessionRuntimeManager` spawn/steer/kill 埋点写 trace；`collectRunData` 消费 trace 产出真实 `TelemetryEvent`。
- **验收标准**：完成一次 leader→worker 委派（含一次 steer 返工）后，`POST /api/eval/collect` 返回的 events 中 `rework ≥ 1`、`latency_ms > 0`；评估页六维的 comm 维 evidence 能引用 trace_id。
- **改动文件预估**：新增 `electron/services/evaluation/a2a-trace.ts`；改 `electron/services/session-runtime-manager.ts`、`electron/services/evaluation/eval-data.ts`、`src/types/evaluation.ts`（仅加类型，仅加法）。
- **演示点**：同一次任务，改造前 rework 恒 0、改造后 rework=1 的对照。

### P2：AgentCard + A2A endpoint（A2A server 角色，AgentCorp agent 被外部雇佣）

- **做什么**：AgentCard 生成器；`/.well-known/agent-card.json` + `POST /a2a`（JSON-RPC binding，`message/send` + `tasks/get`）；A2A Bearer token 签发/吊销；Adapter 把 A2A Task 桥到 `chat.send`，全程写 trace。
- **验收标准**：用官方 `a2a-sdk`（Python）或 `@a2a-js/sdk` 写的脚本作为外部雇主，发现卡片 → `message/send` 派任务 → 收到 completed + Artifact；非法 token 返回 401；任务全程可在评估页看到 trace。
- **改动文件预估**：新增 `electron/services/a2a/{agent-card.ts,adapter.ts,token-store.ts}`、`electron/api/routes/a2a.ts`；改 `electron/api/server.ts`（鉴权分支 + 路由注册）、`package.json`（依赖 `@a2a-js/sdk`）。
- **演示点**：脚本「雇主」雇佣市集里的全栈开发 agent 完成一个真实小任务。

### P3：市集外部 agent hire（A2A client 角色，外部 agent 被 hire）

- **做什么**：市集新增「外部 A2A agent」类型（录入对方 AgentCard URL，拉取并校验卡片）；hire 时在 `agents.list` 注册 `source: 'external'` + 对方 endpoint；leader 委派该 agent 时经 Adapter 走 `message/send`；AgentCard JWS 签名校验上架。
- **验收标准**：一个跑在 model-service 侧（`a2a-sdk` Python）的外部 agent 被 hire 进市集、被 leader 委派、产出 Artifact、trace 完整进评估。
- **改动文件预估**：新增 `electron/services/a2a/external-agent.ts`；改 `electron/utils/openclaw-workspace.ts`（hire 外部类型）、`electron/api/routes/agents.ts`、市集前端注册页（`src/` 市集组件）。
- **演示点**：跨进程（模拟跨组织） hire → 委派 → 评估全链路。

### P4：真机联调

- **做什么**：model-service 部署到目标推理环境（云端 OpenAI 兼容服务或本机权重，见 README §4 四条路径）；judge prompt 接入真实 trace 证据段；Mock 全关，真实推理出分。
- **验收标准**：NPU 上 MiniCPM-o 4.5 消费真实 A2A trace + transcript 产出六维分与 verdict；`/api/evaluate-run` SSE 全链路无 mock 事件。
- **改动文件预估**：`model-service/app/prompt_templates.py`（trace 证据段）、`model-service/app/schemas.py`（JudgeRunRequest 加 `a2a_trace` 字段，镜像前端类型）；部署侧按 ascend-adaptation-plan。
- **演示点**：终态叙事——A2A 互通 + 可审计评估 + 双榜单治理。

---

## 5. 风险与边界

### 5.1 协议版本漂移

A2A 0.3→1.0 有大量 breaking（well-known 改名、AgentCard 结构重排）。对策：锁定 spec v1.0 + `@a2a-js/sdk` minor 版本；所有出入站请求带/校验 `A2A-Version: 1.0` 头，不支持就显式报 `VersionNotSupportedError`，不做静默兼容。SDK 版本独立于 spec 版本，升级 SDK 前查其 changelog 的 spec 支持矩阵。

### 5.2 gateway 进程边界

OpenClaw gateway 是 fork 的子进程、帧格式私有（`manager.ts:619-621`），且版本升级不受我们控制（2026.3.22 已因 schema 变更废掉 toolPolicy，见下）。**对策：A2A 逻辑一律不进 gateway 进程**，全部放在 Electron 主进程 Adapter 层，对 gateway 只用既有 `chat.send` / `chat.abort` RPC——gateway 升级最多影响桥接层一处。

### 5.3 安全：外部 agent 是不可信输入

- 外部 agent 返回的 Message/Artifact 内容是**不可信文本**，可能携带 prompt injection：必须原样进 worker 上下文前标注来源边界，且 `source: 'external'` 的 agent 不得继承内部 agent 的本地工具权限。
- DataPart/FilePart 需要大小与类型白名单限制，拒绝可执行内容落盘。
- **toolPolicy 失效的直接冲击**：当前 `syncToolPolicyToConfig` 被注释（`config-sync.ts:288-297`）、sanitize 主动剥离该键（`openclaw-auth.ts:940-952`），gateway 工具执行**没有任何只读/沙箱约束**。内部 agent 尚可靠提示词自律，接入外部 agent 前必须先二选一：(a) 等/推 OpenClaw 支持 `gateway.toolPolicy` 后恢复该函数；(b) 在 Adapter 层自建沙箱——外部 agent 的产出只经 Artifact 传递，外部 agent 永不获得本地 sessions_spawn/工具调用能力（推荐 b，不依赖上游）。**这是 P3 的硬前置，必须在 P3 验收标准中显式检查。**
- A2A token 泄露面：token 持久化本地、按雇主隔离、支持吊销；绑定 127.0.0.1（`server.ts:101`）使 Demo 阶段攻击面限于本机。

### 5.4 范围边界（明确不做）

- 不做多实例 AgentCorp 之间的联邦/目录服务（ANP 层的事，产品分层设计已划分）。
- 不做 push notification webhook（Demo 无公网回调，SSE + 轮询足够）。
- 不改 OpenClaw gateway 本体、不动内部 `chat.send` 委派链路。
- 不在 P1–P3 追求 AgentCard 签名的完整 PKI（先用本地密钥对签名/验签，CA 体系后置）。

---

## 附：主要参考来源

- A2A 规范：https://a2a-protocol.org/latest/specification/
- A2A 仓库与 release notes：https://github.com/a2aproject/A2A 、https://github.com/a2aproject/A2A/releases
- LF 捐赠公告：https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents
- Google 首发博客：https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- A2A↔MCP 分工：https://a2a-protocol.org/latest/
- JS SDK：https://github.com/a2aproject/a2a-js ；Python SDK：https://github.com/a2aproject/a2a-python
- 项目内：A2A 定位与签名卡片要求以产品需求文档为准（内部文档，不入仓）
