# AgentCorp Vercel 部署指南

> 适用对象：把 AgentCorp 的 Web 预览版（无 Electron 主进程）部署到 Vercel，
> 获得公网可访问的群聊 / 团队房间演示环境，LLM 走同源 Serverless 代理。

---

## 1. 架构

```
浏览器（dist-web 静态资源，Vercel CDN）
  └─ POST /api/llm/chat（同源）
       └─ api/llm/chat.ts（Vercel Serverless Function，Node runtime）
            └─ {LLM_BASE_URL}/chat/completions（DeepSeek / Ark / 昇腾 MindIE 等 OpenAI 兼容端点）
```

- 前端构建：`pnpm build:web`（vite + `vite.web.config.ts`，产物 `dist-web/`，
  含 `index.html` 与 `demo.html` 双入口）。
- 前端路由是 HashRouter（`/#/team-space/...`），**无需 SPA rewrite 规则**。
- LLM 代理核心在 `api/_llm-core.ts`，与本地 dev 的 `vite-plugin-llm-proxy.ts`
  共用同一份逻辑，本地 / 昇腾服务器 / Vercel 三端行为一致。
- `vercel.json` 已声明：`buildCommand=pnpm build:web`、`outputDirectory=dist-web`、
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1`（跳过 Electron 二进制下载，CI/服务端装依赖更快）。

## 2. 部署步骤

### 2.1 导入项目

Vercel Dashboard → Add New → Project → 选择 `EriXPsy/AgentCorp` 仓库。
Vercel 会自动识别 `vercel.json`，无需手改构建配置；包管理器按
`package.json` 的 `packageManager` 字段走 pnpm。

### 2.2 配置环境变量（必需）

Project Settings → Environment Variables，**Server-side only，绝不加 `VITE_` 前缀**
（`VITE_*` 会被打进浏览器 bundle，key 直接泄露）：

| 变量 | 示例 | 说明 |
|------|------|------|
| `LLM_API_KEY` | `sk-...` | 上游 API key |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |

昇腾 MindIE / vLLM-Ascend 端点则改用 `ASCEND_API_KEY` / `ASCEND_BASE_URL` /
`ASCEND_MODEL`（与 `LLM_*` 互为回退，见 `api/_llm-core.ts`）。

### 2.3 验证

部署完成后：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-app>.vercel.app/
curl -s -X POST https://<your-app>.vercel.app/api/llm/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"用一句话介绍你自己","maxTokens":48}'
```

预期：首页 200；chat 接口返回 `{"content":"...","finishReason":"stop",...}`。
若返回 503 `llm_not_configured` → 环境变量没配或配错环境（要勾选 Production）。

## 3. 已知边界

- 这是 **Web 预览形态**：群聊、团队房间、真实 LLM 执行可用；依赖 Electron
  主进程的能力（本地 gateway、宿主工具、Python worker 沙箱）在浏览器里是
  no-op shim，与昇腾服务器 web 预览一致。
- Serverless Function 有执行时长上限（Hobby 默认 60s）；`realExecutor` 前端
  默认超时 120s，长输出建议把 `maxTokens` 控制在合理范围或升级 Pro。
- `/api/llm/chat` 当前为非流式（`stream:false`），前端走「全文到手分段 reveal」
  兜底；SSE 真流式在 Serverless 上未启用（Electron host-api 路径支持）。
