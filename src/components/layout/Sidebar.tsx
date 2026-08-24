import { useEffect, useState } from 'react';
import {
  BarChart3,
  Building2,
  HelpCircle,
  Home,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  Search,
  Settings as SettingsIcon,
  Store,
  Swords,
  Users,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GlobalSearchModal } from '@/components/search/GlobalSearchModal';
import { SessionSearchModal } from '@/components/sessions/SessionSearchModal';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { resolveSessionDisplayLabel } from '@/lib/session-label';

const NICKNAME_STORAGE_KEY = 'agentcorp-user-nickname';
const LEGACY_NICKNAME_STORAGE_KEY = 'clawx-user-nickname';
const AVATAR_STORAGE_KEY = 'agentcorp-user-avatar';
const LEGACY_AVATAR_STORAGE_KEY = 'clawx-user-avatar';

type NavItemConfig = {
  label: string;
  path: string;
  icon: typeof LayoutDashboard;
};

function NavItem({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItemConfig;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <button
      type="button"
      aria-label={item.label}
      onClick={onClick}
      className={cn(
        'flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-sm font-bold transition-all duration-300',
        active
          ? 'bg-[#FFD233] text-[#1A1C1E] shadow-md'
          : 'text-[var(--neu-ink)] hover:bg-white hover:text-[#1A1C1E]',
        collapsed && 'justify-center px-2',
      )}
    >
      <Icon className="h-[22px] w-[22px] shrink-0" strokeWidth={1.5} />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </button>
  );
}

