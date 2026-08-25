/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Component, lazy, Suspense, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AppToaster } from '@/components/ui/Toast';
import { FirstRunGuide } from '@/components/onboarding/FirstRunGuide';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TooltipProvider } from '@/components/ui/tooltip';

// Route-level lazy imports — each page becomes its own chunk
const Chat = lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })));
const Agents = lazy(() => import('./pages/Agents').then((m) => ({ default: m.Agents })));
const AgentDetail = lazy(() => import('./pages/AgentDetail').then((m) => ({ default: m.AgentDetail })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const TeamOverview = lazy(() => import('./pages/TeamOverview').then((m) => ({ default: m.TeamOverview })));
const EmployeeBuilder = lazy(() => import('./pages/EmployeeBuilder').then((m) => ({ default: m.EmployeeBuilder })));
const TeamMap = lazy(() => import('./pages/TeamMap').then((m) => ({ default: m.TeamMap })));
const Setup = lazy(() => import('./pages/Setup').then((m) => ({ default: m.Setup })));
const Marketplace = lazy(() => import('./pages/Marketplace').then((m) => ({ default: m.Marketplace })));
const TeamBuilder = lazy(() => import('./pages/TeamBuilder').then((m) => ({ default: m.TeamBuilder })));
const TeamSpace = lazy(() => import('./pages/TeamSpace').then((m) => ({ default: m.TeamSpace })));
const Evaluation = lazy(() => import('./pages/Evaluation').then((m) => ({ default: m.Evaluation })));
const Interview = lazy(() => import('./pages/Interview').then((m) => ({ default: m.Interview })));
// 模块 Arena：个性化对决（需求 → 同工种候选作答 → 双轨 Elo）
const ArenaPage = lazy(() => import('./pages/Arena/ArenaPage').then((m) => ({ default: m.ArenaPage })));
const Office = lazy(() => import('./pages/Office').then((m) => ({ default: m.Office })));
// 会话页：左侧全高会话列表（团队房间/任务会话/Agent 会话分组）+ 右侧聊天区
const Chats = lazy(() => import('./pages/Chats').then((m) => ({ default: m.Chats })));
import { useSettingsStore } from './stores/settings';
import { initLlmUsageReporting } from './services/llmUsage';

// 成本看板：把 LLM 用量上报器注入 realExecutor（幂等，采集失败静默）
initLlmUsageReporting();
import { useGatewayStore } from './stores/gateway';
import { isBrowserPreviewMode } from './lib/browser-preview';
import { seedOfficePreviewData } from './lib/office-preview-seed';


/**
 * Error Boundary to catch and display React rendering errors
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React Error Boundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          color: '#f87171',
          background: '#0f172a',
          minHeight: '100vh',
          fontFamily: 'monospace'
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '16px' }}>Something went wrong</h1>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: '#1e293b',
            padding: '16px',
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const initSettings = useSettingsStore((state) => state.init);
  const theme = useSettingsStore((state) => state.theme);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const language = useSettingsStore((state) => state.language);
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const initGateway = useGatewayStore((state) => state.init);
  const [settingsInitialized, setSettingsInitialized] = useState(false);
  const browserPreviewMode = isBrowserPreviewMode();

  // Web 预览模式：注入种子 agent + 评估档案，让人才市集 / 绩效考核 /
  // Agent Office 有可展示数据（Electron 桌面端不受影响）。
  useEffect(() => {
    if (browserPreviewMode) {
      seedOfficePreviewData();
    }
  }, [browserPreviewMode]);

  useEffect(() => {
    let active = true;
    const initApp = async () => {
      try {
        await initSettings();
      } catch (error) {
        console.error('Failed to initialize settings:', error);
      } finally {
        if (active) {
          setSettingsInitialized(true);
        }
      }
    };
    initApp();
    return () => {
      active = false;
    };
  }, [initSettings]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    const initGatewayConnection = async () => {
      try {
        await initGateway();
      } catch (error) {
        console.error('Failed to initialize gateway:', error);
      }
    };
    initGatewayConnection();
  }, [initGateway]);

  useEffect(() => {
    if (!settingsInitialized || browserPreviewMode) {
      return;
    }
    if (!setupComplete && !location.pathname.startsWith('/setup')) {
      navigate('/setup', { replace: true });
    }
  }, [browserPreviewMode, location.pathname, navigate, settingsInitialized, setupComplete]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const unsubscribe = window.electron?.ipcRenderer?.on?.('navigate', handleNavigate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [navigate]);

  // Apply accent color CSS variables (--ac for hex, --ac-rgb for Tailwind opacity modifiers)
  useEffect(() => {
    const color = accentColor || '#007aff';
    document.documentElement.style.setProperty('--ac', color);
    // Parse hex to RGB channel format: "R G B"
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      document.documentElement.style.setProperty('--ac-rgb', `${r} ${g} ${b}`);
    }
  }, [accentColor]);

  // Apply theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <Suspense fallback={<div className="flex h-screen items-center justify-center gap-2 text-[13px] text-[#8e8e93]"><div className="h-4 w-4 animate-spin rounded-full border-2 border-[#8e8e93] border-t-transparent" />加载中...</div>}>
        <Routes>
          {/* Setup wizard (shown on first launch) */}
          <Route path="/setup/*" element={<Setup />} />

          {/* Main application routes */}
          <Route element={<MainLayout />}>
            <Route index element={<Chat />} />
            <Route path="chats" element={<Chats />} />
            <Route path="models" element={<Navigate to="/settings?section=models-providers" replace />} />
            <Route path="agents" element={<Agents />} />
            <Route path="agents/:agentId" element={<AgentDetail />} />
            <Route path="team-overview" element={<TeamOverview />} />
            <Route path="employee-builder" element={<EmployeeBuilder />} />
            <Route path="team-builder" element={<TeamBuilder />} />
            <Route path="team-space/:teamId" element={<TeamSpace />} />
            <Route path="team-map/:teamId" element={<TeamMap />} />
            <Route path="team-map" element={<Navigate to="/team-overview" replace />} />
            <Route path="marketplace" element={<Marketplace />} />
            <Route path="interview" element={<Interview />} />
            <Route path="arena" element={<ArenaPage />} />
            <Route path="evaluation" element={<Evaluation />} />
            <Route path="office" element={<Office />} />
            {/* 任务看板并入办公室视图：任务卡、执行时间线与审批入口集中在一处 */}
            <Route path="kanban" element={<Navigate to="/office" replace />} />
            {/* /memory 已迁移至 Settings > 记忆与知识 */}
            <Route path="memory" element={<Navigate to="/settings?section=memory-knowledge" replace />} />
            <Route path="costs" element={<Navigate to="/settings?section=costs-usage" replace />} />
            <Route path="llm-costs" element={<Navigate to="/settings?section=costs-usage" replace />} />
            <Route path="settings/*" element={<Settings />} />
          </Route>
        </Routes>
        </Suspense>

        {/* 首次启动的业务动线引导：环境配置完成后出现一次，讲清 雇人 → 面试 → 评估 */}
        {settingsInitialized && !browserPreviewMode && <FirstRunGuide />}

        {/* Global toast notifications */}
        <AppToaster />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
