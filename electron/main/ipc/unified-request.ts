/**
 * @domain ipc
 * @purpose 统一请求协议分发：渲染层单一 invoke 入口的路由/鉴权/错误映射。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { GatewayManager } from '../gateway/manager';
import { getAllSettings, getSetting, resetSettings, setSetting, type AppSettings } from '../utils/store';
import { logger } from '../utils/logger';
import { getProviderConfig } from '../utils/provider-registry';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import { getRecentTokenUsageHistory } from '../utils/token-usage';
import type { AppRequest, AppErrorCode } from './ipc/request-helpers';
import { transformCronJob, type GatewayCronJob } from '../utils/cron-transform';
import { getProviderService } from '../services/providers/provider-service';
import { validateApiKeyWithProvider } from '../services/providers/provider-validation';
import { appUpdater } from './updater';

function mapAppErrorCode(error: unknown): AppErrorCode {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('permission') || msg.includes('denied') || msg.includes('forbidden')) return 'PERMISSION';
  if (msg.includes('gateway')) return 'GATEWAY';
  if (msg.includes('invalid') || msg.includes('required')) return 'VALIDATION';
  return 'INTERNAL';
}

function isProxyKey(key: keyof AppSettings): boolean {
  return (
    key === 'proxyEnabled' ||
    key === 'proxyServer' ||
    key === 'proxyHttpServer' ||
    key === 'proxyHttpsServer' ||
    key === 'proxyAllServer' ||
    key === 'proxyBypassRules'
  );
}

function isLaunchAtStartupKey(key: keyof AppSettings): boolean {
  return key === 'launchAtStartup';
}

function mapAppErrorCode(error: unknown): AppErrorCode {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('permission') || msg.includes('denied') || msg.includes('forbidden')) return 'PERMISSION';
  if (msg.includes('gateway')) return 'GATEWAY';
  if (msg.includes('invalid') || msg.includes('required')) return 'VALIDATION';
  return 'INTERNAL';
}

function isProxyKey(key: keyof AppSettings): boolean {
  return (
    key === 'proxyEnabled' ||
    key === 'proxyServer' ||
    key === 'proxyHttpServer' ||
    key === 'proxyHttpsServer' ||
    key === 'proxyAllServer' ||
    key === 'proxyBypassRules'
  );
}

function isLaunchAtStartupKey(key: keyof AppSettings): boolean {
  return key === 'launchAtStartup';
}

function sanitizeRendererSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings[K] {
  if (key === 'gatewayToken') {
    return '' as AppSettings[K];
  }
  return value;
}

function sanitizeRendererSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    gatewayToken: '',
  };
}

function registerUnifiedRequestHandlers(gatewayManager: GatewayManager): void {
  const providerService = getProviderService();
  const handleProxySettingsChange = async () => {
    const settings = await getAllSettings();
    await applyProxySettings(settings);
    if (gatewayManager.getStatus().state === 'running') {
      await gatewayManager.restart();
    }
  };

  ipcMain.handle('app:request', async (_, request: AppRequest): Promise<AppResponse> => {
    if (!request || typeof request.module !== 'string' || typeof request.action !== 'string') {
      return {
        id: request?.id,
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid app request format' },
      };
    }

    try {
      let data: unknown;
      switch (request.module) {
        case 'app': {
          if (request.action === 'version') data = app.getVersion();
          else if (request.action === 'name') data = app.getName();
          else if (request.action === 'platform') data = process.platform;
          else {
            return {
              id: request.id,
              ok: false,
              error: {
                code: 'UNSUPPORTED',
                message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
              },
            };
          }
          break;
        }
        case 'provider': {
          if (request.action === 'list') {
            data = await providerService.listLegacyProvidersWithKeyInfo();
            break;
          }
          if (request.action === 'get') {
            const payload = request.payload as { providerId?: string } | string | undefined;
            const providerId = typeof payload === 'string' ? payload : payload?.providerId;
            if (!providerId) throw new Error('Invalid provider.get payload');
            data = await providerService.getLegacyProvider(providerId);
            break;
          }
          if (request.action === 'getDefault') {
            data = await providerService.getDefaultLegacyProvider();
            break;
          }
          if (request.action === 'hasApiKey') {
            const payload = request.payload as { providerId?: string } | string | undefined;
            const providerId = typeof payload === 'string' ? payload : payload?.providerId;
            if (!providerId) throw new Error('Invalid provider.hasApiKey payload');
            data = await providerService.hasLegacyProviderApiKey(providerId);
            break;
          }
          if (request.action === 'getApiKey') {
            return {
              id: request.id,
              ok: false,
              error: {
                code: 'UNSUPPORTED',
                message: 'APP_REQUEST_UNSUPPORTED:provider.getApiKey',
              },
            };
          }
          if (request.action === 'validateKey') {
            const payload = request.payload as
              | { providerId?: string; apiKey?: string; options?: { baseUrl?: string; apiProtocol?: string } }
              | [string, string, { baseUrl?: string; apiProtocol?: string }?]
              | undefined;
            const providerId = Array.isArray(payload) ? payload[0] : payload?.providerId;
            const apiKey = Array.isArray(payload) ? payload[1] : payload?.apiKey;
            const options = Array.isArray(payload) ? payload[2] : payload?.options;
            if (!providerId || typeof apiKey !== 'string') {
              throw new Error('Invalid provider.validateKey payload');
            }

            const provider = await providerService.getLegacyProvider(providerId);
            const providerType = provider?.type || providerId;
            const registryBaseUrl = getProviderConfig(providerType)?.baseUrl;
            const resolvedBaseUrl = options?.baseUrl || provider?.baseUrl || registryBaseUrl;
            const resolvedProtocol = options?.apiProtocol || provider?.apiProtocol;
            data = await validateApiKeyWithProvider(providerType, apiKey, {
              baseUrl: resolvedBaseUrl,
              apiProtocol: resolvedProtocol,
            });
            break;
          }
          if (request.action === 'save') {
            const payload = request.payload as
              | { config?: ProviderConfig; apiKey?: string }
              | [ProviderConfig, string?]
              | undefined;
            const config = Array.isArray(payload) ? payload[0] : payload?.config;
            const apiKey = Array.isArray(payload) ? payload[1] : payload?.apiKey;
            if (!config) throw new Error('Invalid provider.save payload');

            try {
              await providerService.saveLegacyProvider(config);

              if (apiKey !== undefined) {
                const trimmedKey = apiKey.trim();
                if (trimmedKey) {
                  await providerService.setLegacyProviderApiKey(config.id, trimmedKey);
                }
              }

              try {
                await syncSavedProviderToRuntime(config, apiKey, gatewayManager);
              } catch (err) {
                logger.warn('Failed to sync openclaw provider config', { scope: 'provider.save' }, err);
              }

              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'delete') {
            const payload = request.payload as { providerId?: string } | string | undefined;
            const providerId = typeof payload === 'string' ? payload : payload?.providerId;
            if (!providerId) throw new Error('Invalid provider.delete payload');

            try {
              const existing = await providerService.getLegacyProvider(providerId);
              await providerService.deleteLegacyProvider(providerId);
              if (existing?.type) {
                try {
                  await syncDeletedProviderToRuntime(existing, providerId, gatewayManager);
                } catch (err) {
                  logger.warn('Failed to completely remove provider from OpenClaw', { scope: 'provider.delete' }, err);
                }
              }
              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'setApiKey') {
            const payload = request.payload as
              | { providerId?: string; apiKey?: string }
              | [string, string]
              | undefined;
            const providerId = Array.isArray(payload) ? payload[0] : payload?.providerId;
            const apiKey = Array.isArray(payload) ? payload[1] : payload?.apiKey;
            if (!providerId || typeof apiKey !== 'string') throw new Error('Invalid provider.setApiKey payload');

            try {
              await providerService.setLegacyProviderApiKey(providerId, apiKey);
              const provider = await providerService.getLegacyProvider(providerId);
              const providerType = provider?.type || providerId;
              const ock = getOpenClawProviderKey(providerType, providerId);
              try {
                await saveProviderKeyToOpenClaw(ock, apiKey);
              } catch (err) {
                logger.warn('Failed to save key to OpenClaw auth-profiles', { scope: 'provider.setApiKey' }, err);
              }
              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'updateWithKey') {
            const payload = request.payload as
              | { providerId?: string; updates?: Partial<ProviderConfig>; apiKey?: string }
              | [string, Partial<ProviderConfig>, string?]
              | undefined;
            const providerId = Array.isArray(payload) ? payload[0] : payload?.providerId;
            const updates = Array.isArray(payload) ? payload[1] : payload?.updates;
            const apiKey = Array.isArray(payload) ? payload[2] : payload?.apiKey;
            if (!providerId || !updates) throw new Error('Invalid provider.updateWithKey payload');

            const existing = await providerService.getLegacyProvider(providerId);
            if (!existing) {
              data = { success: false, error: 'Provider not found' };
              break;
            }

            const previousKey = await providerService.getLegacyProviderApiKey(providerId);
            const previousOck = getOpenClawProviderKey(existing.type, providerId);

            try {
              const nextConfig: ProviderConfig = {
                ...existing,
                ...updates,
                updatedAt: new Date().toISOString(),
              };
              const ock = getOpenClawProviderKey(nextConfig.type, providerId);
              await providerService.saveLegacyProvider(nextConfig);

              if (apiKey !== undefined) {
                const trimmedKey = apiKey.trim();
                if (trimmedKey) {
                  await providerService.setLegacyProviderApiKey(providerId, trimmedKey);
                  await saveProviderKeyToOpenClaw(ock, trimmedKey);
                } else {
                  await providerService.deleteLegacyProviderApiKey(providerId);
                  await syncDeletedProviderApiKeyToRuntime(nextConfig, providerId, ock);
                }
              }

              try {
                await syncUpdatedProviderToRuntime(nextConfig, apiKey, gatewayManager);
              } catch (err) {
                logger.warn('Failed to sync openclaw config after provider update', { scope: 'provider.updateWithKey' }, err);
              }

              data = { success: true };
            } catch (error) {
              try {
                await providerService.saveLegacyProvider(existing);
                if (previousKey) {
                  await providerService.setLegacyProviderApiKey(providerId, previousKey);
                  await saveProviderKeyToOpenClaw(previousOck, previousKey);
                } else {
                  await providerService.deleteLegacyProviderApiKey(providerId);
                  await syncDeletedProviderApiKeyToRuntime(existing, providerId, previousOck);
                }
              } catch (rollbackError) {
                logger.warn('Failed to rollback provider updateWithKey', { scope: 'provider.updateWithKey' }, rollbackError);
              }

              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'deleteApiKey') {
            const payload = request.payload as { providerId?: string } | string | undefined;
            const providerId = typeof payload === 'string' ? payload : payload?.providerId;
            if (!providerId) throw new Error('Invalid provider.deleteApiKey payload');
            try {
              await providerService.deleteLegacyProviderApiKey(providerId);
              const provider = await providerService.getLegacyProvider(providerId);
              const providerType = provider?.type || providerId;
              const ock = getOpenClawProviderKey(providerType, providerId);
              try {
                if (ock) {
                  await syncDeletedProviderApiKeyToRuntime(provider, providerId, ock);
                }
              } catch (err) {
                logger.warn('Failed to remove provider API key from OpenClaw auth-profiles', { scope: 'provider.deleteApiKey' }, err);
              }
              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'setDefault') {
            const payload = request.payload as { providerId?: string } | string | undefined;
            const providerId = typeof payload === 'string' ? payload : payload?.providerId;
            if (!providerId) throw new Error('Invalid provider.setDefault payload');

            try {
              await providerService.setDefaultLegacyProvider(providerId);
              const provider = await providerService.getLegacyProvider(providerId);
              if (provider) {
                try {
                  await syncDefaultProviderToRuntime(providerId, gatewayManager);
                } catch (err) {
                  logger.warn('Failed to set OpenClaw default model', { scope: 'provider.setDefault' }, err);
                }
              }

              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'update': {
          if (request.action === 'status') {
            data = appUpdater.getStatus();
            break;
          }
          if (request.action === 'version') {
            data = appUpdater.getCurrentVersion();
            break;
          }
          if (request.action === 'check') {
            try {
              await appUpdater.checkForUpdates();
              data = { success: true, status: appUpdater.getStatus() };
            } catch (error) {
              data = { success: false, error: String(error), status: appUpdater.getStatus() };
            }
            break;
          }
          if (request.action === 'download') {
            try {
              await appUpdater.downloadUpdate();
              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'install') {
            appUpdater.quitAndInstall();
            data = { success: true };
            break;
          }
          if (request.action === 'setChannel') {
            const payload = request.payload as { channel?: 'stable' | 'beta' | 'dev' } | 'stable' | 'beta' | 'dev' | undefined;
            const channel = typeof payload === 'string' ? payload : payload?.channel;
            if (!channel) throw new Error('Invalid update.setChannel payload');
            appUpdater.setChannel(channel);
            data = { success: true };
            break;
          }
          if (request.action === 'setAutoDownload') {
            const payload = request.payload as { enable?: boolean } | boolean | undefined;
            const enable = typeof payload === 'boolean' ? payload : payload?.enable;
            if (typeof enable !== 'boolean') throw new Error('Invalid update.setAutoDownload payload');
            appUpdater.setAutoDownload(enable);
            data = { success: true };
            break;
          }
          if (request.action === 'cancelAutoInstall') {
            appUpdater.cancelAutoInstall();
            data = { success: true };
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'cron': {
          if (request.action === 'list') {
            const result = await gatewayManager.rpc('cron.list', { includeDisabled: true });
            const jobs = (result as { jobs?: GatewayCronJob[] })?.jobs ?? [];
            data = jobs.map(transformCronJob);
            break;
          }
          if (request.action === 'create') {
            type CronCreateInput = { name: string; message: string; schedule: string; enabled?: boolean };
            const payload = request.payload as
              | { input?: CronCreateInput }
              | [CronCreateInput]
              | CronCreateInput
              | undefined;
            let input: CronCreateInput | undefined;
            if (Array.isArray(payload)) {
              input = payload[0];
            } else if (payload && typeof payload === 'object' && 'input' in payload) {
              input = payload.input;
            } else {
              input = payload as CronCreateInput | undefined;
            }
            if (!input) throw new Error('Invalid cron.create payload');
            const gatewayInput = {
              name: input.name,
              schedule: { kind: 'cron', expr: input.schedule },
              payload: { kind: 'agentTurn', message: input.message },
              enabled: input.enabled ?? true,
              wakeMode: 'next-heartbeat',
              sessionTarget: 'isolated',
              delivery: { mode: 'none' },
            };
            const created = await gatewayManager.rpc('cron.add', gatewayInput);
            data = created && typeof created === 'object' ? transformCronJob(created as GatewayCronJob) : created;
            break;
          }
          if (request.action === 'update') {
            const payload = request.payload as
              | { id?: string; input?: Record<string, unknown> }
              | [string, Record<string, unknown>]
              | undefined;
            const id = Array.isArray(payload) ? payload[0] : payload?.id;
            const input = Array.isArray(payload) ? payload[1] : payload?.input;
            if (!id || !input) throw new Error('Invalid cron.update payload');
            const patch = { ...input };
            if (typeof patch.schedule === 'string') patch.schedule = { kind: 'cron', expr: patch.schedule };
            if (typeof patch.message === 'string') {
              patch.payload = { kind: 'agentTurn', message: patch.message };
              delete patch.message;
            }
            data = await gatewayManager.rpc('cron.update', { id, patch });
            break;
          }
          if (request.action === 'delete') {
            const payload = request.payload as { id?: string } | string | undefined;
            const id = typeof payload === 'string' ? payload : payload?.id;
            if (!id) throw new Error('Invalid cron.delete payload');
            data = await gatewayManager.rpc('cron.remove', { id });
            break;
          }
          if (request.action === 'toggle') {
            const payload = request.payload as { id?: string; enabled?: boolean } | [string, boolean] | undefined;
            const id = Array.isArray(payload) ? payload[0] : payload?.id;
            const enabled = Array.isArray(payload) ? payload[1] : payload?.enabled;
            if (!id || typeof enabled !== 'boolean') throw new Error('Invalid cron.toggle payload');
            data = await gatewayManager.rpc('cron.update', { id, patch: { enabled } });
            break;
          }
          if (request.action === 'trigger') {
            const payload = request.payload as { id?: string } | string | undefined;
            const id = typeof payload === 'string' ? payload : payload?.id;
            if (!id) throw new Error('Invalid cron.trigger payload');
            data = await gatewayManager.rpc('cron.run', { id, mode: 'force' });
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'usage': {
          if (request.action === 'recentTokenHistory') {
            const payload = request.payload as { limit?: number } | number | undefined;
            const limit = typeof payload === 'number' ? payload : payload?.limit;
            const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
              ? Math.max(Math.floor(limit), 1)
              : undefined;
            data = await getRecentTokenUsageHistory(safeLimit);
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'settings': {
          if (request.action === 'getAll') {
            data = sanitizeRendererSettings(await getAllSettings());
            break;
          }
          if (request.action === 'get') {
            const payload = request.payload as { key?: keyof AppSettings } | [keyof AppSettings] | undefined;
            const key = Array.isArray(payload) ? payload[0] : payload?.key;
            if (!key) throw new Error('Invalid settings.get payload');
            data = sanitizeRendererSetting(key, await getSetting(key));
            break;
          }
          if (request.action === 'set') {
            const payload = request.payload as
              | { key?: keyof AppSettings; value?: AppSettings[keyof AppSettings] }
              | [keyof AppSettings, AppSettings[keyof AppSettings]]
              | undefined;
            const key = Array.isArray(payload) ? payload[0] : payload?.key;
            const value = Array.isArray(payload) ? payload[1] : payload?.value;
            if (!key) throw new Error('Invalid settings.set payload');
            await setSetting(key, value as never);
            if (isProxyKey(key)) {
              await handleProxySettingsChange();
            }
            if (isLaunchAtStartupKey(key)) {
              await syncLaunchAtStartupSettingFromStore();
            }
            data = { success: true };
            break;
          }
          if (request.action === 'setMany') {
            const patch = (request.payload ?? {}) as Partial<AppSettings>;
            const entries = Object.entries(patch) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>;
            for (const [key, value] of entries) {
              await setSetting(key, value as never);
            }
            if (entries.some(([key]) => isProxyKey(key))) {
              await handleProxySettingsChange();
            }
            if (entries.some(([key]) => isLaunchAtStartupKey(key))) {
              await syncLaunchAtStartupSettingFromStore();
            }
            data = { success: true };
            break;
          }
          if (request.action === 'reset') {
            await resetSettings();
            const settings = await getAllSettings();
            await handleProxySettingsChange();
            await syncLaunchAtStartupSettingFromStore();
            data = { success: true, settings };
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        default:
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
      }

      return { id: request.id, ok: true, data };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: mapAppErrorCode(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

/**
 * Skill config IPC handlers
 * Direct read/write to ~/.openclaw/openclaw.json (bypasses Gateway RPC)
 */
