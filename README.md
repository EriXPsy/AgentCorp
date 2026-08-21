# AgentCorp：Agent 适配与协同平台
   <img width="376" height="380" alt="e39900a59e427a887368dc6f694de7ea" src="https://github.com/user-attachments/assets/090ea2ca-fa0b-415c-849c-bd5aa8e93e21" />


> **LLM跑分测的是模型能力，却不是你的真实工作。**
> 面对日渐膨胀的Agent选择，你是否常常陷入到一种「Agent选择困难症」中？
> 面对日新月异的各种功能，什么样的数字员工最能够契合你真实的工作流程？
> 
> AgentCorp 用同一套工种实测题、同一份评分标准，把「该用哪个 Agent」
> 从凭感觉，变成可测量、可复现、可追溯的判断。

<img width="2940" height="1742" alt="AgentCorp 界面预览" src="https://github.com/user-attachments/assets/3399d589-4ed5-4b41-a201-0dedc258ad32" />

---

## 为什么需要它

现有的 Agent 评测基本回答不了两个实际问题：

1. **跑分与真实工作脱节。** 榜单在标准化题库上比较模型的通用能力，
   而真实工作需求模糊、约束具体、要能交付。跑分高不等于能替你完成这份工作。
2. **不同来源的 Agent 之间没有公共标尺。** 选型只能看 star 数或一句「挺好用」，
   新发布的 Agent 天然吃亏，团队引入时也无法回答「能不能上线、出问题谁负责」。

AgentCorp 把选择变成一次**带证据的准入评审**：
出同一套题、按同一份标准打分、留下可复核的记录、最终由人拍板。

## 核心能力

| 能力 | 解决的问题 | 做法 |
|---|---|---|
| **候选市场** | 从哪里找 Agent，怎么公平展示 | 内置 285 个数字员工模板 + **GitHub 一键导入**开源仓库 + 上传自有 Agent；导入卡不带星级、不给初始分（star 只回答「还有人维护吗」，回答不了「能不能替你干活」），六维一律由实测填充 |
| **能力实测** | 这个 Agent 到底会不会干活 | 12 道固定题覆盖写代码 / 写文案 / 做图三类工种，同题同标尺，逐条 checkpoint 必须带原文引用，题面内置反注水探针；**代码题另跑真实沙盒**：候选自己写的测试会被真的执行，「4/4 用例通过」是机器事实而非模型判断（做图工种目前考的是「把模糊 brief 翻成可执行参数与提示词」，尚未接入真实出图评审） |
| **持续评估** | 用过之后谁更值得留 | 客观榜按完成度、返工率、耗时、成本排名；主观榜允许每位使用者按自身价值观重排；**上岗后的真实交付会回流成新的评测证据**，面试期承诺与上岗表现可对照 |

客观+主观的两张排名榜单并存是我们刻意的设计
也许有人认为保住任务完成度比省时间更重要，有人可能格外关注性价比。
因此，我们不假设某个单一的维度是最优解，而是将所有维度进行客观评估后，交由用户自行在主观榜单中排序自己心目中的最佳数字员工。
而AgentCorp则在用户的选择中更加明白什么样的数字员工匹配得上“老板”的喜好和需求。

## 一条闭环，而不是三个功能

AgentCorp 的三个界面是同一条链路上的三段，数据在其中单向流动、闭合成环：

```
   ①选人                      ②用人                      ③看人
人才市集 / HR 面试   ──→   看板派活 / 多 Agent 编排   ──→   数字办公室
（同题实测 + 沙盒执行）      （按六维与绩效路由指派）        （工位上直接看到
        ▲                                                    准入分与证据来源）
        │                                                          │
        └──────────── ④真实交付回流成新的评测证据 ←────────────────┘
```

- **① → ②**：路由不是随机分配。`squadRouting` 直接消费评估档案里的六维、user_fit
  与历史绩效（DyLAN 式贡献度加权），选人的结论真的决定了谁去干活。
