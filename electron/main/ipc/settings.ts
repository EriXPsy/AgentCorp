/**
 * @domain ipc
 * @purpose 应用设置读写通道（渲染层可写键白名单净化）。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { GatewayManager } from '../gateway/manager';
import { getAllSettings, getSetting, resetSettings, setSetting, type AppSettings } from '../utils/store';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import { getRecentTokenUsageHistory } from '../utils/token-usage';

function registerSettingsHandlers(gatewayManager: GatewayManager): void {
  const handleProxySettingsChange = async () => {
    const settings = await getAllSettings();
    await applyProxySettings(settings);
    if (gatewayManager.getStatus().state === 'running') {
      await gatewayManager.restart();
    }
  };

  ipcMain.handle('settings:get', async (_, key: keyof AppSettings) => {
    const value = await getSetting(key);
    return sanitizeRendererSetting(key, value);
  });

  ipcMain.handle('settings:getAll', async () => {
    return sanitizeRendererSettings(await getAllSettings());
  });

  ipcMain.handle('settings:set', async (_, key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => {
    await setSetting(key, value as never);

    if (
      key === 'proxyEnabled' ||
      key === 'proxyServer' ||
      key === 'proxyHttpServer' ||
      key === 'proxyHttpsServer' ||
      key === 'proxyAllServer' ||
      key === 'proxyBypassRules'
    ) {
      await handleProxySettingsChange();
    }
    if (key === 'launchAtStartup') {
      await syncLaunchAtStartupSettingFromStore();
    }

    return { success: true };
  });

  ipcMain.handle('settings:setMany', async (_, patch: Partial<AppSettings>) => {
    const entries = Object.entries(patch) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>;
    for (const [key, value] of entries) {
      await setSetting(key, value as never);
    }

    if (entries.some(([key]) =>
      key === 'proxyEnabled' ||
      key === 'proxyServer' ||
      key === 'proxyHttpServer' ||
      key === 'proxyHttpsServer' ||
      key === 'proxyAllServer' ||
      key === 'proxyBypassRules'
    )) {
      await handleProxySettingsChange();
    }
    if (entries.some(([key]) => key === 'launchAtStartup')) {
      await syncLaunchAtStartupSettingFromStore();
    }

    return { success: true };
  });

  ipcMain.handle('settings:reset', async () => {
    await resetSettings();
    const settings = await getAllSettings();
    await handleProxySettingsChange();
    await syncLaunchAtStartupSettingFromStore();
    return { success: true, settings };
  });
}
function registerUsageHandlers(): void {
  ipcMain.handle('usage:recentTokenHistory', async (_, limit?: number) => {
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(Math.floor(limit), 1)
      : undefined;
    return await getRecentTokenUsageHistory(safeLimit);
  });
}
/**
 * Window control handlers (for custom title bar on Windows/Linux)
 */
