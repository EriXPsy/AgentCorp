/**
 * api/ping.ts
 * 零依赖诊断路由：/api/ping
 *
 * 目的：线上 /api/llm/chat 若仍失败，用一次请求即可分辨故障层——
 * - 无参：只回自身运行时信息（Node 版本 / cwd / 是否已注入 key）。
 *   本文件**不含任何静态 import**，即使共享核心未被打进函数产物也能存活，
 *   因此「拿到 JSON 200」≈ 函数管线本身正常。
 * - ?probe=core：动态载入共享核心 api/_llm-core.ts，成功/失败分别回报
 *   coreLoaded / error，用于分辨「共享核心没被打进产物」这一类问题。
 *
 * 不引 @vercel/node：用最小结构类型声明，与 api/llm/chat.ts 风格一致。
 * 模块格式约束见 api/tsconfig.json（固定 CommonJS）。
 * 注意：本文件不得引入任何静态 import，以保证零依赖存活。
 */

interface ProbeRequest {
  method?: string;
  url?: string;
  query?: Record<string, string | string[] | undefined>;
}

interface ProbeResponse {
  status(code: number): ProbeResponse;
  json(payload: unknown): void;
}

/**
 * 解析 probe 参数：优先用 req.query，不可用时回退解析 req.url。
 * （req.query 在不同 Vercel Node runtime 版本上时有时无。）
 */
function readProbe(req: ProbeRequest): string | null {
  const fromQuery = req.query?.probe;
  if (typeof fromQuery === 'string') return fromQuery;
  if (Array.isArray(fromQuery) && fromQuery.length > 0) return fromQuery[0] ?? null;

  const url = typeof req.url === 'string' ? req.url : '';
  const match = /[?&]probe=([^&]*)/.exec(url);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

export default async function handler(req: ProbeRequest, res: ProbeResponse): Promise<void> {
  // ?probe=core —— 仅在此分支才去触碰共享核心；用动态 import 保证即使
  // 核心缺失/编译失败，本路由自身仍能返回可读的 JSON（而非函数级 500）。
  if (readProbe(req) === 'core') {
    try {
      // 注意：本文件与 _llm-core.ts 同级（都在 api/ 下），故用 './_llm-core'。
      const mod = (await import('./_llm-core')) as { handleLlmChat?: unknown };
      // 两种结果都返回 200：以「是否拿到 JSON」区分函数管线死活，
      // 以 coreLoaded 区分核心是否成功载入。
      res.status(200).json({ ok: true, coreLoaded: typeof mod.handleLlmChat === 'function' });
    } catch (err) {
      const e = err as { name?: string; message?: string; code?: string };
      res.status(200).json({ ok: false, error: e?.name, message: e?.message, code: e?.code });
    }
    return;
  }

  res.status(200).json({
    ok: true,
    node: process.version,
    cwd: process.cwd(),
    hasKey: Boolean(process.env.LLM_API_KEY || process.env.ASCEND_API_KEY),
  });
}