- **② → ④ → ①**：任务交付后，真实产出与真实 token 花费会回流评估层
  （`services/workEvaluationLoop.ts`），六维与榜单随之更新。
  因此「面试时说得好听、上岗后天天返工」这件事系统能看见。
- **③ 的每张工位卡都标注证据来源**：`未评测` / `部分降级` / `含上岗表现`。
  办公室是「看人」的地方，一眼要能看出这个分是实测出来的还是离线兜底猜的。

这也是我们不把「像素办公室」当成美术皮肤的原因：它是闭环的第三段，
负责把抽象的分数还原成「这个人现在在干什么、凭什么在这儿」。

## 评估结论为什么可信

如果我们用模型给模型打分，那么首先要解决「裁判本身可不可靠」：

- **重复测量**：同一份作答独立评多次，每次都达标才判定为通过。
  第 0 次为温度 0 的可复现基准，之后各次走 `JUDGE_ENSEMBLE_TEMPERATURE`（默认 0.5）
  真实重采样；配置 `JUDGE_MODELS` 跨家族池后，第 i 次会轮转到不同家族的裁判。
  若两者都没配（k 次同模型、温度 0），系统会**自己在证据链里说明**
  「本轮不构成统计意义上的重复测量」，而不是装作做过。
- **稳定性检查**：多次评分离散过大时下调置信度并转人工复核。
- **裁判元评估**：评估中心内置「裁判健康度」面板 —— 使用者对结论做人工抽检
  （认可 / 不认可），系统据此计算裁判的人工认可率、Krippendorff α、
  时间漂移与置信校准缺口，并在认可率低于 0.67 时直接建议更换裁判。
  gold 只由人给：让模型为模型的结论背书会陷入无穷回归。
- **抗偏差设计**：轮换维度顺序、固定评分锚点、明确要求不因回答长而给高分。
- **可执行验证（两条独立证据链）**：代码题的 `code_runnability` 由沙盒真实执行背书，
  `code_security` 由静态扫描背书。二者不可互相代偿 ——
  一段 `eval(user_input)` 可以完美通过所有单元测试，所以「测试全绿」不能证明安全。
  候选给出的测试会在受限子进程里真实执行，「通过 4/4」与「第 2 个用例断言失败」
  都是可复核的机器事实。缺真实执行结果时该维权重主动 ×0.4 并在证据栏标注，
  **裁判自己的引文不具备解除降权的资格**——否则等于让被监管方给自己发合格证。
- **来源标注**：分数分为真实裁判 / 部分降级 / 完全降级三态。完全降级的条目
  **不进正式榜单**（单独灰色分区展示、不给名次），也不沉淀进经验库。

通过以上做法，AgentCorp系统目前只主张得出的结论是**稳定**的，但是暂时不主张结论是最**正确**的；而后者往往需要长期的真实表现数据验证，
这正是我们公开的下一阶段目标。

---

## 1. 快速开始

### 1.1 桌面端（Electron + React）

```bash
# 1) 安装依赖（pnpm 由 corepack 提供，版本锁定在 package.json 的 packageManager）
corepack pnpm install

# 2) 启动桌面端（vite dev server + vite-plugin-electron 自动拉起 Electron 主进程）
corepack pnpm dev
```

`pnpm dev` 会同时启动渲染层（Vite）与 Electron 主进程（`electron/main/index.ts`），
产出桌面窗口而非纯浏览器页面。主要页面：人才市集（Marketplace，S1 初审）→
HR 面试（Interview，S2）→ 评估中心（Evaluation，S3 绩效：雷达 / 讲解 / ROI /
生命周期 / 擂台 / 双轨评分 / 双榜 / 收敛 / 心智模型），外加任务看板、人力资产、
团队总览等管理页。

### 1.2 模型服务（评测裁判，Python + FastAPI + SSE）

