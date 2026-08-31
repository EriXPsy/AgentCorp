/**
 * vite-plugin-llm-proxy.ts
 * Vite dev server 中间件：把前端的 POST /api/llm/chat 代理到真实 LLM
 * （OpenAI 兼容端点，如 DeepSeek / 火山方舟 Ark / 昇腾 MindIE）。
 *
 * 为什么需要它：Web 预览是纯前端（无 Electron 主进程 / 无独立后端），
 * 若把 API key 放到 VITE_* 前端变量会被打进浏览器包并暴露。这里让 key 只在
 * Node 侧（dev server 进程）读取（process.env.LLM_API_KEY），前端只调同源
 * /api/llm/chat，绝不接触 key。
 *
 * 核心逻辑在 api/_llm-core.ts（与 Vercel Serverless Function 共用同一份，
 * 保证本地 dev / 昇腾 web 预览 / Vercel 三端行为一致）。
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleLlmChat } from './api/_llm-core';

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

        try {
          const raw = await readBody(req);
          const { status, payload } = await handleLlmChat(raw, process.env);
          sendJson(res, status, payload);
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
