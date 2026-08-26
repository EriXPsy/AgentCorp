/**
 * Settings State Store
 * Manages application settings
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import i18n from '@/i18n';
import { hostApiFetch } from '@/lib/host-api';
import { resolveSupportedLanguage } from '../../shared/language';

type Theme = 'light' | 'dark' | 'system';
type UpdateChannel = 'stable' | 'beta' | 'dev';
type GlobalRiskLevel = 'standard' | 'strict' | 'permissive';

interface SettingsState {
  // General
  theme: Theme;
  accentColor: string;
  language: string;
  startMinimized: boolean;
  launchAtStartup: boolean;
  telemetryEnabled: boolean;

  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyHttpServer: string;
  proxyHttpsServer: string;
  proxyAllServer: string;
  proxyBypassRules: string;

  // Update
  updateChannel: UpdateChannel;
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;

  // UI State
  sidebarCollapsed: boolean;
  contextRailCollapsed: boolean;
  rightPanelMode: 'agent' | 'files' | 'session' | null;
  devModeUnlocked: boolean;
  remoteRpcEnabled: boolean;
  p2pSyncEnabled: boolean;

  // Identity / Brand
  brandName: string;
  brandSubtitle: string;
  brandLogoDataUrl: string | null;
  brandIconDataUrl: string | null;
  myName: string;

  // Model defaults
  defaultModel: string;
  contextLimit: number;

  // Appearance toggles
  showToolCalls: boolean;
  emojiAvatar: boolean;
  hideAvatarBg: boolean;
  minimizeToTray: boolean;

  // Team & Role Strategy
  orgTemplate: string;
  autoSpawn: boolean;
  modelInherit: boolean;
  strictIsolation: boolean;

  // Channel Advanced
  groupChatMode: string;
  groupRate: string;

  // Automation Defaults
  workerSlots: string;
  maxDailyRuns: string;
  exponentialBackoff: boolean;
  agentSelfHeal: boolean;
  suspendOnFail: boolean;
  mobileAlert: boolean;

  // Tool Permissions
  globalRiskLevel: GlobalRiskLevel;
  fileAcl: boolean;
  terminalAcl: boolean;
  networkAcl: boolean;
  channelRouteRules: string[];
  filePathAllowlist: string[];
  terminalCommandBlocklist: string[];
  customToolGrants: string[];

  // Setup
  setupComplete: boolean;
  /** 业务动线引导（雇人 → 面试 → 评估）是否已看过；与 setupComplete 的环境配置分开 */
  onboardingSeen: boolean;
  /** 新手引导弹窗是否被手动打开（不持久化；首次启动由 !onboardingSeen 自动打开） */
  guideOpen: boolean;

  // Actions
  init: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  setAccentColor: (color: string) => void;
  setLanguage: (language: string) => void;
  setStartMinimized: (value: boolean) => void;
  setLaunchAtStartup: (value: boolean) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setGatewayAutoStart: (value: boolean) => void;
  setGatewayPort: (port: number) => void;
  setProxyEnabled: (value: boolean) => void;
  setProxyServer: (value: string) => void;
  setProxyHttpServer: (value: string) => void;
  setProxyHttpsServer: (value: string) => void;
  setProxyAllServer: (value: string) => void;
  setProxyBypassRules: (value: string) => void;
  setUpdateChannel: (channel: UpdateChannel) => void;
  setAutoCheckUpdate: (value: boolean) => void;
  setAutoDownloadUpdate: (value: boolean) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setContextRailCollapsed: (value: boolean) => void;
  setRightPanelMode: (mode: 'agent' | 'files' | 'session' | null) => void;
  setDevModeUnlocked: (value: boolean) => void;
  setRemoteRpcEnabled: (value: boolean) => void;
  setP2pSyncEnabled: (value: boolean) => void;
  setBrandName: (value: string) => void;
  setBrandSubtitle: (value: string) => void;
  setBrandLogoDataUrl: (value: string | null) => void;
  setBrandIconDataUrl: (value: string | null) => void;
  setMyName: (value: string) => void;
  setDefaultModel: (value: string) => void;
  setContextLimit: (value: number) => void;
  setShowToolCalls: (value: boolean) => void;
  setEmojiAvatar: (value: boolean) => void;
  setHideAvatarBg: (value: boolean) => void;
  setMinimizeToTray: (value: boolean) => void;
  setAutoSpawn: (value: boolean) => void;
  setModelInherit: (value: boolean) => void;
  setStrictIsolation: (value: boolean) => void;
  setOrgTemplate: (value: string) => void;
  setGroupChatMode: (value: string) => void;
  setGroupRate: (value: string) => void;
  setWorkerSlots: (value: string) => void;
  setMaxDailyRuns: (value: string) => void;
  setExponentialBackoff: (value: boolean) => void;
  setAgentSelfHeal: (value: boolean) => void;
  setSuspendOnFail: (value: boolean) => void;
  setMobileAlert: (value: boolean) => void;
  setGlobalRiskLevel: (value: GlobalRiskLevel) => void;
  setFileAcl: (value: boolean) => void;
  setTerminalAcl: (value: boolean) => void;
  setNetworkAcl: (value: boolean) => void;
  addChannelRouteRule: (value: string) => Promise<boolean>;
  removeChannelRouteRule: (value: string) => void;
  addFilePathAllowlistEntry: (value: string) => Promise<boolean>;
  removeFilePathAllowlistEntry: (value: string) => void;
  addTerminalCommandBlocklistEntry: (value: string) => Promise<boolean>;
  removeTerminalCommandBlocklistEntry: (value: string) => void;
  addCustomToolGrant: (value: string) => Promise<boolean>;
  removeCustomToolGrant: (value: string) => void;
  markSetupComplete: () => void;
  markOnboardingSeen: () => void;
  openGuide: () => void;
  closeGuide: () => void;
  resetSettings: () => void;
}