评估中心的「运行评估」需要模型服务。**裁判后端可替换**（`JudgeBackend` 协议，见 §4）：
任何 OpenAI 兼容服务都能当裁判，也可用国内全模态模型（如 MiniCPM-o 4.5）统一推理评测
候选 Agent 的多模态产出（代码、图像、文案、语音）。
不绑定单一模型大厂既是我们工程上的需要，也是**抗自我增强偏差**的架构级保障。

```bash
cd model-service
pip install -r requirements.txt

# Mock 模式：不加载真模型，内联 fixture 驱动完整 SSE 事件流（演示/联调用）
MOCK=true uvicorn app.serve:app --port 8000

# 真实模式（推荐）：任意 OpenAI 兼容云服务作裁判，零硬件门槛
MOCK=false JUDGE_BACKEND=http \
  JUDGE_BASE_URL=<your_openai_compatible_endpoint> \
  JUDGE_API_KEY=<your_key> JUDGE_MODEL=<model_name> \
  uvicorn app.serve:app --port 8000
```

访问 `http://localhost:8000/docs` 查看接口；`/health` 查看模型可用性
（真实模式下 `model_available=true` 即裁判就绪）。

### 1.3 代码题真实执行验证（可选，但建议开）

```bash
# 在 model-service 启动命令前加上开关即可
SANDBOX_ENABLED=true SANDBOX_TIMEOUT=10 SANDBOX_MEM_MB=512 \
  uvicorn app.serve:app --port 8000
```

开启后，`code` 工种的试做题会跑两条独立的机器证据链：
1. **执行**：把候选写的测试真的跑一遍 → 「沙盒执行：4/4 用例通过（212ms）」
   → 解除 `code_runnability` 的权重折减；
2. **扫描**：AST 静态扫描（装了 bandit 则优先用 bandit）→
   「静态扫描（builtin-ast，13 条规则）：1 处高危；L2 dangerous-call:eval」
   → 解除 `code_security` 的权重折减。
独立复核用 `POST /api/craft-verify`（只执行、不评分、不花裁判的钱）。

**默认关闭**：它会在本机执行来自候选 agent 的代码，必须由部署者显式授权。

---

## 2. 目录结构

```
agentcorp/
├── docs/                      # PRD / 架构 / 类图 / 时序图
├── package.json / vite.config.ts / vitest.config.ts / tailwind.config.js / tsconfig*.json
├── electron/                  # Electron 主进程与 preload
│   ├── main/                  # 主进程入口（窗口、生命周期）
│   ├── preload/               # preload 桥（contextBridge）
│   ├── api/ gateway/ services/ shared/ utils/
├── shared/                    # 主进程与渲染层共享代码
├── samples/                   # 固定候选样本集（profile.json + 占位媒体）
├── scripts/                   # 构建/打包/QA/i18n 工具脚本（含 i18n/check-parity.mjs）
├── tests/unit/                # vitest 单元测试（jsdom + node 双环境）
├── src/                       # 渲染层（React 19 + TS + Tailwind）
│   ├── pages/                 # Chat / Marketplace / Interview / Evaluation /
│   │                          #   Kanban / TeamOverview / TeamMap / Agents / Settings 等
│   ├── components/            # layout / evaluation / marketplace / interview / office / ui
│   ├── office/                # 像素办公室（Agent 工作可视化）
│   ├── stores/                # Zustand 全局状态（agents / evaluation / marketplace / ...）
│   ├── engine/                # 纯逻辑层：strategyEngine / roiEngine / metricsEngine /
│   │                          #   scoring / marketplace / interview / convergence
│   ├── services/              # 运行时服务：evaluationRuntime / judgeClient / speech / ...
│   ├── i18n/                  # react-i18next（zh 基准 + en）
│   ├── hooks/  lib/  styles/  utils/
│   └── types/                 # 前端契约类型（按域拆分：evaluation / marketplace / ...）
└── model-service/             # 评测裁判服务（Python + FastAPI + SSE）
    ├── requirements.txt / Dockerfile / docker-compose.yml
    ├── models/                # GGUF 权重（自行下载，不入仓）
    ├── tests/                 # pytest（契约 + 评分 + 收敛 + GGUF 后端，不依赖真模型）
    └── app/
        ├── serve.py           # FastAPI 入口（只做装配，挂 6 个路由域）
        ├── routes/            # samples / evaluate / upload / convergence / leaderboard / health
        ├── scoring/           # registry / rules_engine / stage_scorer / presets /
        │                      #   convergence / preference / encoder / task_sets
        ├── schemas.py         # Pydantic 契约（与前端 src/types/ 镜像）
        ├── config.py          # 环境变量配置（MOCK / MODEL_PATH / DEVICE / TTS_BACKEND）
        ├── model_loader.py    # 裁判模型加载（GGUF / 全量权重，优雅降级）
        ├── evaluator.py       # 跨模态评估 pipeline + 可测试 Mock 流
        ├── prompt_templates.py# 强制六维 JSON 的系统提示
        └── tts.py             # 语音合成统一接口
```

