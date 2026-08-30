#!/usr/bin/env node
/**
 * 昇腾（Ascend）OpenAI 兼容端点冒烟验证。
 *
 * 对配置好的端点依次验证：
 *   ① GET  {base}/models                —— 连通性
 *   ② POST {base}/chat/completions      —— 非流式拿到 content
 *   ③ POST {base}/chat/completions      —— stream:true 收到 SSE 分片
 *   ④ GET  {judge}/models               —— 可选：评委（judge）链路 ping
 *
 * 端点从环境变量读取（ASCEND_* 优先，回退 LLM_*）：
 *   ASCEND_BASE_URL  或  LLM_BASE_URL   例：http://ascend-host:8000/v1
 *   ASCEND_API_KEY   或  LLM_API_KEY    无鉴权的自建 vLLM 可留空
 *   ASCEND_MODEL     或  LLM_MODEL      缺省时取 /models 返回的第一个模型
 *   JUDGE_BASE_URL / JUDGE_API_KEY      可选：配置后追加评委链路 ping
 *
 * 未配置 baseUrl 时全部步骤 SKIP 并 exit 0（方便 CI 门禁不挂）。
 * 报告写入 docs/artifacts/ascend-verification-report.md（已脱敏）。
 *
 * 用法：node scripts/qa/ascend-verify.mjs  （或 corepack pnpm verify:ascend）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const reportPath = join(root, 'docs/artifacts/ascend-verification-report.md');

/** 与 scripts/qa/release-verify.mjs 对齐的脱敏规则 */
const PRIVACY_RE = /陈思丞|C:[/\\]Users|\/c\/Users|\.workbuddy|\.trae|\/Users\/[^\s]*|\/home\/[^\s]*/g;

const baseUrl = (process.env.ASCEND_BASE_URL || process.env.LLM_BASE_URL || '').trim().replace(/\/+$/, '');
const apiKey = (process.env.ASCEND_API_KEY || process.env.LLM_API_KEY || '').trim();
let model = (process.env.ASCEND_MODEL || process.env.LLM_MODEL || '').trim();
const judgeBaseUrl = (process.env.JUDGE_BASE_URL || '').trim().replace(/\/+$/, '');
const judgeApiKey = (process.env.JUDGE_API_KEY || '').trim();

/** 脱敏：绝对路径 / 受限 token / API key 一律不落盘 */
function sanitize(text) {
  let out = String(text).split(root).join('<repo>').replace(PRIVACY_RE, '<redacted>');
  for (const secret of [apiKey, judgeApiKey]) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}

const TIMEOUT_MS = 30_000;

function authHeaders(key) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（如流式），保留原始文本 */
  }
  return { status: response.status, data, text };
}

/** 读取 SSE 流，收集 data: 分片，遇到 [DONE] 或达到分片上限即停止 */
async function readSseChunks(response, maxChunks = 8) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks = [];
  let done = false;
  while (!done && chunks.length < maxChunks) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        done = true;
        break;
      }
      chunks.push(payload);
    }
  }
  await reader.cancel().catch(() => {});
  return chunks;
}

const results = [];
let allPass = true;

async function runStep(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail: sanitize(detail ?? ''), durationMs: Date.now() - startedAt });
    console.log(`[PASS] ${name} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    allPass = false;
    const detail = sanitize(err instanceof Error ? err.message : String(err));
    results.push({ name, status: 'FAIL', detail, durationMs: Date.now() - startedAt });
    console.log(`[FAIL] ${name}: ${detail}`);
  }
}

function skipStep(name, reason) {
  results.push({ name, status: 'SKIP', detail: reason, durationMs: 0 });
  console.log(`[SKIP] ${name}: ${reason}`);
}

const configured = Boolean(baseUrl);

if (configured) {
  await runStep('① GET /models 连通性', async () => {
    const { status, data } = await requestJson(`${baseUrl}/models`, {
      headers: authHeaders(apiKey),
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const ids = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
    if (ids.length === 0) throw new Error('/models 响应缺少 data 数组');
    if (!model) model = ids[0];
    return `模型列表 ${ids.length} 个，使用模型：${model}`;
  });

  await runStep('② POST /chat/completions 非流式', async () => {
    if (!model) throw new Error('无可用模型（①失败且未配置 ASCEND_MODEL）');
    const { status, data } = await requestJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('响应缺少 choices[0].message.content');
    }
    return `content 长度 ${content.length}`;
  });

  await runStep('③ POST /chat/completions 流式（SSE）', async () => {
    if (!model) throw new Error('无可用模型（①失败且未配置 ASCEND_MODEL）');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
        stream: true,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    const chunks = await readSseChunks(response);
    if (chunks.length === 0) throw new Error('未收到任何 SSE data 分片');
    return `收到 ${chunks.length} 个 SSE 分片`;
  });

  if (judgeBaseUrl) {
    await runStep('④ 评委链路 ping（JUDGE_BASE_URL /models）', async () => {
      const { status, data } = await requestJson(`${judgeBaseUrl}/models`, {
        headers: authHeaders(judgeApiKey),
      });
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      const count = Array.isArray(data?.data) ? data.data.length : 0;
      return `评委端点可用，模型数 ${count}`;
    });
  } else {
    skipStep('④ 评委链路 ping', '未配置 JUDGE_BASE_URL，跳过');
  }
} else {
  skipStep('① GET /models 连通性', '未配置 ASCEND_BASE_URL / LLM_BASE_URL');
  skipStep('② POST /chat/completions 非流式', '未配置 ASCEND_BASE_URL / LLM_BASE_URL');
  skipStep('③ POST /chat/completions 流式（SSE）', '未配置 ASCEND_BASE_URL / LLM_BASE_URL');
  skipStep('④ 评委链路 ping', '未配置 ASCEND_BASE_URL / LLM_BASE_URL');
}

const now = new Date().toISOString();
const hasSkipOnly = results.every((r) => r.status === 'SKIP');
const conclusion = allPass
  ? hasSkipOnly
    ? '⏭️ SKIP（未配置端点，全部跳过）'
    : '✅ PASS（全部冒烟通过）'
  : '❌ FAIL（存在失败步骤）';

const statusMark = { PASS: '✅ PASS', FAIL: '❌ FAIL', SKIP: '⏭️ SKIP' };
const lines = [
  '# 昇腾端点冒烟验证报告',
  '',
  `生成时间：${now}（由 \`verify:ascend\` 自动生成，勿手改）`,
  '',
  `端点：${sanitize(baseUrl) || '(未配置)'}`,
  `模型：${sanitize(model) || '(取 /models 首个)'}`,
  '',
  '| 步骤 | 结果 | 耗时 | 说明 |',
  '|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.name} | ${statusMark[r.status]} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.detail || '—'} |`,
  ),
  '',
  `**总结论：${conclusion}**`,
  '',
];

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join('\n'));
console.log(`报告已生成：${sanitize(reportPath)}`);
console.log(`总结论：${allPass ? (hasSkipOnly ? 'SKIP' : 'PASS') : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
