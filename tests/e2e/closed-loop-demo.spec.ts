/**
 * 闭环 Demo E2E + 截图证据
 * 起 5174 web 预览 → 打开 /demo.html → 运行闭环 → 断言结果渲染 → 截图存
 * docs/artifacts/demo-screenshot.png（演示证据）。
 * 运行：pnpm demo:shot（首次需 `corepack pnpm exec playwright install chromium`）
 */
import { test, expect } from '@playwright/test';

test('多 Agent 闭环 Demo：运行并产出结果截图', async ({ page }) => {
  await page.goto('/demo.html');
  await expect(page.getByText('AgentCorp · 多 Agent 闭环 Demo')).toBeVisible();

  await page.getByRole('button', { name: /运行 AgentTeams 闭环/ }).click();

  // 闭环结果渲染：老板拍板出现 HIRE / OBSERVE / REJECT / ROLLBACK 之一
  await expect(page.getByText(/^(HIRE|OBSERVE|REJECT|ROLLBACK)$/)).toBeVisible({ timeout: 30_000 });
  // Agent→Skill 调用链可见（Skill 真实调用证据）
  await expect(page.getByText(/→⚙ boss_review/).first()).toBeVisible();
  await expect(page.getByText(/→⚙ capability_assessment/).first()).toBeVisible();

  await page.screenshot({ path: 'docs/artifacts/demo-screenshot.png', fullPage: true });
});