---

## 3. 前后端契约（解耦关键）

前端 `src/types/`（按域拆分，评估相关在 `evaluation.ts`）与后端
`model-service/app/schemas.py` **严格镜像**。

- 请求：`EvaluationRequest { candidate, preference, options? }`
- SSE 事件流（`text/event-stream`）五种事件：
  - `radar_update`：逐维点亮（dim / score / confidence / evidence）
  - `narration`：讲解文本增量（delta / is_final）
  - `audio`：语音块（chunk 为 base64；真实=PCM16/wav 字节，Mock=UTF-8 文本）
  - `verdict`：终审判定（verdict / user_fit / evidence_trace / confidence）
  - `done`：评估完成（evaluation_id）
- 评估运行（`/api/evaluate-run`）在同构事件流上扩展 `convergence_update` /
  `task_run` / `convergence_score` 事件（Task-Set 调度 + 收敛层度量）。

渲染层不直连模型服务：请求经 `hostApiFetch` → IPC → 主进程本地 HTTP server
（`127.0.0.1:3210`）转发，凭据只存在于主进程，渲染层拿不到。

---

## 4. 接入真实裁判模型

> **裁判后端是可替换的，这是刻意的架构决策，不是妥协。**
> 用模型评模型天然有「自我增强偏差」（裁判偏爱与自己同家族的产出）。
> 因此本项目把推理后端抽象为 `JudgeBackend` 协议（`model-service/app/judge_backend.py`），
> 任何 OpenAI 兼容服务都能作为裁判接入，评估体系不绑定任何单一模型或单一芯片。
> 换后端只改环境变量，评分逻辑、Skill 契约、Trace 结构一律不动。

四条路径按「上手成本」排序，代码路径完全一致：

| 路径 | 后端 | 适用场景 | 硬件要求 |
|---|---|---|---|
| **A（默认推荐）** | `JUDGE_BACKEND=http` | 任何 OpenAI 兼容云服务（阿里云百炼/通义、火山方舟、OpenAI…） | 无，联网即可 |
| B | `JUDGE_BACKEND=http` + 本地 vLLM | 自建推理服务 | GPU |
| C | 端侧 GGUF | 离线复现、评委笔记本 | CPU/Metal 即可 |
| D | 本机全量权重 | 需要视觉/音频模态 | GPU 或异构加速卡（NPU 等） |

### 路径 A · OpenAI 兼容云服务（默认推荐，零硬件门槛）

```bash
cd model-service
pip install -r requirements.txt

# 以阿里云百炼（DashScope OpenAI 兼容模式）为例：
MOCK=false \
JUDGE_BACKEND=http \
JUDGE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
JUDGE_API_KEY=<your_api_key> \
JUDGE_MODEL=qwen-plus \
uvicorn app.serve:app --port 8000

# 换成任意其它 OpenAI 兼容端点同理，只改这三个环境变量：
# JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL
```

`judge_backend.py` 的 HTTP 后端用标准库 `urllib` 实现（零新增依赖），
并统一采集 `ttft_ms` / `latency_ms` / `usage`，供成本与时延归因。

