/**
 * @domain ipc
 * @purpose 供应商与密钥管理通道。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { getProviderConfig } from '../utils/provider-registry';
import { deviceOAuthManager, OAuthProviderType } from '../utils/device-oauth';
import { browserOAuthManager, type BrowserOAuthProviderType } from '../utils/browser-oauth';
import { getProviderService } from '../services/providers/provider-service';
import { validateApiKeyWithProvider } from '../services/providers/provider-validation';

function registerProviderHandlers(gatewayManager: GatewayManager): void {
  const providerService = getProviderService();
  const legacyProviderChannelsWarned = new Set<string>();
  const logLegacyProviderChannel = (channel: string): void => {
    if (legacyProviderChannelsWarned.has(channel)) return;
    legacyProviderChannelsWarned.add(channel);
    logger.warn(
      `[provider-migration] Legacy IPC channel "${channel}" is deprecated. Prefer app:request provider actions and account APIs.`,
    );
  };

  // Listen for OAuth success to automatically restart the Gateway with new tokens/configs.
  // Keep a longer debounce (8s) so provider config writes and OAuth token persistence
  // can settle before applying the process-level refresh.
  deviceOAuthManager.on('oauth:success', ({ provider, accountId }) => {
    logger.info(`[IPC] Scheduling Gateway restart after ${provider} OAuth success for ${accountId}...`);
    gatewayManager.debouncedRestart(8000);
  });
  browserOAuthManager.on('oauth:success', ({ provider, accountId }) => {
    logger.info(`[IPC] Scheduling Gateway restart after ${provider} OAuth success for ${accountId}...`);
    gatewayManager.debouncedRestart(8000);
  });

  // Get all providers with key info
  ipcMain.handle('provider:list', async () => {
    logLegacyProviderChannel('provider:list');
    return await providerService.listLegacyProvidersWithKeyInfo();
  });

  // New provider-service endpoints used by the account-based refactor.
  ipcMain.handle('provider:listVendors', async () => {
    return await providerService.listVendors();
  });

  ipcMain.handle('provider:listAccounts', async () => {
    return await providerService.listAccounts();
  });

  ipcMain.handle('provider:getAccount', async (_, accountId: string) => {
    return await providerService.getAccount(accountId);
  });

  // Get a specific provider
  ipcMain.handle('provider:get', async (_, providerId: string) => {
    logLegacyProviderChannel('provider:get');
    return await providerService.getLegacyProvider(providerId);
  });

  // Save a provider configuration
  ipcMain.handle('provider:save', async (_, config: ProviderConfig, apiKey?: string) => {
    logLegacyProviderChannel('provider:save');
    try {
      // Save the provider config
      await providerService.saveLegacyProvider(config);

      // Store the API key if provided
      if (apiKey !== undefined) {
        const trimmedKey = apiKey.trim();
        if (trimmedKey) {
          await providerService.setLegacyProviderApiKey(config.id, trimmedKey);

          // Also write to OpenClaw auth-profiles.json so the gateway can use it
          try {
            await syncProviderApiKeyToRuntime(config.type, config.id, trimmedKey);
          } catch (err) {
            logger.warn('Failed to save key to OpenClaw auth-profiles', { scope: 'provider.saveProvider.syncApiKey' }, err);
          }
        }
      }

      // Sync the provider configuration to openclaw.json so Gateway knows about it
      try {
        await syncSavedProviderToRuntime(config, apiKey, gatewayManager);
      } catch (err) {
        logger.warn('Failed to sync openclaw provider config', { scope: 'provider.saveProvider' }, err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Delete a provider
  ipcMain.handle('provider:delete', async (_, providerId: string) => {
    logLegacyProviderChannel('provider:delete');
    try {
      const existing = await providerService.getLegacyProvider(providerId);
      await providerService.deleteLegacyProvider(providerId);

      // Best-effort cleanup in OpenClaw auth profiles & openclaw.json config
      if (existing?.type) {
        try {
          await syncDeletedProviderToRuntime(existing, providerId, gatewayManager);
        } catch (err) {
          logger.warn('Failed to completely remove provider from OpenClaw', { scope: 'provider.deleteProvider' }, err);
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Update API key for a provider
  ipcMain.handle('provider:setApiKey', async (_, providerId: string, apiKey: string) => {
    logLegacyProviderChannel('provider:setApiKey');
    try {
      await providerService.setLegacyProviderApiKey(providerId, apiKey);

      // Also write to OpenClaw auth-profiles.json
      const provider = await providerService.getLegacyProvider(providerId);
      const providerType = provider?.type || providerId;
      try {
        await syncProviderApiKeyToRuntime(providerType, providerId, apiKey);
      } catch (err) {
        logger.warn('Failed to save key to OpenClaw auth-profiles', { scope: 'provider.setProviderApiKey' }, err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Atomically update provider config and API key
  ipcMain.handle(
    'provider:updateWithKey',
    async (
      _,
      providerId: string,
      updates: Partial<ProviderConfig>,
      apiKey?: string
    ) => {
      logLegacyProviderChannel('provider:updateWithKey');
      const existing = await providerService.getLegacyProvider(providerId);
      if (!existing) {
        return { success: false, error: 'Provider not found' };
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
            await syncProviderApiKeyToRuntime(nextConfig.type, providerId, trimmedKey);
          } else {
            await providerService.deleteLegacyProviderApiKey(providerId);
            await syncDeletedProviderApiKeyToRuntime(nextConfig, providerId, ock);
          }
        }

        // Sync the provider configuration to openclaw.json so Gateway knows about it
        try {
          await syncUpdatedProviderToRuntime(nextConfig, apiKey, gatewayManager);
        } catch (err) {
          logger.warn('Failed to sync openclaw config after provider update', { scope: 'provider.updateProvider' }, err);
        }

        return { success: true };
      } catch (error) {
        // Best-effort rollback to keep config/key consistent.
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
          logger.warn('Failed to rollback provider updateWithKey', { scope: 'provider.updateProvider' }, rollbackError);
        }

        return { success: false, error: String(error) };
      }
    }
  );

  // Delete API key for a provider
  ipcMain.handle('provider:deleteApiKey', async (_, providerId: string) => {
    logLegacyProviderChannel('provider:deleteApiKey');
    try {
      await providerService.deleteLegacyProviderApiKey(providerId);

      // Keep OpenClaw auth-profiles.json in sync with local key storage
      const provider = await providerService.getLegacyProvider(providerId);
      try {
        await syncDeletedProviderApiKeyToRuntime(provider, providerId);
      } catch (err) {
        logger.warn('Failed to completely remove provider from OpenClaw', { scope: 'provider.deleteProviderApiKey' }, err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Check if a provider has an API key
  ipcMain.handle('provider:hasApiKey', async (_, providerId: string) => {
    logLegacyProviderChannel('provider:hasApiKey');
    return await providerService.hasLegacyProviderApiKey(providerId);
  });

  // Get the actual API key (for internal use only - be careful!)
  ipcMain.handle('provider:getApiKey', async (_, providerId: string) => {
    logLegacyProviderChannel('provider:getApiKey');
    const hasKey = await providerService.hasLegacyProviderApiKey(providerId);
    return hasKey ? null : null;
  });

  // Set default provider and update OpenClaw default model
  ipcMain.handle('provider:setDefault', async (_, providerId: string) => {
    logLegacyProviderChannel('provider:setDefault');
    try {
      await providerService.setDefaultLegacyProvider(providerId);

      // Update OpenClaw config to use this provider's default model
      try {
        await syncDefaultProviderToRuntime(providerId, gatewayManager);
      } catch (err) {
        logger.warn('Failed to set OpenClaw default model', { scope: 'provider.setDefaultProvider' }, err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });



  // Get default provider
  ipcMain.handle('provider:getDefault', async () => {
    logLegacyProviderChannel('provider:getDefault');
    return await providerService.getDefaultLegacyProvider();
  });

  // Validate API key by making a real test request to the provider.
  // providerId can be either a stored provider ID or a provider type.
  ipcMain.handle(
    'provider:validateKey',
    async (
      _,
      providerId: string,
      apiKey: string,
      options?: { baseUrl?: string; apiProtocol?: string }
    ) => {
      logLegacyProviderChannel('provider:validateKey');
      try {
        // First try to get existing provider
        const provider = await providerService.getLegacyProvider(providerId);

        // Use provider.type if provider exists, otherwise use providerId as the type
        // This allows validation during setup when provider hasn't been saved yet
        const providerType = provider?.type || providerId;
        const registryBaseUrl = getProviderConfig(providerType)?.baseUrl;
        // Prefer caller-supplied baseUrl (live form value) over persisted config.
        // This ensures Setup/Settings validation reflects unsaved edits immediately.
        const resolvedBaseUrl = options?.baseUrl || provider?.baseUrl || registryBaseUrl;
        const resolvedProtocol = options?.apiProtocol || provider?.apiProtocol;

        logger.info('[agentcorp-validate] validating provider type', { providerType });
        return await validateApiKeyWithProvider(providerType, apiKey, {
          baseUrl: resolvedBaseUrl,
          apiProtocol: resolvedProtocol,
        });
      } catch (error) {
        logger.error('Validation error', { scope: 'provider.validate' }, error);
        return { valid: false, error: String(error) };
      }
    }
  );
}
