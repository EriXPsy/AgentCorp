# AgentCorp 昇腾（Ascend）部署指南

> 适用对象：在华为昇腾 NPU 环境（Atlas 800 A2 / 910B 系列等）上部署
> AgentCorp 所需的 OpenAI 兼容推理端点与 model-service 评委容器。
>
> 本文所有具体版本号（CANN / 固件 / torch / torch_npu / vllm-ascend）均为
> 编写时的典型组合，**最终以 [vLLM-Ascend 官方安装文档](https://docs.vllm.ai/projects/ascend/en/latest/installation.html)
> 与所用固件的兼容矩阵为准**。

---

## 1. 环境要求

### 1.1 硬件与驱动

- 硬件：搭载昇腾 NPU 的服务器，常见为 Atlas 800 A2 系列（910B/910B3/910B4）。
- 固件 / 驱动：Ascend HDK 驱动固件，需与 CANN 版本配套（对应关系以昇腾官方兼容矩阵为准）。
- 确认设备可见：宿主机执行 `npu-smi info` 能看到 NPU 列表，且 `/dev/davinci*`、`/dev/davinci_manager` 设备节点存在。

### 1.2 软件栈（典型版本，以官方为准）

vLLM-Ascend 要求 **CANN、torch、torch_npu 严格按同一套兼容矩阵安装**：

| 组件 | 典型版本 | 说明 |
|------|---------|------|
| Python | >= 3.10, < 3.13 | 以 vLLM-Ascend 官方要求为准 |
| CANN | 8.x（如 8.1.RC1；较新矩阵要求 8.5+） | 含 Toolkit + NNAL，装完 `source /usr/local/Ascend/ascend-toolkit/set_env.sh` |
| torch / torch_npu | 同版本号（如 2.7.1 / 2.5.1，视 vllm-ascend 版本而定） | 必须互相匹配 |
| vllm / vllm-ascend | 按官方兼容矩阵 | `pip install vllm vllm-ascend` |

> 强烈建议直接用 vLLM-Ascend 官方预构建镜像（`quay.io/ascend/vllm-ascend:<tag>`），
> 镜像内 CANN / torch / torch_npu / vllm-ascend 已按同一组合锁定，免去手工对齐版本三角。
> 具体镜像 tag 以 vLLM-Ascend 官方发布页为准。

---

## 2. 启动 OpenAI 兼容推理服务

### 2.1 方式一：vLLM-Ascend（推荐）

在装好上述环境的机器（或官方容器）内：

```bash
# DeepSeek 示例
vllm serve deepseek-ai/DeepSeek-V3 \
  --tensor-parallel-size 4 \
  --max-model-len 8192 \
  --port 8000

# Qwen 示例
vllm serve Qwen/Qwen3-32B \
  --tensor-parallel-size 2 \
  --max-model-len 8192 \
  --port 8000
```

起好后服务即暴露 OpenAI 兼容端点：

- `GET  http://<ascend-host>:8000/v1/models`
- `POST http://<ascend-host>:8000/v1/chat/completions`（支持 `stream: true`）

也可以直接使用本仓库提供的编排样例，一条命令把推理服务与评委容器一起拉起，
见 `deploy/ascend/docker-compose.ascend-llm.yml`（§4）。

### 2.2 方式二：MindIE（简述）

华为自研推理引擎 MindIE（MindIE Service）同样可暴露 OpenAI 兼容接口：
按 MindIE 官方文档配置模型 JSON（指定权重路径、NPU 卡数），启动
`mindieservice_daemon` 后，默认在 `https://<host>:1025/v1` 提供
`/models`、`/chat/completions` 等 OpenAI 兼容 API（默认开 HTTPS + 鉴权）。
**端口、证书与鉴权配置以 MindIE 官方文档为准**——对 AgentCorp 而言，
MindIE 与 vLLM-Ascend 的唯一区别是 baseUrl 和 API key 的取值。

### 2.3 方式三：华为云 MaaS（ModelArts Studio）

无自有 NPU 时可直接用华为云 MaaS 上托管的 DeepSeek / Qwen 等模型的
OpenAI 兼容端点，在控制台创建 API key 后把「endpoint + key」按 §3 填入即可，
AgentCorp 侧配置与自建 vLLM-Ascend 完全一致。

---

## 3. AgentCorp 端配置（两种方式）

推理服务就绪后，AgentCorp 把它当作普通 OpenAI 兼容提供方接入。

### 3.1 方式一：Settings UI（推荐）

1. 打开 AgentCorp → **设置 → 模型与提供方**。
2. 选择 **华为昇腾 (Ascend)**。
3. 填写：
   - **Base URL**：`http://<ascend-host>:8000/v1`（占位默认值 `http://ascend-host:8000/v1` 需替换为真实地址）
   - **API Key**：vLLM 默认无鉴权时可填任意非空串；MindIE / MaaS 填真实 key
   - **模型 ID**：与 `vllm serve` 的模型名一致，如 `deepseek-ai/DeepSeek-V3`
4. 保存前可点「校验」——后端走 `openai-completions` 校验 profile
   （`GET {base}/models`，404 时回退 `POST /chat/completions` 探测），
   与 vLLM-Ascend / MindIE / MaaS 端点天然兼容，无需特殊处理。

### 3.2 方式二：.env（跑题通道直连）

复制 `.env.example` 为 `.env`，填昇腾端点（见 `.env.example` 的昇腾示例块）：

```bash
LLM_BASE_URL=http://<ascend-host>:8000/v1
LLM_API_KEY=your_ascend_api_key
LLM_MODEL=deepseek-ai/DeepSeek-V3
```

评委（judge）走昇腾端点时同理设置 `JUDGE_BACKEND=http` +
`JUDGE_BASE_URL` / `JUDGE_API_KEY` / `JUDGE_MODEL`。

---

## 4. 编排部署（推理 + 评委容器）

### 4.1 推理服务 + 评委统一编排

`deploy/ascend/docker-compose.ascend-llm.yml` 提供两个服务的编排样例：

- `ascend-llm`：vLLM-Ascend OpenAI 兼容推理服务（官方镜像 + NPU 设备透传）；
- `agentcorp-model`：model-service 评委容器（复用仓库已有
  `model-service/Dockerfile.ascend` 与 `model-service/docker-compose.ascend.yml` 的写法，
  `JUDGE_BASE_URL` 指向上面的推理服务）。

```bash
# 在仓库根目录
docker compose -f deploy/ascend/docker-compose.ascend-llm.yml up --build
```

compose 文件内有充分注释，按 NPU 卡数、模型大小裁剪即可。

### 4.2 仅评委容器

如果推理服务已在别处就绪（含 MaaS），只需评委容器：

```bash
cd model-service
JUDGE_BACKEND=http \
JUDGE_BASE_URL=http://<ascend-host>:8000/v1 \
JUDGE_API_KEY=<key> \
JUDGE_MODEL=deepseek-ai/DeepSeek-V3 \
docker compose -f docker-compose.ascend.yml up --build
```

runbook 细节见 `docs/ascend-adaptation-plan.md` §7。

### 4.3 冒烟验证

部署完成后跑端到端冒烟（未配置环境变量时自动 SKIP，exit 0，方便 CI）：

```bash
ASCEND_BASE_URL=http://<ascend-host>:8000/v1 \
ASCEND_API_KEY=<key> \
ASCEND_MODEL=deepseek-ai/DeepSeek-V3 \
corepack pnpm verify:ascend
```

覆盖四项：① `GET /v1/models` 连通 ② 非流式 chat/completions 拿到 content
③ `stream: true` 收到 SSE 分片 ④（可选）评委端点 `/models` ping。
报告写入 `docs/artifacts/ascend-verification-report.md`。

---

## 5. 常见坑

| 现象 | 原因 | 处理 |
|------|------|------|
| 404 Not Found | baseUrl 少了 `/v1` 后缀 | AgentCorp 填的是 OpenAI **根**端点，必须带 `/v1`：`http://host:8000/v1`（直接拼 `/chat/completions` 结尾的完整路径也可以，校验逻辑会识别） |
| 401 / 403 | 鉴权头不对 | MindIE / MaaS 需要真实 API key（`Authorization: Bearer <key>`）；自建 vLLM 默认无鉴权，填任意非空串即可通过 UI 校验 |
| 起服务 OOM / 加载失败 | NPU 显存不足或 dtype 不匹配 | 用 bf16 权重（昇腾主线支持好）；调小 `--max-model-len`；调大 `--gpu-memory-utilization` 的反面（vllm-ascend 下即 NPU 显存水位）；多卡加 `--tensor-parallel-size` |
| `pip install torch_npu` 解析不到 wheel | Python 版本错配（ML wheel 多为 3.10/3.11） | 用 vLLM-Ascend 官方预构建镜像，或在 3.10/3.11 venv 内安装；不要在 Python 3.12 系统环境直接装 |
| 推理结果异常 / 算子报错 | CANN ↔ torch ↔ torch_npu 版本三角不匹配 | 严格按 vLLM-Ascend 官方兼容矩阵整套安装，或直接用官方镜像 |
| 容器内看不到 NPU | 设备未透传 | compose `devices` 段挂载 `/dev/davinci0`、`/dev/davinci_manager`，多卡/部分驱动版本还需 `/dev/devmm_svm`、`/dev/hisi_hdc`（见 §4 compose 注释） |
| 响应特别慢 | 默认采样参数或上下文过长 | 评测场景建议 temperature=0（复现控制）；裁剪 `--max-model-len` 与 prompt 长度 |