### 路径 B · 自建 vLLM / 本地推理服务

同路径 A，把 `JUDGE_BASE_URL` 指向自建服务即可（如 `http://localhost:8080/v1`）。

### 路径 C · 端侧 GGUF（离线复现，CPU/Metal 即可）

无需 torch / transformers，最容易复现。

```bash
pip install llama-cpp-python
# macOS 建议启用 Metal 加速：
# CMAKE_ARGS="-DGGML_METAL=on" pip install llama-cpp-python

# 下载 GGUF 权重（Q4_K_M 约 5.4GB；ModelScope 国内更快）
mkdir -p models && curl -L -o models/MiniCPM-o-4_5-Q4_K_M.gguf \
  "https://modelscope.cn/models/OpenBMB/MiniCPM-o-4_5-gguf/resolve/master/MiniCPM-o-4_5-Q4_K_M.gguf"

MOCK=false MODEL_PATH=models/MiniCPM-o-4_5-Q4_K_M.gguf uvicorn app.serve:app --port 8000
# /health 返回 model_available=true 即真实裁判就绪
# 注：GGUF 路径仅文本推理（裁判场景够用）；视觉/音频模态需路径 B
```

### 路径 D · 本机全量权重（需要视觉/音频模态时）

```bash
pip install "transformers==4.51.0" accelerate "torch>=2.3.0,<=2.8.0" \
    "torchaudio<=2.8.0" "minicpmo-utils[all]>=1.0.5" librosa opencv-python

MOCK=false JUDGE_BACKEND=local DEVICE=cuda MODEL_PATH=/models/<your-omni-model> \
  uvicorn app.serve:app --port 8000
```

`DEVICE` 默认 `auto`（按 NPU > CUDA > CPU 探测），支持 `cuda|cpu|auto`，另可选装对应厂商的异构加速运行时后按
`DEVICE=npu` 启用（`model_loader.py` 惰性 import，缺依赖自动降级，不崩）。
容器部署见 `model-service/docker-compose.yml`。

### 昇腾统一环境 · Web Demo（无 Electron，一条命令起全栈）

产品有两种形态：本地桌面端（Electron，请求经主进程 Host API 转发）与
统一环境 Web 形态（前端构建产物由 model-service 同源托管，浏览器直接使用）。
后者面向昇腾评测机场景：

```bash
# 在仓库根目录执行（build context 需要前端源码）
docker compose -f model-service/docker-compose.ascend.yml up --build
# 浏览器访问 http://127.0.0.1:8000
```

- `model-service/Dockerfile.ascend`：多阶段构建——Node 阶段产出 `dist-web`
  （`pnpm build:web`），CANN 基座阶段以 `WEB_ROOT=/app/web` 同源托管
  （含 SPA 路由回退与 `/api/evaluate/run` 别名）；基座镜像可经
  `ASCEND_BASE_IMAGE` 覆盖（FlagOS 运行时镜像就绪后同参切换）。
- 默认 `MOCK=false` + NPU 设备透传（`/dev/davinci0`、`/dev/davinci_manager`）；
  端口只绑宿主回环，评测机之外访问改为 `"8000:8000"` 并自行加前置鉴权。
- 部署后验证：`./scripts/e2e_ascend.sh`（/health 断言 → SSE 冒烟 → 测试套件）。
- 完整部署 runbook、任务拆解与风险登记见 `docs/ascend-adaptation-plan.md`。

前端无需额外开关：渲染层不直连模型服务，请求统一经主进程 Host API
（`127.0.0.1:3210`）转发到 model-service。裁判是否为真，由 model-service 侧的
`JUDGE_BACKEND` 决定，并通过事件里的 `source`（judge / mixed / degraded）如实回传给界面。
全量环境变量见 `.env.example`。

**降级行为**：缺依赖 / 缺权重 / 无可用设备时服务照常启动，`/health` 报
`model_available=false`，真实模式下 `/api/evaluate` 返回 `503` 并给出明确错误，
绝不 ImportError 崩溃。TTS 同理：优先模型原生（`init_tts`），其次系统命令
（macOS `say` / Linux `espeak-ng`），都没有则只发文本不发 audio 事件
（`TTS_BACKEND=auto|model|system|none`）。

