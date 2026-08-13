import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * SP-15：GOAI 多 Agent 闭环 Demo 端到端验证 + 截图。
 *
 * 流程：
 *  1. 打开 web 预览 Demo 页（/demo.html，vite web config 监听 5174）。
 *  2. 点击「运行闭环」按钮，触发 boss → recruiter → evaluator → boss 闭环。
 *  3. 等待闭环结果渲染（老板拍板 action 大写：HIRE / OBSERVE / REJECT / ROLLBACK）。
 *  4. 主动对整页截图，落盘到 docs/artifacts/goai-demo-screenshot.png。
 *
 * 说明：docs/artifacts/ 已被 .gitignore 全局忽略，PNG 由主理人 `git add -f` 入库。
 * 本脚本仅产出文件；真实浏览器运行依赖沙箱是否装有浏览器二进制。
 */

const SCREENSHOT_PATH: string = 'docs/artifacts/goai-demo-screenshot.png';

// 老板拍板 action 大写 + 中文兜底（闭环永不中断，result 必存在）。
const BOSS_DECISION_RE: RegExp =
  /(HIRE|OBSERVE|REJECT|FIRED|ROLLBACK|录用|观察|解雇|回滚)/;

test('GOAI 闭环 Demo 运行并生成截图', async ({ page }) => {
  test.setTimeout(180_000);

  // a. 进入 Demo 页面（baseURL 已在 playwright.config.ts 中设定）。
  await page.goto('/demo.html');
  await page.waitForLoadState('domcontentloaded');

  // b. 点击「运行闭环」按钮（accessible name 包含「运行闭环」）。
  const runButton = page.getByRole('button', { name: /运行闭环/ });
  await expect(runButton).toBeVisible({ timeout: 30_000 });
  await runButton.click();

  // c. 等待闭环结果渲染：老板拍板 action 大写出现即代表闭环完成。
  const decision = page.getByText(BOSS_DECISION_RE).first();
  await expect(decision).toBeVisible({ timeout: 150_000 });

  // 额外确认「闭环结果」区块已挂载，避免只捕获到零散文本。
  await expect(page.getByText('闭环结果')).toBeVisible({ timeout: 30_000 });

  // d. 主动截图（整页）。确保目标目录存在。
  const outPath = resolve(SCREENSHOT_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true });
});
