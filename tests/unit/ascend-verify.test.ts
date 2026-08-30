/**
 * tests/unit/ascend-verify.test.ts
 *
 * scripts/qa/ascend-verify.mjs 冒烟脚本的 PASS / SKIP / FAIL 回归：
 * 用 node:http 起本地 mock OpenAI 兼容服务（/models + chat/completions
 * 非流式与 SSE 流式），断言：
 *  1) 未配置端点 → 全部 SKIP，exit 0（CI 友好）；
 *  2) 配置 mock 端点 → ①②③④ 全 PASS，exit 0，报告落盘且无密钥/绝对路径泄漏；
 *  3) 端点不可达 → FAIL，exit 1。
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = join(root, 'scripts/qa/ascend-verify.mjs');
const reportPath = join(root, 'docs/artifacts/ascend-verification-report.md');

const ENV_KEYS = [
  'ASCEND_BASE_URL',
  'ASCEND_API_KEY',
  'ASCEND_MODEL',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'JUDGE_BASE_URL',
  'JUDGE_API_KEY',
  'NODE_OPTIONS',
];

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

async function runVerify(env: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await execFileAsync('node', [scriptPath], { env, cwd: root });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '' };
  }
}

/* ---------------- mock OpenAI 兼容服务 ---------------- */
let server: Server;
let mockBase = '';
let judgeBase = '';

function handleChatCompletions(body: string, res: import('node:http').ServerResponse) {
  let parsed: { stream?: boolean } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    /* ignore */
  }
  if (parsed.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"ng"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
    }),
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handleChatCompletions(body, res));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${port}/v1`;
  judgeBase = mockBase;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('ascend-verify 冒烟脚本', () => {
  it('未配置端点：全部 SKIP，exit 0', async () => {
    const { code, stdout } = await runVerify(cleanEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('[SKIP]');
    expect(stdout).toContain('总结论：SKIP');
  }, 30_000);

  it('配置 mock 端点：四步全 PASS，exit 0，报告脱敏', async () => {
    const secret = 'mock-secret-key-for-ascend-verify';
    const { code, stdout } = await runVerify(
      cleanEnv({
        ASCEND_BASE_URL: mockBase,
        ASCEND_API_KEY: secret,
        JUDGE_BASE_URL: judgeBase,
        JUDGE_API_KEY: secret,
      }),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('总结论：PASS');
    expect(stdout).not.toContain('[FAIL]');

    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('✅ PASS');
    // 报告不得泄漏密钥 / 本机绝对路径
    expect(report).not.toContain(secret);
    expect(report).not.toContain(root);
  }, 30_000);

  it('端点不可达：FAIL，exit 1', async () => {
    const { code, stdout } = await runVerify(
      cleanEnv({ ASCEND_BASE_URL: 'http://127.0.0.1:1/v1' }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain('[FAIL]');
    expect(stdout).toContain('总结论：FAIL');
  }, 30_000);
});
