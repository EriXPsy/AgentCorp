/**
 * @domain ipc
 * @purpose 外部通道登录（WhatsApp 扫码 / Device OAuth）。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { logger } from '../utils/logger';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { deviceOAuthManager, OAuthProviderType } from '../utils/device-oauth';
import { browserOAuthManager, type BrowserOAuthProviderType } from '../utils/browser-oauth';

function registerWhatsAppHandlers(mainWindow: BrowserWindow): void {
  // Request WhatsApp QR code
  ipcMain.handle('channel:requestWhatsAppQr', async (_, accountId: string) => {
    try {
      logger.info('channel:requestWhatsAppQr', { accountId });
      await whatsAppLoginManager.start(accountId);
      return { success: true };
    } catch (error) {
      logger.error('channel:requestWhatsAppQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Cancel WhatsApp login
  ipcMain.handle('channel:cancelWhatsAppQr', async () => {
    try {
      await whatsAppLoginManager.stop();
      return { success: true };
    } catch (error) {
      logger.error('channel:cancelWhatsAppQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Check WhatsApp status (is it active?)
  // ipcMain.handle('channel:checkWhatsAppStatus', ...)

  // Forward events to renderer
  whatsAppLoginManager.on('qr', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('channel:whatsapp-qr', data);
    }
  });

  whatsAppLoginManager.on('success', (data) => {
    if (!mainWindow.isDestroyed()) {
      logger.info('whatsapp:login-success', data);
      mainWindow.webContents.send('channel:whatsapp-success', data);
    }
  });

  whatsAppLoginManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      logger.error('whatsapp:login-error', error);
      mainWindow.webContents.send('channel:whatsapp-error', error);
    }
  });
}

/**
 * Device OAuth Handlers (Code Plan)
 */
function registerDeviceOAuthHandlers(mainWindow: BrowserWindow): void {
  deviceOAuthManager.setWindow(mainWindow);
  browserOAuthManager.setWindow(mainWindow);

  // Request Provider OAuth initialization
  ipcMain.handle(
    'provider:requestOAuth',
    async (
      _,
      provider: OAuthProviderType | BrowserOAuthProviderType,
      region?: 'global' | 'cn',
      options?: { accountId?: string; label?: string },
    ) => {
      try {
        logger.info(`provider:requestOAuth for ${provider}`);
        if (provider === 'google' || provider === 'openai') {
          await browserOAuthManager.startFlow(provider, options);
        } else {
          await deviceOAuthManager.startFlow(provider, region, options);
        }
        return { success: true };
      } catch (error) {
        logger.error('provider:requestOAuth failed', error);
        return { success: false, error: String(error) };
      }
    },
  );

  // Cancel Provider OAuth
  ipcMain.handle('provider:cancelOAuth', async () => {
    try {
      await deviceOAuthManager.stopFlow();
      await browserOAuthManager.stopFlow();
      return { success: true };
    } catch (error) {
      logger.error('provider:cancelOAuth failed', error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Provider-related IPC handlers
 */
