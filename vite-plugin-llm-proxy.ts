/**
 * vite-plugin-llm-proxy.ts
 * Vite dev server 中间件：把前端的 POST /api/llm/chat 代理到真实 LLM
 * （OpenAI 兼容端点，如火山方舟 Ark）。
 *
 * 为什么需要它：Web 预览是纯前端（无 Electron 主进程 / 无独立后端），
 * 若把 API key 放到 VITE_* 前端变量会被打进浏览器包并暴露。这里让 key 只在
 * Node 侧（dev server 进程）读取（process.env.LLM_API_KEY），前端只调同源
 * /api/llm/chat，绝不接触 key。
 *
 * 真实执行：请求体 { message, system?, maxTokens? } → 调用 {LLM_BASE_URL}/chat/completions，
 * 返回 { content, raw }。content 优先取 choices[0].message.content；推理模型该字段
 * 可能为空，则兜底 reasoning_content，保证「有真实产出」而非静默空成功。
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: unknown;
  model?: string;
  error?: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(payload);
}

export function llmProxyPlugin(): Plugin {
  return {
    name: 'agentcorp-llm-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/llm/chat', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }

        const apiKey = process.env.LLM_API_KEY || process.env.ASCEND_API_KEY;
        const baseUrl = process.env.LLM_BASE_URL || process.env.ASCEND_BASE_URL;
        const model = process.env.LLM_MODEL || process.env.ASCEND_MODEL;
        if (!apiKey || !baseUrl || !model) {
          sendJson(res, 503, {
            error: 'llm_not_configured',
            detail: '缺少 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（或 ASCEND_* 等价项，见 .env）',
          });
          return;
        }

        try {
          const raw = await readBody(req);
          const parsed = raw ? (JSON.parse(raw) as {
            message?: string;
            system?: string;
            maxTokens?: number;
            messages?: Array<{ role: string; content: string }>;
          }) : {};

          // 支持两种入参：单条 {system?, message} 或完整 {messages[]}（多 agent 协作用）。
          let messages: Array<{ role: string; content: string }>;
          if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
            messages = parsed.messages
              .filter((m) => m && typeof m.content === 'string' && m.content.trim())
              .map((m) => ({ role: m.role || 'user', content: m.content }));
            if (messages.length === 0) {
              sendJson(res, 400, { error: 'empty_message' });
              return;
            }
          } else {
            const message = (parsed.message ?? '').trim();
            if (!message) {
              sendJson(res, 400, { error: 'empty_message' });
              return;
            }
            messages = [];
            if (parsed.system) messages.push({ role: 'system', content: parsed.system });
            messages.push({ role: 'user', content: message });
          }

          const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages,
              // 推理模型会先消耗 tokens 思考，给足额度避免 content 为空。
              max_tokens: parsed.maxTokens ?? 2048,
              stream: false,
            }),
          });

          const json = (await upstream.json()) as ChatResponse;
          if (!upstream.ok) {
            sendJson(res, 502, { error: 'upstream_error', status: upstream.status, detail: json });
            return;
          }

          const choice = json.choices?.[0]?.message;
          const content =
            (choice?.content && choice.content.trim()) ||
            (choice?.reasoning_content && choice.reasoning_content.trim()) ||
            '';
          sendJson(res, 200, {
            content,
            finishReason: json.choices?.[0]?.finish_reason ?? null,
            usage: json.usage ?? null,
            // 模型名一并透传，供前端成本看板按模型估价。
            model: json.model ?? model,
          });
        } catch (err) {
          sendJson(res, 500, {
            error: 'proxy_failure',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  };
}
