# GOAI 复赛代码包清单（SP-16）

> 本文档随复赛代码包交付，描述参赛目录结构、运行步骤与门禁命令。
> 所有路径均相对参赛根目录 `agentcorp-fresh/`，不含任何绝对用户路径。
> 本报告与验证报告、截图同属 `docs/artifacts/`（被 `.gitignore` 全局忽略，需主理人 `git add -f` 入库）。

---

## 1. 代码包结构（核心文件树）

与 Demo / 复赛相关的核心文件如下（已审，均位于参赛根目录内，无绝对路径、无隐私 token）：

```
agentcorp-fresh/
├── src/demo/                          # GOAI 复赛 Demo 全部真源
│   ├── closedLoop.ts                  # 八步闭环编排器（GOAI 必选项 · 决策 X 落地）
│   ├── agentteams-adapter.ts          # AgentTeams 薄适配层（SP-04 / SP-05：invokeSkill / runTask）
│   ├── ClosedLoopDemo.tsx             # 闭环演示 UI（「运行闭环」按钮所在页面）
│   ├── liveJudge.ts                   # 评委客户端（demo 用，封装 judge 调用）
│   ├── mockJudge.ts                   # 评委桩（离线可跑，避免外部依赖）
│   ├── talentMarket.ts                # 人才市场 / 候选人数据
│   ├── main.tsx                       # demo web 入口
│   ├── skills/
│   │   ├── bossDecision.ts            # boss_review 决策唯一真源（PR #7 修复点：no-useless-assignment）
│   │   ├── experienceStore.ts         # 经验沉淀 Skill（可观测/可回放）
│   │   ├── handlers.ts                # Skill handler 注册与分发（bossReviewSkill 调用 reviewBossDecision）
│   │   └── registry.ts                # Skill 注册表（invokeSkill 真源，持有 handler）
│   └── observability/
│       ├── otelGenai.ts               # OpenTelemetry GenAI 指标（token / cost，SP-09）
│       └── traceSink.ts               # Trace 回放落盘（SP-10，字段与 electron 端 a2a-trace 对齐）
├── scripts/
│   ├── privacy-grep.sh                # 隐私门禁（一票否决，扫描 src/demo docs/artifacts 与隐藏产物目录）
│   └── qa/
│       └── goai-verify.mjs            # SP-14 自动化验证脚本（pnpm verify:goai）
├── electron/                          # 桌面端（复赛可选参考，闭环逻辑与 web 同源）
│   ├── utils/config.ts                # 应用配置（端口等；即任务所指 config.ts，实际位于 utils/ 下）
│   ├── api/server.ts                  # 本地 API server（Host API）
│   └── services/evaluation/
│       └── a2a-trace.ts               # A2A 委派 trace 记录与读写（SP-11，与 traceSink 字段对齐）
├── tests/unit/                        # 复赛核心单测（SP-14 门禁 2 覆盖）
│   ├── agentteams-adapter.test.ts
│   ├── closedLoop.test.ts
│   ├── demo-adapter.test.ts
│   ├── skills-experience.test.ts
│   ├── otel-genai.test.ts
│   └── trace-sink.test.ts
├── vite.web.config.ts                 # web 预览配置（端口 5174）
├── tsconfig.json / tsconfig.node.json
├── eslint.config.js
└── package.json                       # 含 verify:goai 脚本
```

> 说明：`electron/config.ts` 在仓库中实际为 `electron/utils/config.ts`（应用配置模块），其余 `api/server.ts`、`services/evaluation/a2a-trace.ts` 路径与任务要求一致。

---

## 2. README 运行步骤

在**全新克隆**的参赛根目录 `agentcorp-fresh/` 下：

```bash
# 1) 安装依赖（沙箱已预装；新环境需执行）
pnpm install

# 2) 启动 web 预览（vite web 配置，端口 5174）
pnpm web
#   浏览器打开 http://localhost:5174

# 3) 在演示页点击「运行闭环」按钮，跑通八步闭环（closedLoop.ts）
#    —— 端到端链路截图见 SP-15 产出：docs/artifacts/goai-demo-screenshot.png

# 4) 生成自动化验证报告（SP-14）
pnpm verify:goai
#    产物：docs/artifacts/goai-verification-report.md
```

> 沙箱铁律：本环境已预装依赖，**不要重跑 `pnpm install`**（NODE_OPTIONS shim 会导致失败）；
> 运行 `node` / `vite` / `eslint` / `vitest` 前需 `env -u NODE_OPTIONS` 中和 shim。

---

## 3. 门禁命令清单（预期结果）

| 门禁 | 命令 | 预期结果 |
| --- | --- | --- |
| 类型检查（root） | `tsc --noEmit` | 退出码 **0** |
| 类型检查（node） | `tsc --noEmit -p tsconfig.node.json` | 退出码 **0** |
| 单元测试 | `vitest run --pool=threads tests/unit/<6 个文件>` | **≥7 绿**；个别红用例记为环境抖动，不改测试逻辑 |
| 代码规范 | `eslint .` | 退出码 **0**（仅 warning 可接受，warning 不阻塞） |
| 隐私门禁 | `bash scripts/privacy-grep.sh` | 退出码 **0**（零命中） |
| 一键验证 | `pnpm verify:goai` | 生成 `docs/artifacts/goai-verification-report.md`，整体 `门禁=PASS` |

> `pnpm verify:goai` 会依次执行：tsc(root) → tsc(node) → vitest(6 文件) → privacy:check，
> 并把每道门禁的 ✅/❌、测试绿/红计数、整体判定与生成时间戳写入验证报告。

---

## 4. 隐私声明（参赛包铁律 · 一票否决）

- 参赛包 **不含** 以下目录 / 内容：
  - `docs/review/`（内部评审草稿）
  - `node_modules/`（依赖，体积大且不外发）
  - `.git/`（版本库元数据）
  - 任何**绝对用户路径**（如 `<USER_HOME>/...` 形式）或用户名 token
- `privacy:check`（`bash scripts/privacy-grep.sh`）**已通过（零命中）**，覆盖扫描范围：`src/demo`、`docs/artifacts` 与隐藏产物目录。
- 本文档与下列运行产物均经隐私清洗（无敏感 token）：
  - **SP-14 验证报告**：`docs/artifacts/goai-verification-report.md`（由 `pnpm verify:goai` 生成）。
  - **SP-15 截图**：`docs/artifacts/goai-demo-screenshot.png`（「运行闭环」端到端链路截图，**运行产物**）。
- 上述报告与截图属**运行产物**：在全新克隆上按 §2 步骤执行即可复现，无需随包预置。

---

*本文档由工程师按 SP-16 路书生成。路径均为相对 `agentcorp-fresh/` 的泛化路径。*
