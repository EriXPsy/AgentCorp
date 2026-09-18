/**
 * tests/unit/api-ping-route.test.ts
 * api/ping.ts 诊断路由回归：
 * - 编译产物为 CJS、无顶层 ESM import、仅一处 require（动态探测核心）→ 零静态依赖
 * - 无参 → 200 { ok:true, node, cwd, hasKey }
 * - ?probe=core → 200 { ok:true, coreLoaded:true }（req.url 与 req.query 两条取值路径都覆盖）
 * - 核心缺失时 → 200 { ok:false, code:'MODULE_NOT_FOUND' }（不抛错、仍可读）
 *
 * 目的：线上 /api/llm/chat 若仍失败，靠本路由一次请求即可分辨
 * 「函数管线本身没起来」还是「共享核心没被打进产物」。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tscBin = resolve(rootDir, 'node_modules/typescript/bin/tsc');
const apiTsconfig = resolve(rootDir, 'api/tsconfig.json');

interface ProbeReq {
  method?: string;
  url?: string;
  query?: Record<string, string | string[]>;
}

interface Captured {
  status: number;
  payload: Record<string, unknown>;
}

type ProbeHandler = (
  req: ProbeReq,
  res: { status(code: number): unknown; json(payload: unknown): void },
) => Promise<void>;

function makeRes(): { res: { status(code: number): unknown; json(payload: unknown): void }; captured: Captured } {
  const captured: Captured = { status: 0, payload: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.payload = payload as Record<string, unknown>;
    },
  };
  return { res, captured };
}

function compileApi(): { pingJs: string } {
  const outDir = mkdtempSync(join(tmpdir(), 'agentcorp-vercel-ping-'));
  execFileSync(process.execPath, [tscBin, '-p', apiTsconfig, '--outDir', outDir], {
    cwd: rootDir,
    stdio: 'pipe',
  });
  return { pingJs: join(outDir, 'ping.js') };
}

function loadHandler(pingJs: string): ProbeHandler {
  const mod = nodeRequire(pingJs) as { default?: ProbeHandler };
  const handler = mod.default ?? (mod as unknown as ProbeHandler);
  expect(typeof handler).toBe('function');
  return handler;
}

describe('api/ping 诊断路由', () => {
  it('编译产物为 CJS 且零静态依赖（仅一处 require 动态探测核心）', () => {
    const { pingJs } = compileApi();
    expect(existsSync(pingJs)).toBe(true);
    const code = readFileSync(pingJs, 'utf8');
    expect(code).toMatch(/exports\.default/);
    expect(code).not.toMatch(/^\s*import\s/m);
    const requires = code.match(/require\(([^)]*)\)/g) ?? [];
    expect(requires).toHaveLength(1);
    expect(requires[0]).toContain('_llm-core');
  });

  it('无参 → 200 { ok:true, node, cwd, hasKey }（req.query 缺失时也能工作）', async () => {
    const { pingJs } = compileApi();
    const handler = loadHandler(pingJs);
    const reqs: ProbeReq[] = [
      { method: 'GET', url: '/api/ping' },
      { method: 'GET', url: '/api/ping?x=1', query: {} },
    ];
    for (const req of reqs) {
      const { res, captured } = makeRes();
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.payload.ok).toBe(true);
      expect(String(captured.payload.node)).toMatch(/^v\d+\./);
      expect(typeof captured.payload.cwd).toBe('string');
      expect(typeof captured.payload.hasKey).toBe('boolean');
    }
  });

  it('?probe=core → 200 { ok:true, coreLoaded:true }（req.url 与 req.query 均覆盖）', async () => {
    const { pingJs } = compileApi();
    const handler = loadHandler(pingJs);

    const viaUrl = makeRes();
    await handler({ method: 'GET', url: '/api/ping?probe=core' }, viaUrl.res);
    expect(viaUrl.captured.status).toBe(200);
    expect(viaUrl.captured.payload).toMatchObject({ ok: true, coreLoaded: true });

    const viaQuery = makeRes();
    await handler({ method: 'GET', url: '/api/ping', query: { probe: 'core' } }, viaQuery.res);
    expect(viaQuery.captured.payload).toMatchObject({ ok: true, coreLoaded: true });
  });

  it('核心缺失时 → 200 { ok:false, code:MODULE_NOT_FOUND }（不抛错、仍可读）', async () => {
    const { pingJs } = compileApi();
    const lonelyDir = mkdtempSync(join(tmpdir(), 'agentcorp-vercel-ping-lonely-'));
    const lonelyPing = join(lonelyDir, 'ping.js');
    copyFileSync(pingJs, lonelyPing); // 只带走 ping.js，不带 _llm-core.js

    const handler = loadHandler(lonelyPing);
    const { res, captured } = makeRes();
    await handler({ method: 'GET', url: '/api/ping?probe=core' }, res);
    expect(captured.status).toBe(200);
    expect(captured.payload.ok).toBe(false);
    expect(captured.payload.code).toBe('MODULE_NOT_FOUND');
  });
});
