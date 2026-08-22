# AgentCorp 代码审查报告

> 审查日期：2026-08-18
> 范围：`electron/`（主进程与安全）、`src/`（前端 + 评测引擎）、`model-service/`（Python 裁判）、工程配置/CI/文档
> 方法：逐文件阅读 + 亲自跑通 typecheck / 前端单测 / 裁判 pytest（非依赖静态结论）

---

## 0. 一句话总评

**底座扎实、核心引擎诚实克制，但被三块东西拖了后腿：文档漂移、巨型文件、以及本地文件/上传接口缺校验。**
产品最该被信任的"评分/ROI/收敛"纯函数层写得干净（有除零保护、有归一化、可单测），安全面（密钥 safeStorage 加密、Host API token + 127.0.0.1 + CORS 白名单、SSRF 锁 loopback）也超出一般桌面应用的平均水平。真正需要动手的是工程卫生和两个输入校验缺口，不是核心算法。

---

## 1. 我先亲自验证了文档的硬指标（结论：核心声明属实，数字过时）

| 声明 | 文档写的 | 我跑出来的 | 判定 |
|---|---|---|---|
| tsc 0 错误 | "tsc 0 错误" | `pnpm typecheck` 通过，0 error | ✅ 属实 |
| 前端单测 | "274/274 全过" | **965 passed / 87 文件** | ⚠️ 数字严重过时（被低估） |
| 裁判 pytest | "274" | **285 passed / 18 skipped** | ⚠️ 过时 |
| CI 门禁 | typecheck/lint/test/pytest | 确有这四道，跑在 ubuntu + Node22/Py3.12 | ✅ 属实 |
| 降级不崩 | "绝不 ImportError 崩溃" | 裁判服务 import 期确为惰性，282 测试含降级用例 | ✅ 属实 |

**启示**：文档的"可验证硬指标"大体可信，但**测试数量这种会变的数字长期没人同步**——说明缺一个"让文档数字自动失效"的机制。

---

## 2. 安全问题（按严重度）

### 🟠 中：本地文件接口无路径校验（`electron/api/routes/files.ts`）
- `stage-paths`（:84-108）：把渲染层传来的**任意绝对路径** `copyFile` 到 outbound 目录，并 `stat` 后把 `stagedPath`/`fileSize` 回传。**无路径校验、无沙箱、无范围限制**。
- `thumbnails`（:138-159）：对任意传入路径 `stat` + 读文件生成预览。
- 影响面：这两个端点受 Host API session token 保护，外网够不到；但**一旦渲染层有 XSS，就升级成"任意文件外带"原语**。配合下方"前端 XSS 面"看，这是纵深防御的缺口。

### 🟠 中：上传端点无大小/类型限制（`model-service/app/routes/upload.py:42`）
- `f.write(file.file.read())` **全量读进内存再写盘**，无 `MAX_UPLOAD`、无 content-type/扩展名白名单。一个超大 body 即可打爆内存（DoS）；且可写任意字节到 `upload_dir`。
- 文件名被硬编码为 `video.mp4/voice.wav/code.zip`（:45-47）——这点**没有文件名路径穿越**，是好的；但缺大小与类型校验仍是真实缺口。

### 🟡 低：HTTP 裁判无重试 + 响应无大小上限（`judge_backend.py:132-138`）
- 单次 `urlopen`，`resp.read()` 全量入内存、无 cap；遇 `HTTPError/URLError/TimeoutError` 直接抛 `JudgeUnavailable`，**无重试/退避**。一次网络抖动即整次评测降级；畸形超大响应可打爆进程。

### 🟡 低：`cp.exec` 字符串拼接 + `quoteForCmd` 转义不足
- `supervisor.ts:171/211` 用 `cp.exec` 拼 `netstat ... findstr :${port}` / `taskkill /F /PID ${pid}`——port/pid 均被限定为数字，**实际可利用性低**，但是代码坏味道（且是 DEP0190 告警来源之一）。
- `utils/win-shell.ts:22 quoteForCmd` 只在含空格时包双引号，**不转义内嵌 `"` 与 `& | % ^` 等 cmd 元字符**。Windows 下非绝对路径走 `shell:true` 时，含元字符的路径会逃逸。当前入参多为受控路径，属潜在隐患。

