import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sinkRun, replayRun } from '@/demo/observability/traceSink';
import type { ATRun } from '@/demo/agentteams-adapter';

/**
 * SP-10 Trace 落盘 / 回放实证：写入的 Run 能原样回放（node 路径用 dirOverride 隔离）。
 */
describe('Trace 落盘 / 回放（SP-10）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentcorp-traces-'));

  const run: ATRun = {
    runId: 'run-sink-1',
    teamId: 'agentcorp-core',
    taskId: 'task-1',
    status: 'completed',
    steps: [
      { phase: 'tool', agent: '评估中心', summary: '评估中心调用评委', status: 'ok', skill: 'capability_assessment' },
      { phase: 'approve', agent: '老板', summary: '老板决策：HIRE', status: 'ok', skill: 'boss_review' },
    ],
    tokenEstimate: 120,
  };

  it('sinkRun → replayRun 内容一致', async () => {
    const loc = await sinkRun(run, dir);
    expect(loc).toContain('run-sink-1');

    const back = await replayRun('run-sink-1', dir);
    expect(back).not.toBeNull();
    expect(back!.runId).toBe('run-sink-1');
    expect(back!.status).toBe('completed');
    expect(back!.steps).toEqual(run.steps);
    expect(back!.tokenEstimate).toBe(120);
  });

  it('回放不存在的 Run 返回 null（永不抛出）', async () => {
    const missing = await replayRun('run-does-not-exist', dir);
    expect(missing).toBeNull();
  });
});
