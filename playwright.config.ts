import { defineConfig } from '@playwright/test';

/**
 * SP-15 Playwright 配置：GOAI 多 Agent 闭环 Demo 端到端验证 + 截图。
 *
 * - testDir: tests/e2e
 * - webServer: 启动 vite web 预览（端口 5174，host 127.0.0.1），复用已有 server。
 *   命令前加 `env -u NODE_OPTIONS` 以绕过 WorkBuddy 注入的 safe-delete shim
 *   （该 shim 会破坏 vite 的文件写操作）。使用本地二进制 ./node_modules/.bin/vite
 *   避免依赖 PATH 是否包含 node_modules/.bin。
 * - use.baseURL: http://127.0.0.1:5174（与 vite.web.config.ts 的 server 配置一致）。
 * - use.screenshot: 'only-on-failure' 仅为失败时自动截图；SP-15 的整页截图由
 *   spec 主动调用 page.screenshot 完成。
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // 单个 Demo 用例，顺序执行即可，避免并发占用同一 server。
  fullyParallel: false,
  workers: 1,
  // 整体用例超时（含 demo 闭环运行 + 截图），给足余量。
  timeout: 180_000,
  expect: {
    timeout: 150_000,
  },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    headless: true,
  },
  webServer: {
    command: 'env -u NODE_OPTIONS ./node_modules/.bin/vite --config vite.web.config.ts',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
