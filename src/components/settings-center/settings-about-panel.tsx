import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSectionCard } from '@/components/settings-center/settings-section-card';
import { Switch } from '@/components/ui/switch';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { useSettingsStore } from '@/stores/settings';
import { useUpdateStore } from '@/stores/update';

type SettingsAboutPanelProps = {
  onRerunSetup?: () => void;
};

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-[#f9fafb] px-4 py-3">
      <p className="text-[13px] font-medium text-[#111827]">{label}</p>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );
}

function DisclosureCard({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[#c6c6c8] bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
        aria-expanded={open}
        aria-label={title}
      >
        <span className="text-[15px] font-semibold text-[#000000]">{title}</span>
        <span className="text-[12px] text-[#8e8e93]" aria-hidden="true">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open ? <div className="space-y-4 border-t border-black/[0.06] px-5 py-4">{children}</div> : null}
    </section>
  );
}

export function SettingsAboutPanel({ onRerunSetup }: SettingsAboutPanelProps) {
  const { t } = useTranslation('settings');
  const currentVersion = useUpdateStore((state) => state.currentVersion);

  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const setDevModeUnlocked = useSettingsStore((state) => state.setDevModeUnlocked);
  const remoteRpcEnabled = useSettingsStore((state) => state.remoteRpcEnabled);
  const setRemoteRpcEnabled = useSettingsStore((state) => state.setRemoteRpcEnabled);
  const p2pSyncEnabled = useSettingsStore((state) => state.p2pSyncEnabled);
  const setP2pSyncEnabled = useSettingsStore((state) => state.setP2pSyncEnabled);
  const telemetryEnabled = useSettingsStore((state) => state.telemetryEnabled);
  const setTelemetryEnabled = useSettingsStore((state) => state.setTelemetryEnabled);

  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [doctorRunning, setDoctorRunning] = useState<'diagnose' | 'fix' | null>(null);
  const [doctorSummary, setDoctorSummary] = useState('');
  const [resetting, setResetting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const runtimeSummary = useMemo(
    () =>
      [
        `Platform: ${window.electron?.platform ?? navigator.platform}`,
        `App Version: ${currentVersion}`,
        `User Agent: ${navigator.userAgent}`,
      ].join('\n'),
    [currentVersion],
  );

  const runDoctor = async (mode: 'diagnose' | 'fix') => {
    setDoctorRunning(mode);
    try {
      const result = await hostApiFetch<{
        success: boolean;
        exitCode?: number;
        stderr?: string;
      }>('/api/app/openclaw-doctor', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });

      setDoctorSummary(
        result.success
          ? `${mode === 'fix' ? '修复' : '诊断'}完成`
          : `${mode === 'fix' ? '修复' : '诊断'}失败${result.stderr ? `：${result.stderr}` : ''}`,
      );
    } finally {
      setDoctorRunning(null);
    }
  };

  const handleCopyEnvironment = async () => {
    await navigator.clipboard?.writeText(runtimeSummary);
  };

  const handleResetAllSettings = async () => {
    setResetting(true);
    try {
      await hostApiFetch('/api/settings/reset', {
        method: 'POST',
      });
    } finally {
      setResetting(false);
    }
  };

  const handleClearServerData = async () => {
    setClearing(true);
    try {
      await hostApiFetch('/api/app/clear-server-data', {
        method: 'POST',
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSectionCard title={t('about.title', { defaultValue: 'About' })}>
        <div className="rounded-2xl bg-[linear-gradient(135deg,#f8fafc_0%,#eef2ff_100%)] px-5 py-5">
          <h2 className="text-[24px] font-semibold text-[#111827]">
            {t('about.appName', { defaultValue: 'AgentCorp' })}
          </h2>
          <p className="mt-2 text-[14px] text-[#475467]">
            Workflow-fit platform for discovering, validating, and operating AI agents in real work.
          </p>
          <div className="mt-4 flex flex-wrap gap-4 text-[12px] text-[#667085]">
            <span>Architecture-led product shell</span>
            <span>Version {currentVersion}</span>
            <span>Electron + React + Vite</span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl bg-[#f9fafb] px-4 py-4">
            <p className="text-[13px] font-semibold text-[#111827]">Product & Team</p>
            <p className="mt-2 text-[12px] leading-6 text-[#667085]">
              AgentCorp packages candidate discovery, fit validation, task routing, and operating feedback
              into one desktop-first control plane for day-to-day agent work.
            </p>
            <p className="mt-2 text-[12px] leading-6 text-[#667085]">
              Settings keep diagnostics and maintenance nearby, while the primary product flow stays focused on
              discover → validate → operate → learn.
            </p>
          </div>
          <div className="rounded-xl bg-[#f9fafb] px-4 py-4">
            <p className="text-[13px] font-semibold text-[#111827]">Open Source & Feedback</p>
            <p className="mt-2 text-[12px] leading-6 text-[#667085]">
              The public repository carries the architecture blueprint, implementation notes, and issue tracker so
              contributors can improve the product against one shared system map.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  void invokeIpc(
                    'shell:openExternal',
                    'https://github.com/EriXPsy/AgentCorp/issues',
                  )
                }
                className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7]"
              >
                提交 Issue
              </button>
              <button
                type="button"
                onClick={() =>
                  void invokeIpc(
                    'shell:openExternal',
                    'https://github.com/EriXPsy/AgentCorp/blob/main/docs/architecture-blueprint.md',
                  )
                }
                className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7]"
              >
                查看架构蓝图
              </button>
              <button
                type="button"
                onClick={() => void handleCopyEnvironment()}
                className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7]"
              >
                复制环境信息
              </button>
            </div>
          </div>
        </div>
      </SettingsSectionCard>

      <DisclosureCard
        title="开发者诊断"
        open={diagnosticsOpen}
        onToggle={() => setDiagnosticsOpen((value) => !value)}
      >
        <div className="rounded-xl bg-[#f9fafb] px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[#111827]">AgentCorp Doctor</p>
              <p className="mt-1 text-[12px] text-[#667085]">
                从设置页直接运行运行时诊断检查，无需跳转到独立维护页面。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runDoctor('diagnose')}
                disabled={doctorRunning !== null}
                className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {doctorRunning === 'diagnose' ? '运行中…' : '运行诊断'}
              </button>
              <button
                type="button"
                onClick={() => void runDoctor('fix')}
                disabled={doctorRunning !== null}
                className="rounded-lg bg-[#0a7aff] px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-[#075ac4] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {doctorRunning === 'fix' ? '运行中…' : '运行修复'}
              </button>
            </div>
          </div>
          {doctorSummary ? (
            <p className="mt-3 text-[12px] text-[#667085]">{doctorSummary}</p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow
            label="开发者模式"
            checked={devModeUnlocked}
            onCheckedChange={setDevModeUnlocked}
          />
          <ToggleRow
            label="远程 RPC 访问"
            checked={remoteRpcEnabled}
            onCheckedChange={setRemoteRpcEnabled}
          />
          <ToggleRow
            label="P2P 同步预览"
            checked={p2pSyncEnabled}
            onCheckedChange={setP2pSyncEnabled}
          />
          <ToggleRow
            label="匿名遥测"
            checked={telemetryEnabled}
            onCheckedChange={setTelemetryEnabled}
          />
        </div>
      </DisclosureCard>

      <DisclosureCard
        title="维护与恢复"
        open={maintenanceOpen}
        onToggle={() => setMaintenanceOpen((value) => !value)}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => onRerunSetup?.()}
            className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7]"
          >
            重新运行初始化
          </button>
          <button
            type="button"
            onClick={() => void handleResetAllSettings()}
            disabled={resetting || clearing}
            className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resetting ? '重置中…' : '重置所有设置'}
          </button>
          <button
            type="button"
            onClick={() => void handleClearServerData()}
            disabled={resetting || clearing}
            className="rounded-lg border border-black/10 px-3 py-2 text-[12px] font-medium text-[#111827] transition hover:bg-[#f2f2f7] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {clearing ? '清除中…' : '清除服务器数据'}
          </button>
        </div>
      </DisclosureCard>
    </div>
  );
}
