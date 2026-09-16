/**
 * @domain ipc
 * @purpose shell/对话框/app 信息/任务通知/窗口控制通道。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { ClawHubService, ClawHubSearchParams, ClawHubInstallParams, ClawHubUninstallParams } from '../gateway/clawhub';
import { getOpenClawStatus, getOpenClawDir, getOpenClawConfigDir, getOpenClawSkillsDir, ensureDir } from '../utils/paths';
import { allowedOpenRoots, isPathAllowed, OPEN_PATH_DENIED } from '../utils/path-whitelist';
import { logger } from '../utils/logger';
import { saveTaskDeliverables, zipTaskDeliverables, findHtmlDeliverable, listTaskDeliverables } from '../utils/deliverables';
import { showTaskNotification } from '../utils/task-notify';

function registerShellHandlers(): void {
  // Open external URL (restricted to safe schemes)
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
      logger.warn('Blocked shell.openExternal for disallowed URL', { scope: 'shell.openExternal', url });
      return;
    }
    await shell.openExternal(url);
  });

  // 路径白名单：只允许打开应用自有目录（~/.openclaw 交付/附件、userData 日志）。
  // 防「agent 输出的链接诱导用户点开 .command/.app → 本地命令执行」。
  const openRoots = () => allowedOpenRoots(getOpenClawConfigDir(), app.getPath('userData'));

  // Open path in file explorer
  ipcMain.handle('shell:showItemInFolder', async (_, path: string) => {
    if (!isPathAllowed(path, openRoots())) {
      logger.warn('Blocked shell.showItemInFolder for path outside allowed roots', { scope: 'shell.showItemInFolder', path });
      return;
    }
    shell.showItemInFolder(path);
  });

  // Open path
  ipcMain.handle('shell:openPath', async (_, path: string) => {
    if (!isPathAllowed(path, openRoots())) {
      logger.warn('Blocked shell.openPath for path outside allowed roots', { scope: 'shell.openPath', path });
      return OPEN_PATH_DENIED;
    }
    return await shell.openPath(path);
  });
}

/**
 * 任务交付文件落盘：编排产出的文件列表写入
 * ~/.openclaw/deliverables/<taskId>/，返回目录供 UI「打开交付目录」；
 * 打包 zip 供 UI「下载 ZIP」。
 */
function registerDeliverableHandlers(): void {
  ipcMain.handle(
    'task:saveDeliverables',
    async (_, payload: { taskId?: unknown; files?: unknown }) => {
      try {
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
        const files = Array.isArray(payload?.files) ? payload.files : [];
        if (!taskId) return { success: false as const, error: 'missing taskId' };
        const result = await saveTaskDeliverables(
          taskId,
          files as Array<{ name: string; content: string }>,
        );
        return { success: true as const, ...result };
      } catch (err) {
        logger.warn('saveDeliverables failed:', err);
        return { success: false as const, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'task:zipDeliverables',
    async (_, payload: { taskId?: unknown }) => {
      try {
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
        if (!taskId) return { success: false as const, error: 'missing taskId' };
        const result = await zipTaskDeliverables(taskId);
        return { success: true as const, ...result };
      } catch (err) {
        logger.warn('zipDeliverables failed:', err);
        return { success: false as const, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'task:listDeliverables',
    async (_, payload: { taskId?: unknown }) => {
      try {
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
        if (!taskId) return { success: false as const, error: 'missing taskId' };
        const files = await listTaskDeliverables(taskId);
        return { success: true as const, files };
      } catch (err) {
        logger.warn('listDeliverables failed:', err);
        return { success: false as const, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'task:openHtmlDeliverable',
    async (_, payload: { taskId?: unknown }) => {
      try {
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
        if (!taskId) return { success: false as const, error: 'missing taskId' };
        const htmlPath = await findHtmlDeliverable(taskId);
        if (!htmlPath) return { success: false as const, error: '该任务没有可运行的 HTML 交付文件' };
        // 用系统默认浏览器打开（shell.openPath 对 .html 的默认行为）
        const openError = await shell.openPath(htmlPath);
        if (openError) return { success: false as const, error: openError };
        return { success: true as const, htmlPath };
      } catch (err) {
        logger.warn('openHtmlDeliverable failed:', err);
        return { success: false as const, error: String(err) };
      }
    },
  );
}

/**
 * 任务终态系统通知：渲染进程在任务完成/失败时调用，
 * 点击通知聚焦主窗口并跳转 /kanban?task=<id>。
 */
function registerTaskNotifyHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(
    'task:notify',
    async (_, payload: { taskId?: unknown; title?: unknown; body?: unknown }) => {
      try {
        const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
        const title = typeof payload?.title === 'string' ? payload.title : '';
        const body = typeof payload?.body === 'string' ? payload.body : '';
        if (!taskId || !title) return { success: false as const, error: 'missing taskId/title' };
        const shown = showTaskNotification(mainWindow, { taskId, title, body });
        return { success: true as const, shown };
      } catch (err) {
        logger.warn('task:notify failed:', err);
        return { success: false as const, error: String(err) };
      }
    },
  );
}

/**
 * ClawHub-related IPC handlers
 */
function registerClawHubHandlers(clawHubService: ClawHubService): void {
  // Search skills
  ipcMain.handle('clawhub:search', async (_, params: ClawHubSearchParams) => {
    try {
      const results = await clawHubService.search(params);
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Install skill
  ipcMain.handle('clawhub:install', async (_, params: ClawHubInstallParams) => {
    try {
      await clawHubService.install(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Uninstall skill
  ipcMain.handle('clawhub:uninstall', async (_, params: ClawHubUninstallParams) => {
    try {
      await clawHubService.uninstall(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // List installed skills
  ipcMain.handle('clawhub:list', async () => {
    try {
      const results = await clawHubService.listInstalled();
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open skill readme
  ipcMain.handle('clawhub:openSkillReadme', async (_, slug: string) => {
    try {
      await clawHubService.openSkillReadme(slug);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Dialog-related IPC handlers
 */
function registerDialogHandlers(): void {
  // Show open dialog
  ipcMain.handle('dialog:open', async (_, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(options);
    return result;
  });

  // Show save dialog
  ipcMain.handle('dialog:save', async (_, options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(options);
    return result;
  });

  // Show message box
  ipcMain.handle('dialog:message', async (_, options: Electron.MessageBoxOptions) => {
    const result = await dialog.showMessageBox(options);
    return result;
  });
}

/**
 * App-related IPC handlers
 */
function registerAppHandlers(): void {
  // Get app version
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  // Get app name
  ipcMain.handle('app:name', () => {
    return app.getName();
  });

  // Get app path
  ipcMain.handle('app:getPath', (_, name: Parameters<typeof app.getPath>[0]) => {
    return app.getPath(name);
  });

  // Get platform
  ipcMain.handle('app:platform', () => {
    return process.platform;
  });

  // Quit app
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  // Relaunch app
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
}

function registerWindowHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow.isMaximized();
  });
}