export function Sidebar() {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const openGuide = useSettingsStore((state) => state.openGuide);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const gatewayStatus = useGatewayStore((state) => state.status);

  const sessions = useChatStore((state) => state.sessions);
  useChatStore.getState(); // ensure chat store is initialized
  const switchSession = useChatStore((state) => state.switchSession);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const loadHistory = useChatStore((state) => state.loadHistory);

  const agents = useAgentsStore((state) => state.agents);
  const fetchAgents = useAgentsStore((state) => state.fetchAgents);

  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [avatarPopupOpen, setAvatarPopupOpen] = useState(false);
  const [nickname, setNickname] = useState(() => {
    try {
      const current = localStorage.getItem(NICKNAME_STORAGE_KEY);
      if (current) return current;
      const legacy = localStorage.getItem(LEGACY_NICKNAME_STORAGE_KEY);
      if (legacy) {
        localStorage.setItem(NICKNAME_STORAGE_KEY, legacy);
        localStorage.removeItem(LEGACY_NICKNAME_STORAGE_KEY);
        return legacy;
      }
    } catch {
      // ignore storage access issues
    }
    return 'Administrator';
  });
  const [selectedAvatar, setSelectedAvatar] = useState(() => {
    try {
      const current = localStorage.getItem(AVATAR_STORAGE_KEY);
      if (current) return current;
      const legacy = localStorage.getItem(LEGACY_AVATAR_STORAGE_KEY);
      if (legacy) {
        localStorage.setItem(AVATAR_STORAGE_KEY, legacy);
        localStorage.removeItem(LEGACY_AVATAR_STORAGE_KEY);
        return legacy;
      }
    } catch {
      // ignore storage access issues
    }
    return '👤';
  });

  const tSidebar = (key: string, defaultValue?: string) =>
    t(`common:sidebar.${key}`, { defaultValue });

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (gatewayStatus.state !== 'running') return;
    void loadSessions();
    void loadHistory(true);
  }, [gatewayStatus.state, loadHistory, loadSessions]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navItems: NavItemConfig[] = [
    // 首页（空状态渲染在 Chat 页，对应路由 index = "/"，故跳转 "/"）
    {
      label: tSidebar('home', 'Home'),
      path: '/',
      icon: Home,
    },
    // 会话页：全高会话列表（团队房间/任务会话/Agent 会话）
    {
      label: tSidebar('chats', '会话'),
      path: '/chats',
      icon: MessageSquare,
    },
    {
      label: tSidebar('marketplace', 'Marketplace'),
      path: '/marketplace',
      icon: Store,
    },
    {
      label: tSidebar('humanAssets', 'Human Assets'),
      path: '/team-overview',
      icon: Users,
    },
    // {
    //   label: tSidebar('employeeSquare', 'Employee square'),
    //   path: '/agents',
    //   icon: Bot,
    // },
    // 任务看板（kanban）
    {
      label: tSidebar('taskBoard', 'Task board'),
      path: '/kanban',
      icon: LayoutDashboard,
    },
    // HR 面试：位于市场初审与评估中心之间
    {
      label: tSidebar('interview', 'Interview'),
      path: '/interview',
      icon: MessagesSquare,
    },
    {
      label: tSidebar('evaluation', '评估中心'),
      path: '/evaluation',
      icon: BarChart3,
    },
    {
      label: tSidebar('office', 'Agent Office'),
      path: '/office',
      icon: Building2,
    },
    // 模块 Arena：个性化对决（需求 → 同工种候选作答 → 双轨 Elo）
    {
      label: tSidebar('arena', 'Arena 对决'),
      path: '/arena',
      icon: Swords,
    },
  ];

  const searchSessionsData = sessions.map((session) => ({
    key: session.key,
    label: resolveSessionDisplayLabel(session, agents),
  }));

  const searchAgents = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    mainSessionKey: agent.mainSessionKey,
    modelDisplay: agent.modelDisplay,
    chatAccess: agent.chatAccess,
    reportsTo: agent.reportsTo,
    isDefault: agent.isDefault,
  }));

  return (
    <aside
      className={cn(
        'relative z-30 flex shrink-0 flex-col bg-[var(--neu-surface)] transition-all duration-300',
        sidebarCollapsed ? 'w-16 px-2 py-4' : 'w-[260px] px-3 py-4',
      )}
    >
      <div className={cn('flex items-center gap-2', sidebarCollapsed ? 'justify-center' : 'justify-between')}>
        <button
          type="button"
          aria-label={tSidebar('toggleSidebar', 'Toggle sidebar')}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/50 text-[var(--neu-ink-soft)] shadow-sm transition-all hover:bg-white hover:text-[#1A1C1E] hover:shadow-md"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </button>
        {!sidebarCollapsed && (
          <button
            type="button"
            aria-label={tSidebar('searchSessions', 'Search sessions')}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/50 text-[var(--neu-ink-soft)] shadow-sm transition-all hover:bg-white hover:text-[#1A1C1E] hover:shadow-md"
            onClick={() => setSessionSearchOpen(true)}
          >
            <Search className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className={cn(
        'mt-4 space-y-1 rounded-[32px] border border-white/40 bg-white/50 p-3 shadow-sm backdrop-blur-md',
        sidebarCollapsed && 'rounded-2xl p-2',
      )}>
        {navItems.map((item) => (
          <NavItem
            key={item.path}
            item={item}
            active={location.pathname === item.path}
            collapsed={sidebarCollapsed}
            onClick={() => navigate(item.path)}
          />
        ))}
      </div>

      {/* 会话列表已迁至独立「会话」页（/chats），侧栏不再内嵌 */}

      <div className="mt-auto pt-3">
        {/* User Info Section */}
        <div className="flex h-[56px] shrink-0 items-center gap-3 rounded-2xl px-4 transition-all hover:bg-white/50">
          {!sidebarCollapsed && (
            <>
              <button
                type="button"
                aria-label={tSidebar('selectAvatar', 'Select avatar')}
                onClick={() => setAvatarPopupOpen(true)}
                className="h-10 w-10 shrink-0 rounded-xl bg-white/50 flex items-center justify-center text-[20px] shadow-sm transition-all hover:scale-110 hover:shadow-md"
              >
                {selectedAvatar}
              </button>
              <span className="flex-1 truncate text-[13px] font-bold text-[#1A1C1E]">{nickname}</span>
              <button
                type="button"
                aria-label={tSidebar('guide', '新手引导')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/50 text-[var(--neu-ink-soft)] shadow-sm transition-all hover:bg-white hover:text-[#1A1C1E] hover:shadow-md"
                onClick={() => openGuide()}
                title={tSidebar('guide', '新手引导')}
              >
                <HelpCircle className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label={tSidebar('settingsAria', 'Settings')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/50 text-[var(--neu-ink-soft)] shadow-sm transition-all hover:bg-white hover:text-[#1A1C1E] hover:shadow-md"
                onClick={() => navigate('/settings')}
                title={tSidebar('settings', 'Settings')}
              >
                <SettingsIcon className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </div>

      {avatarPopupOpen && (
        <AvatarPopup
          nickname={nickname}
          avatar={selectedAvatar}
          onNicknameChange={(v) => {
            setNickname(v);
            localStorage.setItem(NICKNAME_STORAGE_KEY, v);
            localStorage.removeItem(LEGACY_NICKNAME_STORAGE_KEY);
          }}
          onAvatarChange={(v) => {
            setSelectedAvatar(v);
            localStorage.setItem(AVATAR_STORAGE_KEY, v);
            localStorage.removeItem(LEGACY_AVATAR_STORAGE_KEY);
          }}
          onClose={() => setAvatarPopupOpen(false)}
        />
      )}

      {searchOpen ? (
        <GlobalSearchModal
          onOpenChange={setSearchOpen}
          sessions={searchSessionsData}
          agents={searchAgents}
          onSelectSession={(sessionKey) => switchSession(sessionKey)}
          onNavigate={(path) => navigate(path)}
        />
      ) : null}

      <SessionSearchModal
        isOpen={sessionSearchOpen}
        onClose={() => setSessionSearchOpen(false)}
      />
    </aside>
  );
}

const AVATAR_OPTIONS = [
  { emoji: '🐱', label: 'avatarCat' },
  { emoji: '🐶', label: 'avatarDog' },
  { emoji: '🦊', label: 'avatarFox' },
  { emoji: '🐻', label: 'avatarBear' },
  { emoji: '🐼', label: 'avatarPanda' },
  { emoji: '🐰', label: 'avatarRabbit' },
  { emoji: '🦁', label: 'avatarLion' },
  { emoji: '🐯', label: 'avatarTiger' },
  { emoji: '🐸', label: 'avatarFrog' },
];

function AvatarPopup({
  nickname,
  avatar,
  onNicknameChange,
  onAvatarChange,
  onClose,
}: {
  nickname: string;
  avatar: string;
  onNicknameChange: (v: string) => void;
  onAvatarChange: (v: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const tSidebar = (key: string, options?: Record<string, unknown>) => t(`sidebar.${key}`, options);
  const [selectedAvatar, setSelectedAvatar] = useState(avatar);
  const [draft, setDraft] = useState(nickname);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-start" onClick={onClose}>
      <div
        className="absolute bottom-[68px] left-3 w-[260px] overflow-hidden rounded-[24px] bg-white shadow-[0_20px_50px_rgba(0,0,0,0.12)] border border-white/40"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <span className="text-[14px] font-bold text-[#1A1C1E]">{tSidebar('profile')}</span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F2F0E9] text-[12px] text-gray-400 hover:bg-gray-200 hover:text-[#1A1C1E]"
          >
            ✕
          </button>
        </div>

        {/* Current avatar preview */}
        <div className="flex flex-col items-center py-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#F2F0E9] text-[36px] shadow-sm">
            {selectedAvatar}
          </div>
          <span className="mt-2 text-[14px] font-bold text-[#1A1C1E]">{draft || nickname}</span>
        </div>

        {/* Avatar grid */}
        <div className="grid grid-cols-3 gap-2 px-5 pb-3">
          {AVATAR_OPTIONS.map((opt) => (
            <button
              key={opt.emoji}
              type="button"
              onClick={() => setSelectedAvatar(opt.emoji)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-2xl py-2.5 text-[24px] transition-all',
                selectedAvatar === opt.emoji
                  ? 'bg-[#FFD233]/20 ring-2 ring-[#FFD233]/40 shadow-sm'
                  : 'hover:bg-[#F2F0E9]',
              )}
            >
              {opt.emoji}
              <span className="text-[10px] font-bold text-gray-400">{tSidebar(opt.label)}</span>
            </button>
          ))}
        </div>

        {/* Nickname input */}
        <div className="border-t border-gray-100 px-5 py-4">
          <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
            {tSidebar('nickname')}
          </label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={tSidebar('nicknamePlaceholder')}
            className="w-full rounded-2xl border border-gray-100 bg-[#F2F0E9]/50 px-4 py-2.5 text-[13px] font-bold text-[#1A1C1E] outline-none focus:border-[#FFD233] focus:ring-2 focus:ring-[#FFD233]/20 focus:bg-white"
          />
        </div>

        {/* Save button */}
        <div className="px-5 pb-5">
          <button
            type="button"
            onClick={() => {
              if (draft.trim()) onNicknameChange(draft.trim());
              onAvatarChange(selectedAvatar);
              onClose();
            }}
            className="w-full rounded-full bg-[#1A1C1E] py-3 text-[13px] font-bold text-white shadow-xl transition-all hover:scale-[1.02] hover:bg-[#FF6B4A]"
          >
            {t('common:actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