### ✅ 做得好的（不要误伤）
- **密钥加密**：`secret-store.ts` 用 `safeStorage`（DPAPI/Keychain），**加密不可用时拒绝落盘**（:78-82），并自动迁移旧的明文 `apiKeys`。这是正经的安全设计。
- **Host API**：绑定 `127.0.0.1`（`server.ts:123`）、每会话 `randomBytes(32)` token（:96）、`isAuthorizedHostApiRequest` 校验（route-utils:50）、CORS 只放行 `app://.` 与 `null`（:21）。
- **SSRF 锁死**：`gateway:httpProxy`（ipc-handlers:1029）host 硬编码 `127.0.0.1`、port 取自 gateway 状态，渲染层只控 path（须以 `/` 开头）。
- **无 XSS 面**：全 `src/` 无 `dangerouslySetInnerHTML`；react-markdown 未配 `rehype-raw`，默认不渲染原始 HTML。

---

## 3. 核心引擎正确性（`src/engine/`）

**整体结论：纯函数、有边界保护、数学自洽。** 这是项目最该被信任的一层，也确实写得最干净。

- `roiEngine.ts`：成本五要素 + 价值两要素 → ROI/IPR/SRPC/CPS，跨 agent z-score 归一化；`computeRoi` 对 `C_total>0` 有守卫，`zscore` 对 σ=0 回退 1e-9 防除零。λ 融合公式 `cost_perf = clamp((λ·CPS/5 + (1−λ)·radarCost/5)·5, 0, 5)` 自洽（normCps 把 CPS 映射到 0–5 后再归一回 0–1 融合）。✅
- `metricsEngine.ts`：TCR/FSR/RR/ADL/AR/ER/CGR/SCR 全有空数组守卫与除零保护。✅
- `scoring/rulesEngine.ts`：与后端 `rules_engine.py` 同公式镜像；`flattenDimWeight` 整体归一兜底了 kpiRoi 缺维；verdict 阈值映射正确。✅

**但有几处逻辑瑕疵：**
- 🟡 `strategyEngine.ts:138 transition()` 用 `rules.find()` **取首个匹配**，而同一 trigger 下多条规则 guard 会重叠——例如 `monthly_arena` 先配了一条 `consecutiveBottom < 1` 才进培训，后又有一条 `consecutiveBottom >= 2` 淘汰，中间 `=== 1` 的情况两条都不命中（无迁移，可能是有意）。更关键：`manual` trigger 配了 `guard: () => true`，放在列表里会**遮蔽同 trigger 的后续规则**（TRAINING 里 manual 与 monthly_arena 相邻，:104-109 的 manual fire 规则其实永不可达，因为 monthly_arena 的淘汰规则在它前面且同 trigger 不冲突——需逐条核对，存在死规则风险）。
- 🟡 ACTIVE 态 `monthly_arena` + `rank===1` → `to: ACTIVE` 是**自环 no-op**（:57-61），会产生一条"授予 MVP"事件但状态不变——调用方若按"状态是否变化"判断是否落库，会漏记。
- 🟡 `stability()`（metricsEngine:88）用**总体标准差**（除以 n），与 `zscore` 的风格不一致；且 `1 - avgStd/5` 假设雷达维量纲为 0–5，缺显式注释。

---

## 4. 代码质量与工程卫生

### 🔴 巨型文件（违反"单文件 <500 行"基线的重灾区）
`ipc-handlers.ts` **2743 行**、`src/stores/chat.ts` **2475 行**、`src/pages/Setup/index.tsx` 1788、`channel-config.ts` 1296、`openclaw-auth.ts` 1208、`api/routes/memory.ts` 1168、`session-runtime-manager.ts` 1161……远超可维护阈值。`ipc-handlers.ts` 一个文件塞了全部 IPC handler，是典型的"上帝文件"，改动冲突与回归风险都集中在这。

### ✅ 类型/lint 纪律优秀
`src/` 内 `as any` **0 个**、`: any` 仅 8 个、`@ts-ignore/@ts-expect-error` 仅 1 个（且是 office 组件里自定义 keyframe 属性的合理用途）、`eslint-disable` 19 处。对于一个 Electron + React 项目，这个类型纪律明显高于平均。

### 🟡 pnpm 10 配置失效
`package.json` 的 `pnpm.onlyBuiltDependencies` / `pnpm.overrides` **在 pnpm 10 已不再读取**（安装时告警），需迁移到 `pnpm-workspace.yaml`。同时 `ignoredBuiltDependencies: [electron, esbuild]` 与前者语义相反、且 electron/esbuild 在两处口径不一，应统一收敛。

