# AgentCorp · MCP 等价契约（AgentTeams 兼容薄适配 · SP-12）

> 关联：GOAI 路书 SP-12 / SP-13。本文件是「复赛 AgentTeams 兼容薄适配」的对外契约说明：
> AgentCorp 主线跑 OpenClaw，不引入第三方编排运行时；但 Host API（`127.0.0.1:3210`）暴露的
> HTTP/RPC 接口在语义上**等价于一组 MCP tool**——每个 gateway 路由即一个可被 Agent/客户端
> 调用的「工具」。本契约描述这组等价 tool 的 schema，作为复赛迁移到真 MCP 时的逐 tool 映射基线。

---

## 0. 传输与鉴权（全局约定）

- **Base URL**：`http://127.0.0.1:3210`（Host API server，见 `electron/api/server.ts`）。
- **鉴权**：所有请求须在 Header 携带 `x-clawx-host-session: <per-session-token>`。
  token 由 server 启动时 `randomBytes(32)` 生成，经 IPC 下发给 renderer；缺失/错误返回 `401`。
- **RPC 帧**：SSE / JSON 接口统一采用如下 RPC 信封（等价 MCP `tools/call` 请求帧）：

  ```jsonc
  {
    "type": "rpc",          // 帧类型（rpc / event / error）
    "id": "req-<uuid>",     // 调用方生成的幂等 id，回包原样带回
    "method": "evaluate.run", // 等价 MCP tool name
    "params": { ... }       // tool 入参
  }
  ```

- **幂等 / 审计**：所有写操作（`run` / `user-pick` / `compare`）以 `id` 去重；调用记入审计日志，
  可由 `evidence_trace` 引用回放（见 `a2a-trace.ts` 与 `traceSink.ts`）。
- **错误码**：`400` 参数非法 · `401` 鉴权失败 · `404` 无路由 · `409` 幂等冲突 · `500` 内部错误。

---

## 1. tool：`evaluate.run`（评估中心运行 · SSE 流式）

- **等价 MCP tool**：`agentcorp.evaluate.run`
- **Method / Path**：`POST /api/evaluate/run`（响应 `text/event-stream`）
- **Params**：
  - `candidateId: string`（必填）
  - `transcript: string`（必填，面试转录）
  - `requirement?: string`（招聘需求）
  - `k?: number`（ensemble 次数，默认 3）
  - `threshold?: number`（pass^k 阈值，默认 3.5）
- **Returns（SSE 事件流）**：
  - `event: progress` — 每阶段进度（input/decompose/context/tool/verify/approve/precipitate）
  - `event: result` — 最终 `ClosedLoopResult`（雷达 / pass^k / 偏差审计 / bossDecision / experience）
- **Errors**：`400` 缺 candidateId/transcript；`500` 评委全不可达（降级返回 degraded）。
- **MCP 迁移**：映射为 MCP `tools/call {name:"agentcorp.evaluate.run", arguments:{...}}`，SSE 事件转为
  MCP 服务端 `notification` 或逐段 `content` block。

---

## 2. tool：`chat-judge`（评委对话打分）

- **等价 MCP tool**：`agentcorp.chat-judge`
- **Method / Path**：`POST /api/chat-judge`
- **Params**：
  - `agentId: string`
  - `transcript: string`
  - `variant: number`（维度顺序旋转变体，对抗位置偏差）
  - `bossProfile?: object`
- **Returns**：`{ radar, verdict, confidence, evidence[] }`
- **Errors**：`400` 缺参；`502` 网关/评委不可达（调用方应降级 mock）。
- **MCP 迁移**：作为 `evaluate.run` 内部 delegate 的对外等价 tool；真 MCP 下由
  `chat.send`（内部委派）或 A2A `message/send`（外部委派）承载。

---

## 3. tool：`arena.compare`（竞技场多候选对比）

- **等价 MCP tool**：`agentcorp.arena.compare`
- **Method / Path**：`POST /api/arena/compare`
- **Params**：
  - `candidateIds: string[]`（≥2）
  - `dimension?: RadarDim`（指定对比维度，缺省全维）
- **Returns**：`{ rows: Array<{ candidateId, meanRadar, verdict, passRate }>, ranking: string[] }`
- **Errors**：`400` candidateIds 不足 2；`404` 候选缺失。
- **MCP 迁移**：映射为 MCP `tools/call {name:"agentcorp.arena.compare", arguments:{...}}`。

---

## 4. tool：`arena.user-pick`（人工择优 · 需审批动作）

- **等价 MCP tool**：`agentcorp.arena.user-pick`
- **Method / Path**：`POST /api/arena/user-pick`
- **Params**：
  - `sessionId: string`
  - `pickCandidateId: string`
  - `requiresHumanAck?: boolean`（高风险动作，默认 true）
- **Returns**：`{ accepted: boolean, ackRequired: boolean, reason: string }`
- **Errors**：`401` 鉴权；`409` 幂等冲突（同 sessionId 已 pick）；`422` 超出可选范围。
- **MCP 迁移**：带 `requiresApproval` 边界的 tool，真 MCP 下触发 human-in-the-loop 确认。

---

## 5. tool：`agents.*`（Agent 身份 / 能力查询）

- **等价 MCP tool**：`agentcorp.agents.list` / `agentcorp.agents.get`
- **Method / Path**：`GET /api/agents` · `GET /api/agents/:agentId`
- **Params**：`agentId?`（省略则列出全部）
- **Returns**：`AgentIdentity[]`（role / goal / skills / boundaries），等价 AgentTeams `Agent` 基元。
- **Errors**：`404` agentId 不存在。
- **MCP 迁移**：直接对应 AgentTeams `Agent` 资源读；薄适配层 `toAgentTeamsAgent` 已就绪。

---

## 6. tool：`convergence.*`（收敛度指标 · 人机协同熵收敛）

- **等价 MCP tool**：`agentcorp.convergence.report`
- **Method / Path**：`GET /api/convergence/:sessionId`
- **Params**：`sessionId: string`
- **Returns**：`{ entropyBefore, entropyAfter, converged: boolean, metrics: object }`
- **Errors**：`404` session 无采集数据。
- **MCP 迁移**：映射为 MCP `tools/call {name:"agentcorp.convergence.report", arguments:{sessionId}}`。

---

## 7. 复赛迁移到真 MCP 的逐 tool 步骤

1. 引入 AgentTeams SDK，将 `agentteams-adapter.ts` 的 `ATTeam/ATAgent/ATTask/ATRun` 类型
   替换为 SDK 真实类型（薄映射层原地升级，无需重设计角色卡/Skill）。
2. 把本文档 §1–§6 每个 tool 注册为 MCP server 的 `tool`，schema 1:1 对齐上述 Params/Returns。
3. `runTask` 内部委托从 `runClosedLoop`（OpenClaw）切换为 `team.run(...)`（AgentTeams）；
   `invokeSkill` 保持为 Skill 调用入口，handler 不变。
4. SSE（`evaluate.run`）改为 MCP 流式 `content`；鉴权 `x-clawx-host-session` 迁为 MCP auth header。
5. `a2a-trace.ts` / `traceSink.ts` 的 trace 继续落盘，作为评估证据与 OTel span 来源，无需变更。

> 迁移成本：仅薄适配层 + 一处 `runTask` 委托切换；角色卡、Skill 定义、评估科学（pass^k / 偏差审计）
> 全部复用，不构成二次开发。
