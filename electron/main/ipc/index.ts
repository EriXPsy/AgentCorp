/**
 * @domain ipc
 * @purpose IPC 通道注册装配层：把各业务域注册器按原顺序装配进 ipcMain。
 * @behaviors registerIpcHandlers 依原序调用各域注册器（顺序即语义，同 channel 重复注册会 throw）
 * @dive contracts: preload/index.ts 暴露面 · details: ./ 下各域文件
 */
import { registerAppHandlers, registerClawHubHandlers, registerDialogHandlers, registerShellHandlers, registerTaskNotifyHandlers, registerWindowHandlers } from './app-window';
import { registerDeviceOAuthHandlers, registerWhatsAppHandlers } from './channels';
import { registerDeliverableHandlers, registerFileHandlers } from './files';
import { registerGatewayHandlers } from './gateway';
import { registerHostApiProxyHandlers } from './host-api-proxy';
import { registerOpenClawHandlers } from './openclaw';
import { registerProviderHandlers } from './providers';
import { registerSessionHandlers, registerWorkspaceHandlers } from './sessions-workspace';
import { registerSettingsHandlers, registerUsageHandlers } from './settings';
import type { AppErrorCode } from '../request-helpers';
import { registerCronHandlers, registerLogHandlers, registerSkillConfigHandlers, registerUvHandlers } from './skill-cron';
import { registerUnifiedRequestHandlers } from './unified-request';

type AppResponse = {
  id?: string;
  ok: boolean;
  data?: unknown;
  error?: {
    code: AppErrorCode;
    message: string;
    details?: unknown;
  };
};

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(
  gatewayManager: GatewayManager,
  clawHubService: ClawHubService,
  mainWindow: BrowserWindow,
  hostApiSessionToken: string,
): void {
  // Unified request protocol (non-breaking: legacy channels remain available)
  registerUnifiedRequestHandlers(gatewayManager);

  // Host API proxy handlers
  registerHostApiProxyHandlers(hostApiSessionToken);

  // Gateway handlers
  registerGatewayHandlers(gatewayManager, mainWindow);

  // ClawHub handlers
  registerClawHubHandlers(clawHubService);

  // OpenClaw handlers
  registerOpenClawHandlers(gatewayManager);

  // Provider handlers
  registerProviderHandlers(gatewayManager);

  // Shell handlers
  registerShellHandlers();

  // 任务交付文件落盘 handlers
  registerDeliverableHandlers();

  // 任务终态系统通知 handler（点击通知跳回看板对应任务）
  registerTaskNotifyHandlers(mainWindow);

  // Dialog handlers
  registerDialogHandlers();

  // Session handlers
  registerSessionHandlers();

  // App handlers
  registerAppHandlers();

  // Settings handlers
  registerSettingsHandlers(gatewayManager);

  // UV handlers
  registerUvHandlers();

  // Log handlers (for UI to read gateway/app logs)
  registerLogHandlers();

  // Usage handlers
  registerUsageHandlers();

  // Skill config handlers (direct file access, no Gateway RPC)
  registerSkillConfigHandlers();

  // Cron task handlers (proxy to Gateway RPC)
  registerCronHandlers(gatewayManager);

  // Window control handlers (for custom title bar on Windows/Linux)
  registerWindowHandlers(mainWindow);

  // WhatsApp handlers
  registerWhatsAppHandlers(mainWindow);

  // Device OAuth handlers (Code Plan)
  registerDeviceOAuthHandlers(mainWindow);

  // File staging handlers (upload/send separation)
  registerFileHandlers();

  // Workspace handlers
  registerWorkspaceHandlers();
}