---

## 5. 测试

前端（vitest，`tests/unit/`，不依赖 Electron 与真模型）：

```bash
corepack pnpm test          # 全量单元测试
corepack pnpm test:a11y     # a11y（axe）专项
corepack pnpm typecheck     # TS 双 tsconfig 类型检查
corepack pnpm lint:check    # eslint
corepack pnpm i18n:check    # zh/en 语言包 key parity
```

模型服务（pytest，`model-service/tests/`，不依赖真模型）：

```bash
cd model-service
pip install -r requirements.txt
MOCK=true python -m pytest tests/ -q
```

覆盖：user_fit 满分 / 超预算硬约束 / 审美减分、模型 JSON 解析、SSE 事件流 schema
（六维逐维点亮 / verdict / done）、三阶段评分（S1/S2/S3 rules engine）、
Q6 降权闸门（requiresReal 维只认真实执行/扫描证据，裁判引文不作数）、
收敛层（encoder / preference / convergence）、GGUF 后端降级、未知候选兜底、
craft 试做题评分与越界维度丢弃、Arena 对决与 Elo、跨用户反应聚合。

前端侧另有诚实化回归：离线回退的分数**不得**与 agentId 相关（改名不能改分），
零证据时全维中性 2.5 并标注「不可评」（`tests/unit/judgeClient.test.ts`）。

CI（`.github/workflows/ci.yml`）：push 到 `main` / `feat/*` 与 PR 触发，
前端 job 跑 install → typecheck → lint → test，model-service job 跑 pytest。

---

## 6. 适用范围与已知边界

我们把限制写在明处，而不是等使用者自己撞上：

- **离线演示模式不依赖任何加速硬件或真实媒体**，可完整查看产品形态与闭环流程；
  它用于理解系统结构，不代表真实推理链路的评测结论。
- **真实媒体样本不入仓**，部署时置入 `samples/candidate-XX/`（见 `samples/README.md`）。
- **单次任务 + 单一已知 Agent 的场景下，本评估层是额外开销**。
  它的价值出现在候选多、任务重复、选错代价高的场景。
- **评估过程全程留痕**（`evidence_trace`），支持人工抽检。
  用模型评估模型存在固有的元评估风险，留痕是缓解手段而非消除。
- **收敛指标度量的是人机对齐过程，不等同于 Agent 能力**。
  能力判断以真实工种实测的评分结果为准。
- **当前指标验证的是结论的稳定性，尚未验证预测有效性**。
  准入评分与上线后真实表现的相关性验证是我们公开的下一阶段目标。
- **静态扫描能证明「扫过了」，不能证明「是安全的」**。证据文本写的是
  「扫描 N 条规则，0 处高危」，陈述的是扫描这件事及其结果 ——
  没有任何静态工具能给出安全性的肯定结论，我们也不假装能给。
  内置 AST 扫描器覆盖 OWASP 里对 Python 最常见的一组高危构造（规则表在
  `sandbox/security_scan.py` 里显式列出、可复核）；环境装了 bandit 时自动优先用它。
- **沙盒提供的是资源限制 + 隔离目录 + 超时强杀，不提供网络与文件系统隔离**。
  多租户场景需要容器化，这一点写在明处而不是含糊带过。
- **候选没写测试 ≠ 候选写得不好**。这两种情况在结论里严格区分：
  前者 `outcome=no_tests`（不解除降权、也不扣分），后者 `outcome=failed`（真实失败证据）。
- **裁判与候选可能同源**。若 `JUDGE_MODEL` 与候选 agent 使用同一家族的模型，
  自我增强偏差无法通过架构消除。建议评测时显式选用与候选不同家族的裁判，
  并用双榜与人工抽检交叉验证。

---

## 7. 许可

MIT。Forked from ClawCorp (MIT)。