const SETTINGS_STORAGE_KEY = 'agentcorp-settings';
const LEGACY_SETTINGS_STORAGE_KEY = 'clawx-settings';

function createSettingsStateStorage(): StateStorage {
  return {
    getItem: (name) => {
      if (typeof window === 'undefined') return null;
      try {
        const value = window.localStorage.getItem(name);
        if (value !== null) {
          return value;
        }
        if (name !== SETTINGS_STORAGE_KEY) {
          return null;
        }
        const legacyValue = window.localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
        if (legacyValue !== null) {
          window.localStorage.setItem(SETTINGS_STORAGE_KEY, legacyValue);
          window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
        }
        return legacyValue;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(name, value);
        if (name === SETTINGS_STORAGE_KEY) {
          window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
        }
      } catch {
        // ignore renderer storage errors
      }
    },
    removeItem: (name) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.removeItem(name);
        if (name === SETTINGS_STORAGE_KEY) {
          window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
        }
      } catch {
        // ignore renderer storage errors
      }
    },
  };
}

function normalizeListEntry(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function appendUniqueEntry(entries: string[], value: string): string[] {
  const normalized = normalizeListEntry(value);
  if (!normalized || entries.includes(normalized)) {
    return entries;
  }
  return [...entries, normalized];
}

function removeEntry(entries: string[], value: string): string[] {
  return entries.filter((entry) => entry !== value);
}

const defaultSettings = {
  theme: 'system' as Theme,
  accentColor: '#007aff',
  language: resolveSupportedLanguage(typeof navigator !== 'undefined' ? navigator.language : undefined),
  startMinimized: false,
  launchAtStartup: false,
  telemetryEnabled: true,
  gatewayAutoStart: true,
  gatewayPort: 18789,
  proxyEnabled: false,
  proxyServer: '',
  proxyHttpServer: '',
  proxyHttpsServer: '',
  proxyAllServer: '',
  proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
  updateChannel: 'stable' as UpdateChannel,
  autoCheckUpdate: true,
  autoDownloadUpdate: false,
  sidebarCollapsed: false,
  contextRailCollapsed: true,
  rightPanelMode: null as 'agent' | 'files' | 'session' | null,
  devModeUnlocked: false,
  remoteRpcEnabled: false,
  p2pSyncEnabled: false,
  setupComplete: false,
  onboardingSeen: false,
  guideOpen: false,
  brandName: 'AgentCorp',
  brandSubtitle: 'Workflow Fit Platform',
  myName: 'Workspace Owner',
  brandLogoDataUrl: null as string | null,
  brandIconDataUrl: null as string | null,
  defaultModel: 'claude-sonnet-4-6',
  contextLimit: 32000,
  showToolCalls: false,
  emojiAvatar: true,
  hideAvatarBg: false,
  minimizeToTray: true,
  autoSpawn: true,
  modelInherit: true,
  strictIsolation: true,
  orgTemplate: 'three-six',
  groupChatMode: 'at-trigger',
  groupRate: '5',
  workerSlots: '4',
  maxDailyRuns: '200',
  exponentialBackoff: true,
  agentSelfHeal: true,
  suspendOnFail: true,
  mobileAlert: true,
  globalRiskLevel: 'standard' as GlobalRiskLevel,
  fileAcl: true,
  terminalAcl: true,
  networkAcl: true,
  channelRouteRules: [] as string[],
  filePathAllowlist: [] as string[],
  terminalCommandBlocklist: [] as string[],
  customToolGrants: [] as string[],
};

type SettingsPatch = Partial<typeof defaultSettings>;

function persistSettingsPatch(patch: SettingsPatch): Promise<void> {
  return hostApiFetch('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then(() => undefined);
}

function persistSettingValue<K extends keyof typeof defaultSettings>(
  key: K,
  value: (typeof defaultSettings)[K],
): Promise<void> {
  return hostApiFetch(`/api/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  }).then(() => undefined);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,

      init: async () => {
        try {
          const settings = await hostApiFetch<Partial<typeof defaultSettings>>('/api/settings');
          const resolvedLanguage = settings.language
            ? resolveSupportedLanguage(settings.language)
            : undefined;
          set((state) => ({
            ...state,
            ...settings,
            ...(resolvedLanguage ? { language: resolvedLanguage } : {}),
          }));
          if (resolvedLanguage) {
            i18n.changeLanguage(resolvedLanguage);
          }
        } catch {
          // Keep renderer-persisted settings as a fallback when the main
          // process store is not reachable.
        }
      },

      setTheme: (theme) => set({ theme }),
      setAccentColor: (accentColor) => set({ accentColor }),
      setLanguage: (language) => {
        const resolvedLanguage = resolveSupportedLanguage(language);
        i18n.changeLanguage(resolvedLanguage);
        set({ language: resolvedLanguage });
        void hostApiFetch('/api/settings/language', {
          method: 'PUT',
          body: JSON.stringify({ value: resolvedLanguage }),
        }).catch(() => { });
      },
      setStartMinimized: (startMinimized) => set({ startMinimized }),
      setLaunchAtStartup: (launchAtStartup) => {
        set({ launchAtStartup });
        void hostApiFetch('/api/settings/launchAtStartup', {
          method: 'PUT',
          body: JSON.stringify({ value: launchAtStartup }),
        }).catch(() => { });
      },
      setTelemetryEnabled: (telemetryEnabled) => {
        set({ telemetryEnabled });
        void hostApiFetch('/api/settings/telemetryEnabled', {
          method: 'PUT',
          body: JSON.stringify({ value: telemetryEnabled }),
        }).catch(() => { });
      },
      setGatewayAutoStart: (gatewayAutoStart) => {
        set({ gatewayAutoStart });
        void hostApiFetch('/api/settings/gatewayAutoStart', {
          method: 'PUT',
          body: JSON.stringify({ value: gatewayAutoStart }),
        }).catch(() => { });
      },
      setGatewayPort: (gatewayPort) => {
        set({ gatewayPort });
        void hostApiFetch('/api/settings/gatewayPort', {
          method: 'PUT',
          body: JSON.stringify({ value: gatewayPort }),
        }).catch(() => { });
      },
      setProxyEnabled: (proxyEnabled) => set({ proxyEnabled }),
      setProxyServer: (proxyServer) => set({ proxyServer }),
      setProxyHttpServer: (proxyHttpServer) => set({ proxyHttpServer }),
      setProxyHttpsServer: (proxyHttpsServer) => set({ proxyHttpsServer }),
      setProxyAllServer: (proxyAllServer) => set({ proxyAllServer }),
      setProxyBypassRules: (proxyBypassRules) => set({ proxyBypassRules }),
      setUpdateChannel: (updateChannel) => {
        set({ updateChannel });
        void persistSettingValue('updateChannel', updateChannel).catch(() => { });
      },
      setAutoCheckUpdate: (autoCheckUpdate) => {
        set({ autoCheckUpdate });
        void persistSettingValue('autoCheckUpdate', autoCheckUpdate).catch(() => { });
      },
      setAutoDownloadUpdate: (autoDownloadUpdate) => {
        set({ autoDownloadUpdate });
        void persistSettingValue('autoDownloadUpdate', autoDownloadUpdate).catch(() => { });
      },
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setContextRailCollapsed: (contextRailCollapsed) => set({ contextRailCollapsed }),
      setRightPanelMode: (rightPanelMode) => set({ rightPanelMode }),
      setDevModeUnlocked: (devModeUnlocked) => {
        set({ devModeUnlocked });
        void hostApiFetch('/api/settings/devModeUnlocked', {
          method: 'PUT',
          body: JSON.stringify({ value: devModeUnlocked }),
        }).catch(() => { });
      },
      setRemoteRpcEnabled: (remoteRpcEnabled) => {
        set({ remoteRpcEnabled });
        void persistSettingValue('remoteRpcEnabled', remoteRpcEnabled).catch(() => { });
      },
      setP2pSyncEnabled: (p2pSyncEnabled) => {
        set({ p2pSyncEnabled });
        void persistSettingValue('p2pSyncEnabled', p2pSyncEnabled).catch(() => { });
      },
      markSetupComplete: () => {
        set({ setupComplete: true });
        void hostApiFetch('/api/settings/setupComplete', {
          method: 'PUT',
          body: JSON.stringify({ value: true }),
        }).catch(() => { });
      },
      markOnboardingSeen: () => {
        set({ onboardingSeen: true });
        void persistSettingValue('onboardingSeen', true).catch(() => { });
      },
      openGuide: () => set({ guideOpen: true }),
      closeGuide: () => set({ guideOpen: false }),
      setBrandName: (brandName) => set({ brandName }),
      setBrandSubtitle: (brandSubtitle) => set({ brandSubtitle }),
      setBrandLogoDataUrl: (brandLogoDataUrl) => set({ brandLogoDataUrl }),
      setBrandIconDataUrl: (brandIconDataUrl) => set({ brandIconDataUrl }),
      setMyName: (myName) => set({ myName }),
      setDefaultModel: (defaultModel) => set({ defaultModel }),
      setContextLimit: (contextLimit) => set({ contextLimit }),
      setShowToolCalls: (showToolCalls) => set({ showToolCalls }),
      setEmojiAvatar: (emojiAvatar) => set({ emojiAvatar }),
      setHideAvatarBg: (hideAvatarBg) => set({ hideAvatarBg }),
      setMinimizeToTray: (minimizeToTray) => set({ minimizeToTray }),
      setAutoSpawn: (autoSpawn) => set({ autoSpawn }),
      setModelInherit: (modelInherit) => set({ modelInherit }),
      setStrictIsolation: (strictIsolation) => set({ strictIsolation }),
      setOrgTemplate: (orgTemplate) => set({ orgTemplate }),
      setGroupChatMode: (groupChatMode) => {
        set({ groupChatMode });
        void persistSettingValue('groupChatMode', groupChatMode).catch(() => { });
      },
      setGroupRate: (groupRate) => {
        set({ groupRate });
        void persistSettingValue('groupRate', groupRate).catch(() => { });
      },
      setWorkerSlots: (workerSlots) => set({ workerSlots }),
      setMaxDailyRuns: (maxDailyRuns) => set({ maxDailyRuns }),
      setExponentialBackoff: (exponentialBackoff) => set({ exponentialBackoff }),
      setAgentSelfHeal: (agentSelfHeal) => set({ agentSelfHeal }),
      setSuspendOnFail: (suspendOnFail) => set({ suspendOnFail }),
      setMobileAlert: (mobileAlert) => set({ mobileAlert }),
      setGlobalRiskLevel: (globalRiskLevel) => {
        set({ globalRiskLevel });
        void persistSettingValue('globalRiskLevel', globalRiskLevel).catch(() => { });
      },
      setFileAcl: (fileAcl) => {
        set({ fileAcl });
        void persistSettingValue('fileAcl', fileAcl).catch(() => { });
      },
      setTerminalAcl: (terminalAcl) => {
        set({ terminalAcl });
        void persistSettingValue('terminalAcl', terminalAcl).catch(() => { });
      },
      setNetworkAcl: (networkAcl) => {
        set({ networkAcl });
        void persistSettingValue('networkAcl', networkAcl).catch(() => { });
      },
      addChannelRouteRule: async (value) => {
        const channelRouteRules = get().channelRouteRules;
        const updated = appendUniqueEntry(channelRouteRules, value);
        if (updated.length === channelRouteRules.length) {
          return false;
        }
        await persistSettingsPatch({ channelRouteRules: updated });
        set({ channelRouteRules: updated });
        return true;
      },
      removeChannelRouteRule: (value) =>
        set((state) => {
          const updated = removeEntry(state.channelRouteRules, value);
          if (updated.length === state.channelRouteRules.length) {
            return {};
          }
          persistSettingsPatch({ channelRouteRules: updated });
          return { channelRouteRules: updated };
        }),
      addFilePathAllowlistEntry: async (value) => {
        const filePathAllowlist = get().filePathAllowlist;
        const updated = appendUniqueEntry(filePathAllowlist, value);
        if (updated.length === filePathAllowlist.length) {
          return false;
        }
        await persistSettingsPatch({ filePathAllowlist: updated });
        set({ filePathAllowlist: updated });
        return true;
      },
      removeFilePathAllowlistEntry: (value) =>
        set((state) => {
          const updated = removeEntry(state.filePathAllowlist, value);
          if (updated.length === state.filePathAllowlist.length) {
            return {};
          }
          persistSettingsPatch({ filePathAllowlist: updated });
          return { filePathAllowlist: updated };
        }),
      addTerminalCommandBlocklistEntry: async (value) => {
        const terminalCommandBlocklist = get().terminalCommandBlocklist;
        const updated = appendUniqueEntry(terminalCommandBlocklist, value);
        if (updated.length === terminalCommandBlocklist.length) {
          return false;
        }
        await persistSettingsPatch({ terminalCommandBlocklist: updated });
        set({ terminalCommandBlocklist: updated });
        return true;
      },
      removeTerminalCommandBlocklistEntry: (value) =>
        set((state) => {
          const updated = removeEntry(state.terminalCommandBlocklist, value);
          if (updated.length === state.terminalCommandBlocklist.length) {
            return {};
          }
          persistSettingsPatch({ terminalCommandBlocklist: updated });
          return { terminalCommandBlocklist: updated };
        }),
      addCustomToolGrant: async (value) => {
        const customToolGrants = get().customToolGrants;
        const updated = appendUniqueEntry(customToolGrants, value);
        if (updated.length === customToolGrants.length) {
          return false;
        }
        await persistSettingsPatch({ customToolGrants: updated });
        set({ customToolGrants: updated });
        return true;
      },
      removeCustomToolGrant: (value) =>
        set((state) => {
          const updated = removeEntry(state.customToolGrants, value);
          if (updated.length === state.customToolGrants.length) {
            return {};
          }
          persistSettingsPatch({ customToolGrants: updated });
          return { customToolGrants: updated };
        }),
      resetSettings: () => set(defaultSettings),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(createSettingsStateStorage),
    }
  )
);
