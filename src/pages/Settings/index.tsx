import { useEffect, useId, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { SettingsMemoryKnowledgePanel } from '@/components/settings-center/settings-memory-knowledge-panel';
import { SettingsMigrationPanel } from '@/components/settings-center/settings-migration-panel';
import { SettingsMigrationWizard } from '@/components/settings-center/settings-migration-wizard';
import { SettingsNav } from '@/components/settings-center/settings-nav';
import { SettingsSectionCard } from '@/components/settings-center/settings-section-card';
import { SettingsCostsUsagePanel } from '@/components/settings-center/settings-costs-usage-panel';
import { SettingsModelsProvidersPanel } from '@/components/settings-center/settings-models-providers-panel';
import {
  parseSettingsSection,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_META,
  type SettingsSectionId,
} from '@/components/settings-center/settings-shell-data';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { invokeIpc, toUserMessage } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useUpdateStore } from '@/stores/update';
import type { ReactNode } from 'react';

export function Settings() {
  const { t } = useTranslation(['settings', 'common']);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    proxyEnabled,
    proxyServer,
    proxyHttpServer,
    proxyHttpsServer,
    proxyAllServer,
    proxyBypassRules,
    setProxyEnabled,
    setProxyServer,
    setProxyHttpServer,
    setProxyHttpsServer,
    setProxyAllServer,
    setProxyBypassRules,
    autoCheckUpdate,
    setAutoCheckUpdate,
    autoDownloadUpdate,
    setAutoDownloadUpdate,
    devModeUnlocked,
    setDevModeUnlocked,
    remoteRpcEnabled,
    setRemoteRpcEnabled,
    p2pSyncEnabled,
    setP2pSyncEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    resetSettings,
  } = useSettingsStore();

  const { status: gatewayStatus, restart: restartGateway } = useGatewayStore();
  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const updateSetAutoDownload = useUpdateStore((state) => state.setAutoDownload);
  const updateStatus = useUpdateStore((state) => state.status);
  const updateInfo = useUpdateStore((state) => state.updateInfo);
  const updateProgress = useUpdateStore((state) => state.progress);
  const updateError = useUpdateStore((state) => state.error);
  const updatePolicy = useUpdateStore((state) => state.policy);
  const updateSetChannel = useUpdateStore((state) => state.setChannel);
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate);
  const installUpdate = useUpdateStore((state) => state.installUpdate);
  const initUpdate = useUpdateStore((state) => state.init);

  const [proxyEnabledDraft, setProxyEnabledDraft] = useState(proxyEnabled);
  const [proxyServerDraft, setProxyServerDraft] = useState(proxyServer);
  const [proxyHttpServerDraft, setProxyHttpServerDraft] = useState(proxyHttpServer);
  const [proxyHttpsServerDraft, setProxyHttpsServerDraft] = useState(proxyHttpsServer);
  const [proxyAllServerDraft, setProxyAllServerDraft] = useState(proxyAllServer);
  const [proxyBypassRulesDraft, setProxyBypassRulesDraft] = useState(proxyBypassRules);
  const [savingProxy, setSavingProxy] = useState(false);
  const [doctorRunning, setDoctorRunning] = useState<'diagnose' | 'fix' | null>(null);
  const [doctorSummary, setDoctorSummary] = useState('');
  const [migrationWizardOpen, setMigrationWizardOpen] = useState(false);
  const [resettingAllSettings, setResettingAllSettings] = useState(false);
  const [clearingServerData, setClearingServerData] = useState(false);
  const activeSection = parseSettingsSection(searchParams.get('section'));

  useEffect(() => setProxyEnabledDraft(proxyEnabled), [proxyEnabled]);
  useEffect(() => setProxyServerDraft(proxyServer), [proxyServer]);
  useEffect(() => setProxyHttpServerDraft(proxyHttpServer), [proxyHttpServer]);
  useEffect(() => setProxyHttpsServerDraft(proxyHttpsServer), [proxyHttpsServer]);
  useEffect(() => setProxyAllServerDraft(proxyAllServer), [proxyAllServer]);
  useEffect(() => setProxyBypassRulesDraft(proxyBypassRules), [proxyBypassRules]);
  useEffect(() => {
    if (activeSection !== 'migration-backup' && migrationWizardOpen) {
      setMigrationWizardOpen(false);
    }
  }, [activeSection, migrationWizardOpen]);
  useEffect(() => {
    const section = searchParams.get('section');
    if (section === activeSection) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('section', activeSection);
    setSearchParams(nextParams, { replace: true });
  }, [activeSection, searchParams, setSearchParams]);

  const activeMeta = SETTINGS_SECTION_META[activeSection];

  const handleSectionChange = (section: SettingsSectionId) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('section', section);
    setSearchParams(nextParams, { replace: true });
  };

  const saveProxySettings = async () => {
    setSavingProxy(true);
    try {
      const normalizedProxyServer = proxyServerDraft.trim();
      const normalizedHttpServer = proxyHttpServerDraft.trim();
      const normalizedHttpsServer = proxyHttpsServerDraft.trim();
      const normalizedAllServer = proxyAllServerDraft.trim();
      const normalizedBypassRules = proxyBypassRulesDraft.trim();

      await invokeIpc('settings:setMany', {
        proxyEnabled: proxyEnabledDraft,
        proxyServer: normalizedProxyServer,
        proxyHttpServer: normalizedHttpServer,
        proxyHttpsServer: normalizedHttpsServer,
        proxyAllServer: normalizedAllServer,
        proxyBypassRules: normalizedBypassRules,
      });

      setProxyEnabled(proxyEnabledDraft);
      setProxyServer(normalizedProxyServer);
      setProxyHttpServer(normalizedHttpServer);
      setProxyHttpsServer(normalizedHttpsServer);
      setProxyAllServer(normalizedAllServer);
      setProxyBypassRules(normalizedBypassRules);
      toast.success(t('settings:gateway.proxySaved'));
    } catch (error) {
      toast.error(`${t('settings:gateway.proxySaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingProxy(false);
    }
  };

  const runDoctor = async (mode: 'diagnose' | 'fix') => {
    setDoctorRunning(mode);
    try {
      const result = await hostApiFetch<{
        success: boolean;
        exitCode?: number;
        stderr?: string;
        stdout?: string;
      }>('/api/app/openclaw-doctor', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const summary = result?.success
        ? `${mode}: success (exit=${result.exitCode ?? 0})`
        : `${mode}: failed (exit=${result?.exitCode ?? 'n/a'}) ${result?.stderr ?? ''}`;
      setDoctorSummary(summary);
      if (result?.success) {
        toast.success(
          mode === 'fix'
            ? t('settings:developer.doctorFixSucceeded')
            : t('settings:developer.doctorSucceeded'),
        );
      } else {
        toast.error(
          mode === 'fix'
            ? t('settings:developer.doctorFixFailed')
            : t('settings:developer.doctorFailed'),
        );
      }
    } catch (error) {
      setDoctorSummary(`${mode}: ${toUserMessage(error)}`);
      toast.error(toUserMessage(error));
    } finally {
      setDoctorRunning(null);
    }
  };

  const rerunSetup = () => {
    navigate('/setup');
  };

  const resetAllSettings = async () => {
    setResettingAllSettings(true);
    try {
      await hostApiFetch('/api/settings/reset', {
        method: 'POST',
      });
      resetSettings();
      toast.success(t('settings:maintenance.resetSuccess'));
    } catch (error) {
      toast.error(t('settings:maintenance.resetFailed', { error: toUserMessage(error) }));
    } finally {
      setResettingAllSettings(false);
    }
  };

  const clearServerData = async () => {
    setClearingServerData(true);
    try {
      await hostApiFetch('/api/app/clear-server-data', {
        method: 'POST',
      });
      toast.success(t('settings:maintenance.clearSuccess'));
    } catch (error) {
      toast.error(t('settings:maintenance.clearFailed', { error: toUserMessage(error) }));
    } finally {
      setClearingServerData(false);
    }
  };

  return (
    <div className="h-full bg-[linear-gradient(180deg,#f3f4f6_0%,#eceff3_100%)] p-6 dark:bg-background">
      <div className="mx-auto flex h-full max-w-[1360px] overflow-hidden rounded-[32px] border border-black/[0.05] bg-white shadow-[0_24px_64px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-background">
        <SettingsNav
          groups={SETTINGS_NAV_GROUPS}
          activeItemId={activeSection}
          onChange={handleSectionChange}
        />

        <main className="min-w-0 flex-1 overflow-y-auto bg-white px-[60px] py-8 dark:bg-background">
          <div className="mx-auto max-w-[780px]">
            <header className="mb-8">
              <button
                onClick={() => navigate('/')}
                className="mb-4 flex items-center gap-2 text-[13px] text-[#8e8e93] transition-colors hover:text-[#000000]"
              >
                <ArrowLeft className="h-4 w-4" />
                返回工作台
              </button>
              <h1 className="text-[24px] font-semibold text-[#000000] dark:text-foreground">
                {t(activeMeta.titleKey)}{' '}
                <span className="text-[#3c3c43]">{t(activeMeta.kickerKey)}</span>
              </h1>
              <p className="mt-2 text-[13px] text-[#3c3c43] dark:text-muted-foreground">
                {t(activeMeta.subtitleKey)}
              </p>
            </header>

            <div className="space-y-5">
              {renderActiveSection({
                activeSection,
                gatewayStatus,
                restartGateway,
                proxyEnabledDraft,
                setProxyEnabledDraft,
                proxyServerDraft,
                setProxyServerDraft,
                proxyHttpServerDraft,
                setProxyHttpServerDraft,
                proxyHttpsServerDraft,
                setProxyHttpsServerDraft,
                proxyAllServerDraft,
                setProxyAllServerDraft,
                proxyBypassRulesDraft,
                setProxyBypassRulesDraft,
                saveProxySettings,
                savingProxy,
                currentVersion,
                autoCheckUpdate,
                setAutoCheckUpdate,
                autoDownloadUpdate,
                setAutoDownloadUpdate,
                updateSetAutoDownload,
                devModeUnlocked,
                setDevModeUnlocked,
                remoteRpcEnabled,
                setRemoteRpcEnabled,
                p2pSyncEnabled,
                setP2pSyncEnabled,
                telemetryEnabled,
                setTelemetryEnabled,
                doctorRunning,
                runDoctor,
                doctorSummary,
                rerunSetup,
                resetAllSettings,
                resettingAllSettings,
                clearServerData,
                clearingServerData,
                openMigrationWizard: () => setMigrationWizardOpen(true),
                updateStatus,
                updateInfo,
                updateProgress,
                updateError,
                updatePolicy,
                updateSetChannel,
                checkForUpdates,
                downloadUpdate,
                installUpdate,
                initUpdate,
                t,
              })}
            </div>
          </div>
        </main>
      </div>

      {migrationWizardOpen ? (
        <SettingsMigrationWizard open onOpenChange={setMigrationWizardOpen} />
      ) : null}
    </div>
  );
}

/* ─── renderActiveSection ─── */

type RenderSectionArgs = {
  activeSection: SettingsSectionId;
  gatewayStatus: { state: string; port?: number };
  restartGateway: () => unknown;
  proxyEnabledDraft: boolean;
  setProxyEnabledDraft: (value: boolean) => void;
  proxyServerDraft: string;
  setProxyServerDraft: (value: string) => void;
  proxyHttpServerDraft: string;
  setProxyHttpServerDraft: (value: string) => void;
  proxyHttpsServerDraft: string;
  setProxyHttpsServerDraft: (value: string) => void;
  proxyAllServerDraft: string;
  setProxyAllServerDraft: (value: string) => void;
  proxyBypassRulesDraft: string;
  setProxyBypassRulesDraft: (value: string) => void;
  saveProxySettings: () => Promise<void>;
  savingProxy: boolean;
  currentVersion: string;
  autoCheckUpdate: boolean;
  setAutoCheckUpdate: (value: boolean) => void;
  autoDownloadUpdate: boolean;
  setAutoDownloadUpdate: (value: boolean) => void;
  updateSetAutoDownload: (value: boolean) => void;
  devModeUnlocked: boolean;
  setDevModeUnlocked: (value: boolean) => void;
  remoteRpcEnabled: boolean;
  setRemoteRpcEnabled: (value: boolean) => void;
  p2pSyncEnabled: boolean;
  setP2pSyncEnabled: (value: boolean) => void;
  telemetryEnabled: boolean;
  setTelemetryEnabled: (value: boolean) => void;
  doctorRunning: 'diagnose' | 'fix' | null;
  runDoctor: (mode: 'diagnose' | 'fix') => Promise<void>;
  doctorSummary: string;
  rerunSetup: () => void;
  resetAllSettings: () => Promise<void>;
  resettingAllSettings: boolean;
  clearServerData: () => Promise<void>;
  clearingServerData: boolean;
  openMigrationWizard: () => void;
  updateStatus: import('@/stores/update').UpdateStatus;
  updateInfo: import('@/stores/update').UpdateInfo | null;
  updateProgress: import('@/stores/update').ProgressInfo | null;
  updateError: string | null;
  updatePolicy: import('@/stores/update').UpdatePolicySnapshot | null;
  updateSetChannel: (channel: 'stable' | 'beta' | 'dev') => Promise<void>;
  checkForUpdates: (options?: { reason?: 'manual' | 'startup'; respectPolicy?: boolean }) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => void;
  initUpdate: () => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
};

function renderActiveSection(args: RenderSectionArgs) {
  switch (args.activeSection) {
    case 'costs-usage':
      return <SettingsCostsUsagePanel />;

    case 'models-providers':
      return <SettingsModelsProvidersPanel />;

    case 'general':
      return <GeneralSettingsSection />;

    case 'memory-knowledge':
      return <SettingsMemoryKnowledgePanel />;

    case 'tool-permissions':
      return <SettingsToolPermissionsPanel />;

    case 'migration-backup':
      return <SettingsMigrationPanel onLaunchWizard={args.openMigrationWizard} />;

    case 'app-updates':
      return (
        <AutoUpdateSection
          currentVersion={args.currentVersion}
          autoCheckUpdate={args.autoCheckUpdate}
          setAutoCheckUpdate={args.setAutoCheckUpdate}
          autoDownloadUpdate={args.autoDownloadUpdate}
          setAutoDownloadUpdate={args.setAutoDownloadUpdate}
          updateSetAutoDownload={args.updateSetAutoDownload}
          updateStatus={args.updateStatus}
          updateInfo={args.updateInfo}
          updateProgress={args.updateProgress}
          updateError={args.updateError}
          updatePolicy={args.updatePolicy}
          updateSetChannel={args.updateSetChannel}
          checkForUpdates={args.checkForUpdates}
          downloadUpdate={args.downloadUpdate}
          installUpdate={args.installUpdate}
          initUpdate={args.initUpdate}
        />
      );

    case 'about':
      return (
        <>
          {/* Card 1: 实验室实验 */}
          <SettingsSectionCard
            title="实验室实验 (Experimental Flags)"
            description=""
          >
            <ToggleRow
              label="开发者专用模式 (Dev Mode)"
              desc="在主工作台解锁底层 WebSocket 抓包控制台与 RAW Payload 窗口。"
              checked={args.devModeUnlocked}
              onCheckedChange={args.setDevModeUnlocked}
            />
            <ToggleRow
              label="启用远程 API RPC 监听"
              desc="开启本地 18789 端口，允许本机的浏览器扩展或其他 Shell 直接使唤主控内核。 (有一定风险)"
              checked={args.remoteRpcEnabled}
              onCheckedChange={args.setRemoteRpcEnabled}
            />
            <ToggleRow
              label="启用 Tauri/Web P2P 同步 (预览)"
              desc="正在酝酿的能力测试：多机器设备组网互传 Agent 记忆。"
              checked={args.p2pSyncEnabled}
              onCheckedChange={args.setP2pSyncEnabled}
            />
          </SettingsSectionCard>

          {/* Card 2: 诊断排错与反馈系统 */}
          <SettingsSectionCard
            title="诊断排错与反馈系统"
            description=""
          >
            <div className="mb-3 flex items-center gap-3 rounded-xl bg-[#f2f2f7] px-4 py-3">
              <div className="flex-1">
                <p className="text-[13px] font-semibold text-[#2563eb]">AgentCorp Doctor</p>
                <p className="mt-0.5 text-[12px] text-[#8e8e93]">完整分析你的环境变量、Nodejs 版本与目录权限有无隐患。</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 rounded-lg text-[12px]"
                onClick={() => void args.runDoctor('diagnose')}
                disabled={args.doctorRunning !== null}
              >
                {args.doctorRunning === 'diagnose' ? args.t('common:status.running') : '运行诊断'}
              </Button>
            </div>

            {args.doctorSummary ? (
              <p className="mb-3 text-[12px] text-[#667085]">{args.doctorSummary}</p>
            ) : null}

            <ToggleRow
              label="崩溃时自动发送匿名报告 (Telemetry)"
              desc="帮助核心社区了解运行时发生的 Electron 异常。"
              checked={args.telemetryEnabled}
              onCheckedChange={args.setTelemetryEnabled}
            />

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => void invokeIpc('shell:openExternal', 'https://github.com/EriXPsy/AgentCorp/issues')}
                className="flex-1 rounded-xl border border-dashed border-[#c6c6c8] px-3 py-2.5 text-[13px] text-[#8e8e93] transition-colors hover:border-[#8e8e93] hover:text-[#3c3c43]"
              >
                📝 提交 Issue (GitHub)
              </button>
              <button
                type="button"
                onClick={() => {
                  const info = [
                    `Platform: ${window.electron?.platform ?? navigator.platform}`,
                    `App Version: ${args.currentVersion}`,
                    `Gateway: ${args.gatewayStatus.state} (port ${args.gatewayStatus.port ?? 'n/a'})`,
                    `User Agent: ${navigator.userAgent}`,
                  ].join('\n');
                  void navigator.clipboard.writeText(info);
                }}
                className="flex-1 rounded-xl border border-dashed border-[#c6c6c8] px-3 py-2.5 text-[13px] text-[#8e8e93] transition-colors hover:border-[#8e8e93] hover:text-[#3c3c43]"
              >
                🐛 复制本机运行环境清单
              </button>
            </div>
            <div className="mt-4 rounded-xl border border-[#c6c6c8] bg-[#f9fafb] p-3">
              <p className="text-[12px] font-medium text-[#111827]">维护</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg text-[12px]"
                  onClick={args.rerunSetup}
                >
                  重新运行初始化
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg text-[12px]"
                  onClick={() => void args.resetAllSettings()}
                  disabled={args.resettingAllSettings || args.clearingServerData}
                >
                  {args.resettingAllSettings ? args.t('common:status.running') : '重置所有设置'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg text-[12px]"
                  onClick={() => void args.clearServerData()}
                  disabled={args.clearingServerData || args.resettingAllSettings}
                >
                  {args.clearingServerData ? args.t('common:status.running') : '清除服务器数据'}
                </Button>
              </div>
            </div>
          </SettingsSectionCard>
        </>
      );

    default:
      return null;
  }
}

/* ─── Primitive helpers ─── */

function SettingsCard({
  title,
  headerRight,
  children,
  ...sectionProps
}: {
  title: string;
  headerRight?: ReactNode;
  children: ReactNode;
} & React.ComponentPropsWithoutRef<'section'>) {
  return (
    <section
      className="rounded-xl border border-[#c6c6c8] bg-white px-5 py-4"
      {...sectionProps}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-[#000000]">{title}</h3>
        {headerRight}
      </div>
      <div className="divide-y divide-black/[0.04]">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  desc,
  right,
}: {
  label: string;
  desc?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex min-h-[48px] items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[#000000]">{label}</p>
        {desc && <p className="mt-0.5 text-[12px] text-[#8e8e93]">{desc}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onCheckedChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-[13px] font-medium text-[#000000]">{label}</p>
        {desc && <p id={descriptionId} className="mt-0.5 text-[12px] text-[#8e8e93]">{desc}</p>}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-labelledby={labelId}
        aria-describedby={desc ? descriptionId : undefined}
      />
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputId = useId();
  return (
    <div className="py-3">
      <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-[#000000]">
        {label}
      </label>
      <input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-black/10 px-3 py-2 text-[13px] text-[#000000] outline-none focus:border-clawx-ac focus:ring-1 focus:ring-clawx-ac/20"
      />
    </div>
  );
}

/* ─── Section: General (07.1) ─── */

function GeneralSettingsSection() {
  return (
    <>
      <GeneralSection />
    </>
  );
}

function GeneralSection() {
  const {
    theme, setTheme, accentColor, setAccentColor, language, setLanguage, launchAtStartup, setLaunchAtStartup,
    brandName, setBrandName, brandSubtitle, setBrandSubtitle, myName, setMyName,
    showToolCalls, setShowToolCalls, emojiAvatar, setEmojiAvatar,
    hideAvatarBg, setHideAvatarBg, minimizeToTray, setMinimizeToTray,
  } = useSettingsStore();
  const languageSelectId = useId();
  const accentCustomColorId = useId();

  return (
    <>
      {/* 账号与安全 */}
      <SettingsCard title="账号与安全">
        <div className="rounded-lg border border-dashed border-[#c6c6c8] bg-[#f9fafb] px-4 py-3 text-[13px] text-[#3c3c43]">
          桌面端暂不提供账号管理或注销入口，请在其他官方入口完成账户相关操作。
        </div>
      </SettingsCard>

      {/* 外观与行为 */}
      <SettingsCard title="外观与行为">
        {/* Language dropdown */}
        <div className="py-3">
          <label htmlFor={languageSelectId} className="mb-2 block text-[13px] font-medium text-[#000000]">
            界面语言
          </label>
          <select
            id={languageSelectId}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 text-[13px] text-[#000000] outline-none focus:border-clawx-ac"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238e8e93' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 12px center',
              paddingRight: '32px',
            }}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[12px] text-[#8e8e93]">切换后需重启应用。</p>
        </div>

        {/* Theme mode */}
        <SettingsRow
          label="主题模式"
          desc="选择橙白浅色或 Neon Noir 深色模式。"
          right={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTheme('light')}
                className={cn(
                  'h-10 w-10 rounded-full border-2 transition-all',
                  theme === 'light' ? 'border-black/25 scale-110' : 'border-black/[0.04]',
                )}
                style={{
                  background:
                    'conic-gradient(from 90deg, #f97316 0deg 180deg, #f3f4f6 180deg 360deg)',
                }}
                title="浅色模式"
              />
              <button
                type="button"
                onClick={() => setTheme('dark')}
                className={cn(
                  'h-10 w-10 rounded-full border-2 transition-all',
                  theme === 'dark' ? 'border-white/30 scale-110' : 'border-black/[0.04]',
                )}
                style={{
                  background:
                    'conic-gradient(from 90deg, #1c1c1e 0deg 180deg, #7c3aed 180deg 360deg)',
                }}
                title="深色模式"
              />
            </div>
          }
        />

        {/* Accent color */}
        <SettingsRow
          label="主题色"
          desc="选择主色调，影响按钮、链接、选中态等全局高亮色。"
          right={
            <div className="flex items-center gap-2 flex-wrap">
              {[
                { color: '#007aff', label: '蓝色' },
                { color: '#10b981', label: '绿色' },
                { color: '#8b5cf6', label: '紫色' },
                { color: '#f97316', label: '橙色' },
                { color: '#ef4444', label: '红色' },
                { color: '#06b6d4', label: '青色' },
              ].map(({ color, label }) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`主题色 ${label}`}
                  onClick={() => setAccentColor(color)}
                  className={cn(
                    'h-7 w-7 rounded-full border-2 transition-all hover:scale-110',
                    accentColor === color ? 'border-black/40 scale-110' : 'border-black/[0.08]',
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
              <input
                id={accentCustomColorId}
                type="color"
                value={accentColor || '#007aff'}
                onChange={(e) => setAccentColor(e.target.value)}
                className="h-7 w-7 cursor-pointer rounded-full border border-black/10"
                aria-label="自定义颜色"
              />
            </div>
          }
        />

        <ToggleRow
          label="开机自启"
          desc="登录时自动启动 AgentCorp。"
          checked={launchAtStartup}
          onCheckedChange={setLaunchAtStartup}
        />
        <ToggleRow
          label="显示工具调用"
          desc="在对话消息中展示模型的工具调用详情块。"
          checked={showToolCalls}
          onCheckedChange={setShowToolCalls}
        />
        <ToggleRow
          label="仅以 Emoji 作为头像"
          desc="关闭彩色背景，仅显示 Emoji 和玻璃质感"
          checked={emojiAvatar}
          onCheckedChange={setEmojiAvatar}
        />
        <ToggleRow
          label="隐藏侧栏头像块背景"
          desc="使用全透明样式悬浮展示个人 Logo"
          checked={hideAvatarBg}
          onCheckedChange={setHideAvatarBg}
        />
        <ToggleRow
          label="关闭时隐藏到托盘"
          desc="点击顶部关闭按钮时不退出进程，维持 Cron 和通道在线"
          checked={minimizeToTray}
          onCheckedChange={setMinimizeToTray}
        />
      </SettingsCard>

      {/* 品牌与身份 */}
      <SettingsCard title="品牌与身份">
        <InputField label="工作台名称" value={brandName} onChange={setBrandName} />
        <InputField label="副标题" value={brandSubtitle} onChange={setBrandSubtitle} />
        <InputField label="我的名字指代" value={myName} onChange={setMyName} />
      </SettingsCard>
    </>
  );
}

/* ─── Section: Tool Permissions (09.3) ─── */

export function SettingsToolPermissionsPanel() {
  const {
    globalRiskLevel,
    setGlobalRiskLevel,
    fileAcl,
    setFileAcl,
    terminalAcl,
    setTerminalAcl,
    networkAcl,
    setNetworkAcl,
    filePathAllowlist,
    addFilePathAllowlistEntry,
    removeFilePathAllowlistEntry,
    terminalCommandBlocklist,
    addTerminalCommandBlocklistEntry,
    removeTerminalCommandBlocklistEntry,
    customToolGrants,
    addCustomToolGrant,
    removeCustomToolGrant,
  } = useSettingsStore();
  const [whitelistEditorOpen, setWhitelistEditorOpen] = useState(false);
  const [whitelistDraft, setWhitelistDraft] = useState('');
  const [blacklistEditorOpen, setBlacklistEditorOpen] = useState(false);
  const [blacklistDraft, setBlacklistDraft] = useState('');
  const [grantEditorOpen, setGrantEditorOpen] = useState(false);
  const [grantDraft, setGrantDraft] = useState('');

  const selectStyle = {
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238e8e93' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat' as const,
    backgroundPosition: 'right 12px center',
    paddingRight: '32px',
  };

  const handleAppendUniqueItem = (
    value: string,
    existingItems: string[],
    addItem: (item: string) => Promise<boolean>,
    successMessage: string,
    duplicateMessage: string,
    reset: () => void,
  ) => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (existingItems.includes(normalized)) {
      toast.error(duplicateMessage);
      return;
    }
    void (async () => {
      try {
        const added = await addItem(normalized);
        if (!added) return;
        reset();
        toast.success(successMessage);
      } catch {
        toast.error('保存失败，请稍后重试');
      }
    })();
  };

  const handleQuickGrant = (template: string) => {
    handleAppendUniqueItem(
      template,
      customToolGrants,
      addCustomToolGrant,
      `已添加工具许可：${template}`,
      `工具许可已存在：${template}`,
      () => undefined,
    );
  };

  return (
    <>
      <SettingsCard title="核心沙箱与内置权限">
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-clawx-ac" />
            <p className="text-[13px] font-medium text-[#000000]">
              全局风险级别设定
            </p>
          </div>
          <select
            className="w-[260px] shrink-0 appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 text-[12px] text-[#3c3c43] outline-none focus:border-clawx-ac"
            style={selectStyle}
            value={globalRiskLevel}
            aria-label="全局风险级别设定"
            onChange={(event) =>
              setGlobalRiskLevel(event.target.value as 'standard' | 'strict' | 'permissive')
            }
          >
            <option value="standard">Standard 防御模式 (读受控区、写必审批)</option>
            <option value="strict">Strict 锁定模式 (只读)</option>
            <option value="permissive">Permissive 宽松模式 (全量访问)</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[#000000]">本地文件操作 (File I/O ACL)</p>
            <p className="mt-0.5 text-[12px] text-[#8e8e93]">
              仅允许读写 Workspace 及指定 repo，拦截越权访问
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setWhitelistEditorOpen((open) => !open)}
              className="rounded border border-black/10 px-2 py-1 text-[11px] text-[#3c3c43] hover:bg-[#f2f2f7]"
            >
              路径白名单
            </button>
            <Switch checked={fileAcl} onCheckedChange={setFileAcl} aria-label="本地文件操作 (File I/O ACL)" />
          </div>
        </div>
        <EditableChipList
          items={filePathAllowlist}
          emptyLabel="暂无路径白名单，默认仅允许当前 Workspace。"
          listLabel="路径白名单"
          onRemove={removeFilePathAllowlistEntry}
        />
        {whitelistEditorOpen ? (
          <InlineListComposer
            label="新增允许访问路径"
            placeholder="例如：C:\\Projects\\AgentCorp"
            value={whitelistDraft}
            onChange={setWhitelistDraft}
            onSubmit={() =>
              handleAppendUniqueItem(
                whitelistDraft,
                filePathAllowlist,
                addFilePathAllowlistEntry,
                '已添加路径白名单',
                '该路径已在白名单中',
                () => {
                  setWhitelistDraft('');
                  setWhitelistEditorOpen(false);
                },
              )
            }
            onCancel={() => {
              setWhitelistDraft('');
              setWhitelistEditorOpen(false);
            }}
            submitLabel="保存路径"
          />
        ) : null}

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[#000000]">终端命令执行 (Terminal ACL)</p>
            <p className="mt-0.5 text-[12px] text-[#8e8e93]">
              拦截 rm -rf、sudo 等高危命令，允许常规构建指令
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setBlacklistEditorOpen((open) => !open)}
              className="rounded border border-black/10 px-2 py-1 text-[11px] text-[#3c3c43] hover:bg-[#f2f2f7]"
            >
              ◎ 编辑黑名单
            </button>
            <Switch checked={terminalAcl} onCheckedChange={setTerminalAcl} aria-label="终端命令执行 (Terminal ACL)" />
          </div>
        </div>
        <EditableChipList
          items={terminalCommandBlocklist}
          emptyLabel="暂无终端命令黑名单。"
          listLabel="终端命令黑名单"
          onRemove={removeTerminalCommandBlocklistEntry}
        />
        {blacklistEditorOpen ? (
          <InlineListComposer
            label="新增命令黑名单"
            placeholder="例如：rm -rf /"
            value={blacklistDraft}
            onChange={setBlacklistDraft}
            onSubmit={() =>
              handleAppendUniqueItem(
                blacklistDraft,
                terminalCommandBlocklist,
                addTerminalCommandBlocklistEntry,
                '已添加命令黑名单',
                '该命令已在黑名单中',
                () => {
                  setBlacklistDraft('');
                  setBlacklistEditorOpen(false);
                },
              )
            }
            onCancel={() => {
              setBlacklistDraft('');
              setBlacklistEditorOpen(false);
            }}
            submitLabel="保存黑名单"
          />
        ) : null}

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[#000000]">
              网络与依赖下载 (Network & Package Managers)
            </p>
            <p className="mt-0.5 text-[12px] text-[#8e8e93]">
              允许 wget、curl、pip、pnpm 进系统的副作用操作
            </p>
          </div>
          <Switch checked={networkAcl} onCheckedChange={setNetworkAcl} aria-label="网络与依赖下载 (Network & Package Managers)" />
        </div>
      </SettingsCard>

      <SettingsCard
        title="自定义工具授权"
        headerRight={
          <button
            type="button"
            onClick={() => setGrantEditorOpen((open) => !open)}
            className="rounded-lg bg-[#111] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#333]"
          >
            添加工具许可
          </button>
        }
      >
        <div className="py-2">
          <p className="mb-2 text-[13px] font-medium text-[#000000]">快速授权模版 (Quick Templates)</p>
          <div className="flex flex-wrap gap-2">
            {['Python 解释器', 'Docker Socket', 'Git CLI', 'Node.js 环境'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleQuickGrant(t)}
                className="rounded-full border border-black/10 px-3 py-1 text-[12px] text-[#3c3c43] hover:bg-[#f2f2f7]"
              >
                + {t}
              </button>
            ))}
          </div>
        </div>

        <EditableChipList
          items={customToolGrants}
          emptyLabel="暂无自定义工具授权"
          listLabel="自定义工具授权"
          onRemove={removeCustomToolGrant}
        />
        {grantEditorOpen ? (
          <InlineListComposer
            label="新增工具许可"
            placeholder="例如：github-cli --repo anthropics/claude-code"
            value={grantDraft}
            onChange={setGrantDraft}
            onSubmit={() =>
              handleAppendUniqueItem(
                grantDraft,
                customToolGrants,
                addCustomToolGrant,
                '已添加工具许可',
                '该工具许可已存在',
                () => {
                  setGrantDraft('');
                  setGrantEditorOpen(false);
                },
              )
            }
            onCancel={() => {
              setGrantDraft('');
              setGrantEditorOpen(false);
            }}
            submitLabel="保存许可"
          />
        ) : null}
      </SettingsCard>
    </>
  );
}


type EditableChipListProps = {
  items: string[];
  emptyLabel: string;
  listLabel: string;
  onRemove: (item: string) => void;
};

function EditableChipList({ items, emptyLabel, listLabel, onRemove }: EditableChipListProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-black/10 py-6 text-center text-[13px] text-[#8e8e93]">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul aria-label={listLabel} className="flex flex-wrap gap-2 py-3">
      {items.map((item) => (
        <li key={item}>
          <span className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-[#f8f8fb] px-3 py-1.5 text-[12px] text-[#3c3c43]">
            <span>{item}</span>
            <button
              type="button"
              onClick={() => onRemove(item)}
              className="rounded-full px-1 text-[#8e8e93] transition-colors hover:bg-[#e5e5ea] hover:text-[#000000]"
              aria-label={`移除 ${item}`}
            >
              ×
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

type InlineListComposerProps = {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
};

function InlineListComposer({
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
}: InlineListComposerProps) {
  const inputId = useId();
  return (
    <div className="mt-3 rounded-xl border border-black/[0.08] bg-[#fafafa] p-3">
      <label htmlFor={inputId} className="mb-2 block text-[12px] font-medium text-[#3c3c43]">{label}</label>
      <input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-[13px] text-[#000000] outline-none focus:border-clawx-ac"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] text-[#3c3c43] hover:bg-[#f2f2f7]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="rounded-lg bg-clawx-ac px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#0056b3]"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

/* ─── AutoUpdateSection ─── */

import type { UpdateStatus, UpdateInfo, ProgressInfo } from '@/stores/update';

function AutoUpdateSection({
  currentVersion,
  autoCheckUpdate,
  setAutoCheckUpdate,
  autoDownloadUpdate,
  setAutoDownloadUpdate,
  updateSetAutoDownload,
  updateStatus,
  updateInfo,
  updateProgress,
  updateError,
  updatePolicy,
  updateSetChannel,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  initUpdate,
}: {
  currentVersion: string;
  autoCheckUpdate: boolean;
  setAutoCheckUpdate: (v: boolean) => void;
  autoDownloadUpdate: boolean;
  setAutoDownloadUpdate: (v: boolean) => void;
  updateSetAutoDownload: (v: boolean) => void;
  updateStatus: UpdateStatus;
  updateInfo: UpdateInfo | null;
  updateProgress: ProgressInfo | null;
  updateError: string | null;
  updatePolicy: import('@/stores/update').UpdatePolicySnapshot | null;
  updateSetChannel: (channel: 'stable' | 'beta' | 'dev') => Promise<void>;
  checkForUpdates: (options?: { reason?: 'manual' | 'startup'; respectPolicy?: boolean }) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => void;
  initUpdate: () => Promise<void>;
}) {
  useEffect(() => { void initUpdate(); }, [initUpdate]);

  const nextEligibleLabel = updatePolicy?.nextEligibleAt
    ? new Date(updatePolicy.nextEligibleAt).toLocaleString('zh-CN')
    : 'Immediate';

  const statusLabel: Record<UpdateStatus, string> = {
    idle: '空闲',
    checking: '检查中...',
    available: '有新版本',
    'not-available': '已是最新',
    downloading: '下载中...',
    downloaded: '已下载，可安装',
    error: '出错',
  };

  return (
    <>
      <SettingsSectionCard title="当前版本" description="">
        <div className="flex items-center justify-between rounded-xl bg-[#f2f2f7] px-4 py-3">
          <div>
            <p className="text-[13px] font-semibold text-[#000000]">AgentCorp v{currentVersion}</p>
            <p className="mt-0.5 text-[12px] text-[#8e8e93]">
              状态：{statusLabel[updateStatus]}
              {updateInfo ? ` — 新版本 v${updateInfo.version}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {updateStatus === 'available' && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg text-[12px]"
                onClick={() => void downloadUpdate()}
              >
                下载更新
              </Button>
            )}
            {updateStatus === 'downloaded' && (
              <Button
                size="sm"
                className="rounded-lg bg-clawx-ac text-[12px] text-white hover:bg-[#0056b3]"
                onClick={installUpdate}
              >
                立即安装
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg text-[12px]"
              onClick={() => void checkForUpdates()}
              disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
            >
              {updateStatus === 'checking' ? '检查中...' : '检查更新'}
            </Button>
          </div>
        </div>

        {updateStatus === 'downloading' && updateProgress && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[12px] text-[#8e8e93]">
              <span>下载进度</span>
              <span>{Math.round(updateProgress.percent)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f2f2f7]">
              <div
                className="h-full rounded-full bg-clawx-ac transition-all"
                style={{ width: `${updateProgress.percent}%` }}
              />
            </div>
          </div>
        )}

        {updateError && (
          <p className="mt-2 text-[12px] text-[#ef4444]">{updateError}</p>
        )}

        {updateInfo?.releaseNotes && (
          <div className="mt-3 rounded-xl bg-[#f2f2f7] px-4 py-3">
            <p className="mb-1 text-[12px] font-medium text-[#3c3c43]">更新说明</p>
            <p className="text-[12px] text-[#8e8e93]">{String(updateInfo.releaseNotes)}</p>
          </div>
        )}
      </SettingsSectionCard>

      <SettingsSectionCard title="自动更新策略" description="">
        <ToggleRow
          label="自动检查更新"
          desc="启动时自动检查是否有新版本可用。"
          checked={autoCheckUpdate}
          onCheckedChange={setAutoCheckUpdate}
        />
        <ToggleRow
          label="自动下载更新"
          desc="发现新版本后自动在后台下载，下载完成后提示安装。"
          checked={autoDownloadUpdate}
          onCheckedChange={(v) => {
            setAutoDownloadUpdate(v);
            void updateSetAutoDownload(v);
          }}
        />
        <div className="mt-3 rounded-xl bg-[#f2f2f7] px-4 py-3 text-[12px] text-[#3c3c43]">
          <label className="block">
            <span className="text-[#8e8e93]">更新渠道</span>
            <select
              aria-label="更新渠道"
              value={updatePolicy?.channel ?? 'stable'}
              onChange={(event) => {
                void updateSetChannel(event.target.value as 'stable' | 'beta' | 'dev');
              }}
              className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-[13px] text-[#111827] outline-none focus:border-clawx-ac"
            >
              <option value="stable">稳定版</option>
              <option value="beta">测试版</option>
              <option value="dev">开发版</option>
            </select>
          </label>
        </div>
        <div className="mt-3 rounded-xl bg-[#f2f2f7] px-4 py-3 text-[12px] text-[#3c3c43]">
          <p className="font-medium text-[#111827]">更新策略</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <span className="text-[#8e8e93]">渠道</span>
              <p className="mt-0.5">{updatePolicy?.channel ?? 'stable'}</p>
            </div>
            <div>
              <span className="text-[#8e8e93]">检查次数</span>
              <p className="mt-0.5">{updatePolicy?.attemptCount ?? 0}</p>
            </div>
            <div>
              <span className="text-[#8e8e93]">下次可检查</span>
              <p className="mt-0.5">{nextEligibleLabel}</p>
            </div>
            <div>
              <span className="text-[#8e8e93]">推送延迟</span>
              <p className="mt-0.5">{Math.round((updatePolicy?.rolloutDelayMs ?? 0) / 60000)} min</p>
            </div>
          </div>
        </div>
      </SettingsSectionCard>
    </>
  );
}
export default Settings;