### 🟡 CI 无安全/供应链门
`ci.yml` 只有 typecheck/lint/test/pytest，**无 `pnpm audit`、无依赖漏洞扫描、无 license 检查、无 Dependabot**。对一个处理 LLM API key、跑了 7+ 个 IM 通道插件 + 多个原生模块（node-llama-cpp/sharp/koffi）的桌面应用，这是最大的供应链安全债。

### 🟡 httpx 弃用警告
`test_http.py` 等触发的 `starlette.testclient` httpx 弃用（StarletteDeprecationWarning），属于需要跟进的依赖老化信号。

### 📌 Kanban 确为占位
PRD §6.1 自陈 `Kanban` 当前是"优雅占位页"，真实拖拽看板未实现——与定位"劳动力市场交易"的宏大叙事之间存在实现落差。

---

## 5. 文档漂移（本项目最突出的非代码问题）

1. **产品定位自相矛盾**：
   - README 定位成克制的"Agent 评测/HR 准入评审平台"，且明确写"只主张稳定、暂不主张正确"。
   - PRD 却讲成"开放互联网 Agent 劳动力市场 + ANP/DID 去中心化身份 + 原生支付协议"的宏大叙事，PRD §8.2 自己也承认"零真实交易下网络效应只是设计预留的前提"。
   - 两份文档对"我们现在到底是谁"回答不一致，对外（评委/合作方）会传递混乱信号。

2. **测试数量长期过时**：文档反复写"274/274"，实际已 965（前端 87 文件）/ 285 passed + 18 skipped（裁判）。会变的数字没有同步机制。

3. **README §2 目录结构**声称裁判 `serve.py` 挂"6 个路由域"，与实际路由域数量不符（实为 samples/evaluate/upload/convergence/leaderboard/health/arena/judge 等更多）。

---

## 6. 两套并行的"生命周期状态"表示

- `src/types/lifecycle.ts`：**小写** `onboarding/active/training/maintenance/retired`，注释自称"唯一真相"。
- `src/types/evaluation.ts` + `src/engine/strategyEngine.ts`：**大写** `ONBOARDING/ACTIVE/...`，注释自陈是"评估层内部别名"。

两套表示 + 运行时别名转换，是典型的"历史兼容层累积"。功能上能跑，但增加了认知负荷和出错面，建议收敛为一套真相源。

---

## 7. 建议优先级（最该先动的 5 件）

1. **修两个输入校验缺口**（性价比最高、最实在）：
   - `upload.py` 加 `MAX_UPLOAD_BYTES` 分块限额 + content-type/扩展名白名单 + 大小校验。
   - `files.ts` 的 `stage-paths`/`thumbnails` 对入参路径做校验（限定到允许的目录/拒绝 `..` 与绝对路径越界），避免渲染层 XSS 升级为任意文件外带。
2. **拆巨型文件**：优先拆 `ipc-handlers.ts`（2743 行）和 `chat.ts`（2475 行）——按域拆成多文件，这是回归风险与协作冲突的主要来源。
3. **统一生命周期状态表示**：收敛 `lifecycle.ts`（小写）与 `strategyEngine`/`evaluation.ts`（大写）为一套真相源，消除别名转换层。
4. **补 CI 供应链门**：接入 `pnpm audit`（至少告警级）+ Dependabot；这是处理 LLM key 与多原生模块应用的最大安全债。
5. **修 pnpm 10 配置 + 同步文档数字**：把 `onlyBuiltDependencies`/`overrides` 迁到 `pnpm-workspace.yaml` 并消除两处矛盾；给测试数量这类会变数字找一个自动来源（或改为"≥N"表述），根治文档漂移。

---

## 8. 亮点（值得保留的）

- 核心评分/ROI/收敛是**真正无副作用、可单测的纯函数**，且边界保护到位——对"评测产品"而言，这是最该做对、也确实做对的部分。
- 安全底座（safeStorage 密钥加密 + 拒绝明文落盘、Host API 三层防护、SSRF 锁 loopback）明显高于桌面应用平均线。
- 类型纪律优秀（`as any` 零个），文档对"已知边界/待做/诚实表述"的态度坦诚（PRD §8.2/§9 主动标注哪些是"设计预留"而非"已验证"）。
- 应用实际可启动、可渲染（已本地跑通 `pnpm dev`，首页正常）。
