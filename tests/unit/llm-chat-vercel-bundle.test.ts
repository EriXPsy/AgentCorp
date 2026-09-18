/**
 * tests/unit/llm-chat-vercel-bundle.test.ts
 *
 * 回归：Vercel Serverless Function 的编译产物必须能被 Node 以 CommonJS 加载并执行。
 *
 * 背景（线上 500 根因）：Vercel 的 Node 构建器（@vercel/node）用 TypeScript 编译器
 * 从「入口文件所在目录」向上解析 tsconfig 来转译 api/ 下的 TS。修复前 api/ 命中
 * 根 tsconfig.json 的 `module: ESNext`，产出含 `import`/`export` 的 .js；而
 * package.json 没有 `"type": "module"`，Node 以 ESM 语义加载该文件，扩展名省略的
 * 相对导入 `'../_llm-core'` 解析失败（ERR_MODULE_NOT_FOUND / SyntaxError），
 * 模块加载期即崩溃 → GET/POST 一律 500 FUNCTION_INVOCATION_FAILED。
 *
 * 修复：新增 api/tsconfig.json 固定 `module: CommonJS`，产出 require/exports。
 * 本用例锁定该行为：按 api/tsconfig.json 把 api/ 编译到临时目录，直接 require
 * 编译产物并调用 handler，断言「缺 env 时返回 503，而不是抛错」。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '../..');
const tscBin = resolve(rootDir, 'node_modules/typescript/bin/tsc');
const apiTsconfig = resolve(rootDir, 'api/tsconfig.json');

const LLM_ENV_KEYS = [
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'ASCEND_API_KEY',
  'ASCEND_BASE_URL',
  'ASCEND_MODEL',
];

type VercelHandler = (
  req: { method?: string; body?: unknown },
  res: { status(code: number): unknown; json(payload: unknown): void },
) => Promise<void>;

interface Captured {
  status: number;
  payload: unknown;
}

function makeRes(): { res: { status(code: number): unknown; json(payload: unknown): void }; captured: Captured } {
  const captured: Captured = { status: 0, payload: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.payload = payload;
    },
  };
  return { res, captured };
}

describe('Vercel 函数编译产物（api/tsconfig.json → CommonJS）', () => {
  it('api/tsconfig.json 固定 module=CommonJS（防止回退到根 ESNext 导致线上 500）', () => {
    const cfg = JSON.parse(readFileSync(apiTsconfig, 'utf8')) as {
      compilerOptions?: { module?: string };
    };
    expect(cfg.compilerOptions?.module).toBe('CommonJS');
  });

  it('编译产物为 CJS，Node 可加载并执行：GET→405，缺 env 的 POST→503（不抛错）', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'agentcorp-vercel-api-'));
    execFileSync(process.execPath, [tscBin, '-p', apiTsconfig, '--outDir', outDir], {
      cwd: rootDir,
      stdio: 'pipe',
    });

    const compiled = join(outDir, 'llm', 'chat.js');
    expect(existsSync(compiled)).toBe(true);

    const code = readFileSync(compiled, 'utf8');
    // CJS 特征：存在 require() 与 exports.default，且没有顶层 ESM import/export
    expect(code).toMatch(/require\(/);
    expect(code).toMatch(/exports\.default/);
    expect(code).not.toMatch(/^\s*import\s+[\w{*]/m);
    expect(code).not.toMatch(/^\s*export\s/m);

    const saved = new Map<string, string | undefined>();
    for (const key of LLM_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    try {
      const mod = nodeRequire(compiled) as { default?: VercelHandler };
      const handler = mod.default ?? (mod as unknown as VercelHandler);
      expect(typeof handler).toBe('function');

      // 非 POST → 405：证明 handler 真正执行（修复前模块加载期即崩溃，GET 也 500）
      const get = makeRes();
      await handler({ method: 'GET' }, get.res);
      expect(get.captured.status).toBe(405);

      // 缺 env 的 POST → 503：优雅降级，而非模块加载/执行期抛错
      const post = makeRes();
      await handler({ method: 'POST', body: { message: 'hi' } }, post.res);
      expect(post.captured.status).toBe(503);
      expect((post.captured.payload as { error?: string }).error).toBe('llm_not_configured');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
