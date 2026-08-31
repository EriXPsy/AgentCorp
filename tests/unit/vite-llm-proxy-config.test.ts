/**
 * 回归测试：Electron dev 的 vite.config.ts 必须注册 /api/llm/chat 代理插件。
 *
 * 背景：该插件曾只注册在 vite.config.web.ts（Web 预览），Electron dev 模式下
 * 渲染进程 fetch('/api/llm/chat') 无中间件处理 → 404 → 团队任务真实执行
 * 全部失败且不会自动恢复。此用例锁定配置，防止回归。
 */
import { describe, it, expect } from "vitest";
import configExport from "../../vite.config";

describe("vite electron 配置的 LLM 代理", () => {
  it("注册了 agentcorp-llm-proxy 插件（/api/llm/chat 不 404）", async () => {
    const fn = configExport as (env: {
      command: "serve" | "build";
      mode: string;
    }) => Promise<{ plugins?: unknown[] }> | { plugins?: unknown[] };
    const resolved = await fn({ command: "serve", mode: "development" });
    const plugins = (resolved.plugins ?? [])
      .flat(Number.POSITIVE_INFINITY)
      .filter(Boolean) as Array<{ name?: string }>;
    const names = plugins.map((p) => p?.name);
    expect(names).toContain("agentcorp-llm-proxy");
  });
});

describe("vite web 预览配置的 LLM 代理", () => {
  it("vite.web.config.ts 同样注册 agentcorp-llm-proxy（双入口 web 预览真实执行不 404）", async () => {
    const webConfigExport = (await import("../../vite.web.config")).default;
    const fn = webConfigExport as (env: {
      command: "serve" | "build";
      mode: string;
    }) => Promise<{ plugins?: unknown[] }> | { plugins?: unknown[] };
    const resolved = await fn({ command: "serve", mode: "development" });
    const plugins = (resolved.plugins ?? [])
      .flat(Number.POSITIVE_INFINITY)
      .filter(Boolean) as Array<{ name?: string }>;
    const names = plugins.map((p) => p?.name);
    expect(names).toContain("agentcorp-llm-proxy");
  });
});
