/**
 * @domain ipc
 * @purpose 技能配置、定时任务、uv 运行时与日志通道。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { checkUvInstalled, installUv, setupManagedPython } from '../utils/uv-setup';
import { updateSkillConfig, getSkillConfig, getAllSkillConfigs } from '../utils/skill-config';
import { transformCronJob, type GatewayCronJob } from '../utils/cron-transform';

function registerSkillConfigHandlers(): void {
  // Update skill config (apiKey and env)
  ipcMain.handle('skill:updateConfig', async (_, params: {
    skillKey: string;
    apiKey?: string;
    env?: Record<string, string>;
  }) => {
    return await updateSkillConfig(params.skillKey, {
      apiKey: params.apiKey,
      env: params.env,
    });
  });

  // Get skill config
  ipcMain.handle('skill:getConfig', async (_, skillKey: string) => {
    return await getSkillConfig(skillKey);
  });

  // Get all skill configs
  ipcMain.handle('skill:getAllConfigs', async () => {
    return await getAllSkillConfigs();
  });
}

/**
 * Cron task IPC handlers
 * Proxies cron operations to the Gateway RPC service.
 * The frontend works with plain cron expression strings, but the Gateway
 * expects CronSchedule objects ({ kind: "cron", expr: "..." }).
 * These handlers bridge the two formats.
 */
function registerCronHandlers(gatewayManager: GatewayManager): void {
  // List all cron jobs — transforms Gateway CronJob format to frontend CronJob format
  ipcMain.handle('cron:list', async () => {
    try {
      const result = await gatewayManager.rpc('cron.list', { includeDisabled: true });
      const data = result as { jobs?: GatewayCronJob[] };
      const jobs = data?.jobs ?? [];

      // Auto-repair legacy UI-created jobs that were saved without
      // delivery: { mode: 'none' }.  The Gateway auto-normalizes them
      // to delivery: { mode: 'announce' } which then fails with
      // "Channel is required" when no external channels are configured.
      for (const job of jobs) {
        const isIsolatedAgent =
          (job.sessionTarget === 'isolated' || !job.sessionTarget) &&
          job.payload?.kind === 'agentTurn';
        const needsRepair =
          isIsolatedAgent &&
          job.delivery?.mode === 'announce' &&
          !job.delivery?.channel;

        if (needsRepair) {
          try {
            await gatewayManager.rpc('cron.update', {
              id: job.id,
              patch: { delivery: { mode: 'none' } },
            });
            job.delivery = { mode: 'none' };
            // Clear stale channel-resolution error from the last run
            if (job.state?.lastError?.includes('Channel is required')) {
              job.state.lastError = undefined;
              job.state.lastStatus = 'ok';
            }
          } catch (e) {
            logger.warn('Failed to auto-repair cron job', { jobId: job.id }, e);
          }
        }
      }

      // Transform Gateway format to frontend format
      return jobs.map(transformCronJob);
    } catch (error) {
      logger.error('Failed to list cron jobs', { scope: 'cron.list' }, error);
      throw error;
    }
  });

  // Create a new cron job
  // UI-created tasks have no delivery target — results go to the AgentCorp chat page.
  // Tasks created via external channels (Feishu, Discord, etc.) are handled
  // directly by the OpenClaw Gateway and do not pass through this IPC handler.
  ipcMain.handle('cron:create', async (_, input: {
    name: string;
    message: string;
    schedule: string;
    enabled?: boolean;
  }) => {
    try {
      const gatewayInput = {
        name: input.name,
        schedule: { kind: 'cron', expr: input.schedule },
        payload: { kind: 'agentTurn', message: input.message },
        enabled: input.enabled ?? true,
        wakeMode: 'next-heartbeat',
        sessionTarget: 'isolated',
        // UI-created jobs deliver results via AgentCorp WebSocket chat events,
        // not external messaging channels.  Setting mode='none' prevents
        // the Gateway from attempting channel delivery (which would fail
        // with "Channel is required" when no channels are configured).
        delivery: { mode: 'none' },
      };
      const result = await gatewayManager.rpc('cron.add', gatewayInput);
      // Transform the returned job to frontend format
      if (result && typeof result === 'object') {
        return transformCronJob(result as GatewayCronJob);
      }
      return result;
    } catch (error) {
      logger.error('Failed to create cron job', { scope: 'cron.create' }, error);
      throw error;
    }
  });

  // Update an existing cron job
  ipcMain.handle('cron:update', async (_, id: string, input: Record<string, unknown>) => {
    try {
      // Transform schedule string to CronSchedule object if present
      const patch = { ...input };
      if (typeof patch.schedule === 'string') {
        patch.schedule = { kind: 'cron', expr: patch.schedule };
      }
      // Transform message to payload format if present
      if (typeof patch.message === 'string') {
        patch.payload = { kind: 'agentTurn', message: patch.message };
        delete patch.message;
      }
      const result = await gatewayManager.rpc('cron.update', { id, patch });
      return result;
    } catch (error) {
      logger.error('Failed to update cron job', { scope: 'cron.update' }, error);
      throw error;
    }
  });

  // Delete a cron job
  ipcMain.handle('cron:delete', async (_, id: string) => {
    try {
      const result = await gatewayManager.rpc('cron.remove', { id });
      return result;
    } catch (error) {
      logger.error('Failed to delete cron job', { scope: 'cron.delete' }, error);
      throw error;
    }
  });

  // Toggle a cron job enabled/disabled
  ipcMain.handle('cron:toggle', async (_, id: string, enabled: boolean) => {
    try {
      const result = await gatewayManager.rpc('cron.update', { id, patch: { enabled } });
      return result;
    } catch (error) {
      logger.error('Failed to toggle cron job', { scope: 'cron.toggle' }, error);
      throw error;
    }
  });

  // Trigger a cron job manually
  ipcMain.handle('cron:trigger', async (_, id: string) => {
    try {
      const result = await gatewayManager.rpc('cron.run', { id, mode: 'force' });
      return result;
    } catch (error) {
      logger.error('Failed to trigger cron job', { scope: 'cron.trigger' }, error);
      throw error;
    }
  });
}

/**
 * UV-related IPC handlers
 */
function registerUvHandlers(): void {
  // Check if uv is installed
  ipcMain.handle('uv:check', async () => {
    return await checkUvInstalled();
  });

  // Install uv and setup managed Python
  ipcMain.handle('uv:install-all', async () => {
    try {
      const isInstalled = await checkUvInstalled();
      if (!isInstalled) {
        await installUv();
      }
      // Always run python setup to ensure it exists in uv's cache
      await setupManagedPython();
      return { success: true };
    } catch (error) {
      logger.error('Failed to setup uv/python', { scope: 'uv.setup' }, error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Log-related IPC handlers
 * Allows the renderer to read application logs for diagnostics
 */
function registerLogHandlers(): void {
  // Get recent logs from memory ring buffer
  ipcMain.handle('log:getRecent', async (_, count?: number) => {
    return logger.getRecentLogs(count);
  });

  // Read log file content (last N lines)
  ipcMain.handle('log:readFile', async (_, tailLines?: number) => {
    return await logger.readLogFile(tailLines);
  });

  // Get log file path (so user can open in file explorer)
  ipcMain.handle('log:getFilePath', async () => {
    return logger.getLogFilePath();
  });

  // Get log directory path
  ipcMain.handle('log:getDir', async () => {
    return logger.getLogDir();
  });

  // List all log files
  ipcMain.handle('log:listFiles', async () => {
    return await logger.listLogFiles();
  });
}

/**
 * Gateway-related IPC handlers
 */
