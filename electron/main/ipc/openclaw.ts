/**
 * @domain ipc
 * @purpose OpenClaw 安装/工作区/进程控制通道。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { existsSync, cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { GatewayManager } from '../gateway/manager';
import { getOpenClawStatus, getOpenClawDir, getOpenClawConfigDir, getOpenClawSkillsDir, ensureDir } from '../utils/paths';
import { getOpenClawCliCommand } from '../utils/openclaw-cli';
import { logger } from '../utils/logger';

function registerOpenClawHandlers(gatewayManager: GatewayManager): void {
  // Keep reload-first for feishu to avoid restart storms when channel auth/network is flaky.
  // GatewayManager.reload() already falls back to restart when reload is unhealthy.
  const forceRestartChannels = new Set(['dingtalk', 'wecom', 'whatsapp']);

  const scheduleGatewayChannelRestart = (reason: string): void => {
    if (gatewayManager.getStatus().state !== 'stopped') {
      logger.info(`Scheduling Gateway restart after ${reason}`);
      gatewayManager.debouncedRestart();
    } else {
      logger.info(`Gateway is stopped; skip immediate restart after ${reason}`);
    }
  };

  const scheduleGatewayChannelSaveRefresh = (channelType: string, reason: string): void => {
    if (gatewayManager.getStatus().state === 'stopped') {
      logger.info(`Gateway is stopped; skip immediate refresh after ${reason}`);
      return;
    }
    if (forceRestartChannels.has(channelType)) {
      logger.info(`Scheduling Gateway restart after ${reason}`);
      gatewayManager.debouncedRestart();
      return;
    }
    logger.info(`Scheduling Gateway reload after ${reason}`);
    gatewayManager.debouncedReload();
  };

  // ── Generic plugin installer with version-aware upgrades ─────────

  function readPluginVersion(pkgJsonPath: string): string | null {
    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? null;
    } catch {
      return null;
    }
  }

  function ensurePluginInstalled(
    pluginDirName: string,
    candidateSources: string[],
    pluginLabel: string,
  ): { installed: boolean; warning?: string } {
    const targetDir = join(homedir(), '.openclaw', 'extensions', pluginDirName);
    const targetManifest = join(targetDir, 'openclaw.plugin.json');
    const targetPkgJson = join(targetDir, 'package.json');

    const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));

    // If already installed, check whether an upgrade is available
    if (existsSync(targetManifest)) {
      if (!sourceDir) return { installed: true };
      const installedVersion = readPluginVersion(targetPkgJson);
      const sourceVersion = readPluginVersion(join(sourceDir, 'package.json'));
      if (!sourceVersion || !installedVersion || sourceVersion === installedVersion) {
        return { installed: true };
      }
      logger.info(`[plugin] Upgrading ${pluginLabel} plugin: ${installedVersion} → ${sourceVersion}`);
    }

    if (!sourceDir) {
      logger.warn(`Bundled ${pluginLabel} plugin mirror not found in candidate paths`, { candidateSources });
      return {
        installed: false,
        warning: `Bundled ${pluginLabel} plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
      };
    }

    try {
      mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

      if (!existsSync(join(targetDir, 'openclaw.plugin.json'))) {
        return { installed: false, warning: `Failed to install ${pluginLabel} plugin mirror (manifest missing).` };
      }

      logger.info(`Installed ${pluginLabel} plugin from bundled mirror: ${sourceDir}`);
      return { installed: true };
    } catch (error) {
      logger.warn(`Failed to install ${pluginLabel} plugin from bundled mirror:`, error);
      return {
        installed: false,
        warning: `Failed to install bundled ${pluginLabel} plugin mirror`,
      };
    }
  }

  function buildCandidateSources(pluginDirName: string): string[] {
    return app.isPackaged
      ? [
        join(process.resourcesPath, 'openclaw-plugins', pluginDirName),
        join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginDirName),
        join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginDirName),
      ]
      : [
        join(app.getAppPath(), 'build', 'openclaw-plugins', pluginDirName),
        join(process.cwd(), 'build', 'openclaw-plugins', pluginDirName),
        join(__dirname, '../../build/openclaw-plugins', pluginDirName),
      ];
  }

  function ensureDingTalkPluginInstalled(): { installed: boolean; warning?: string } {
    return ensurePluginInstalled('dingtalk', buildCandidateSources('dingtalk'), 'DingTalk');
  }

  function ensureWeComPluginInstalled(): { installed: boolean; warning?: string } {
    return ensurePluginInstalled('wecom', buildCandidateSources('wecom'), 'WeCom');
  }

  function ensureFeishuPluginInstalled(): { installed: boolean; warning?: string } {
    return ensurePluginInstalled(
      'feishu-openclaw-plugin',
      buildCandidateSources('feishu-openclaw-plugin'),
      'Feishu',
    );
  }

  function ensureQQBotPluginInstalled(): { installed: boolean; warning?: string } {
    return ensurePluginInstalled('qqbot', buildCandidateSources('qqbot'), 'QQ Bot');
  }

  // Get OpenClaw package status
  ipcMain.handle('openclaw:status', () => {
    const status = getOpenClawStatus();
    logger.info('openclaw:status IPC called', status);
    return status;
  });

  // Check if OpenClaw is ready (package present)
  ipcMain.handle('openclaw:isReady', () => {
    const status = getOpenClawStatus();
    return status.packageExists;
  });

  // Get the resolved OpenClaw directory path (for diagnostics)
  ipcMain.handle('openclaw:getDir', () => {
    return getOpenClawDir();
  });

  // Get the OpenClaw config directory (~/.openclaw)
  ipcMain.handle('openclaw:getConfigDir', () => {
    return getOpenClawConfigDir();
  });

  // Get the OpenClaw skills directory (~/.openclaw/skills)
  ipcMain.handle('openclaw:getSkillsDir', () => {
    const dir = getOpenClawSkillsDir();
    ensureDir(dir);
    return dir;
  });

  // Get a shell command to run OpenClaw CLI without modifying PATH
  ipcMain.handle('openclaw:getCliCommand', () => {
    try {
      const status = getOpenClawStatus();
      if (!status.packageExists) {
        return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
      }
      if (!existsSync(status.entryPath)) {
        return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
      }
      return { success: true, command: getOpenClawCliCommand() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });


  // ==================== Channel Configuration Handlers ====================

  // Save channel configuration
  ipcMain.handle('channel:saveConfig', async (_, channelType: string, config: Record<string, unknown>) => {
    try {
      logger.info('channel:saveConfig', { channelType, keys: Object.keys(config || {}) });
      if (channelType === 'dingtalk') {
        const installResult = await ensureDingTalkPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'DingTalk plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        scheduleGatewayChannelSaveRefresh(channelType, `channel:saveConfig (${channelType})`);
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      if (channelType === 'wecom') {
        const installResult = await ensureWeComPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'WeCom plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        scheduleGatewayChannelSaveRefresh(channelType, `channel:saveConfig (${channelType})`);
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      if (channelType === 'qqbot') {
        const installResult = await ensureQQBotPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'QQ Bot plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        scheduleGatewayChannelSaveRefresh(channelType, `channel:saveConfig (${channelType})`);
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      if (channelType === 'feishu') {
        const installResult = await ensureFeishuPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'Feishu plugin install failed',
          };
        }
        await saveChannelConfig(channelType, config);
        scheduleGatewayChannelSaveRefresh(channelType, `channel:saveConfig (${channelType})`);
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      await saveChannelConfig(channelType, config);
      scheduleGatewayChannelSaveRefresh(channelType, `channel:saveConfig (${channelType})`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to save channel config', { scope: 'channel.saveConfig' }, error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel configuration
  ipcMain.handle('channel:getConfig', async (_, channelType: string) => {
    try {
      const config = await getChannelConfig(channelType);
      return { success: true, config };
    } catch (error) {
      logger.error('Failed to get channel config', { scope: 'channel.getConfig' }, error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel form values (reverse-transformed for UI pre-fill)
  ipcMain.handle('channel:getFormValues', async (_, channelType: string) => {
    try {
      const values = await getChannelFormValues(channelType);
      return { success: true, values };
    } catch (error) {
      logger.error('Failed to get channel form values', { scope: 'channel.getFormValues' }, error);
      return { success: false, error: String(error) };
    }
  });

  // Delete channel configuration
  ipcMain.handle('channel:deleteConfig', async (_, channelType: string) => {
    try {
      await deleteChannelConfig(channelType);
      scheduleGatewayChannelRestart(`channel:deleteConfig (${channelType})`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to delete channel config', { scope: 'channel.deleteConfig' }, error);
      return { success: false, error: String(error) };
    }
  });

  // List configured channels
  ipcMain.handle('channel:listConfigured', async () => {
    try {
      const channels = await listConfiguredChannels();
      return { success: true, channels };
    } catch (error) {
      logger.error('Failed to list channels', { scope: 'channel.list' }, error);
      return { success: false, error: String(error) };
    }
  });

  // Enable or disable a channel
  ipcMain.handle('channel:setEnabled', async (_, channelType: string, enabled: boolean) => {
    try {
      await setChannelEnabled(channelType, enabled);
      scheduleGatewayChannelRestart(`channel:setEnabled (${channelType}, enabled=${enabled})`);
      return { success: true };
    } catch (error) {
      logger.error('Failed to set channel enabled', { scope: 'channel.setEnabled' }, error);
      return { success: false, error: String(error) };
    }
  });

  // Validate channel configuration
  ipcMain.handle('channel:validate', async (_, channelType: string) => {
    try {
      const result = await validateChannelConfig(channelType);
      return { success: true, ...result };
    } catch (error) {
      logger.error('Failed to validate channel', { scope: 'channel.validate' }, error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });

  // Validate channel credentials by calling actual service APIs (before saving)
  ipcMain.handle('channel:validateCredentials', async (_, channelType: string, config: Record<string, string>) => {
    try {
      const result = await validateChannelCredentials(channelType, config);
      return { success: true, ...result };
    } catch (error) {
      logger.error('Failed to validate channel credentials', { scope: 'channel.validateCredentials' }, error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });
}

/**
 * WhatsApp Login Handlers
 */
