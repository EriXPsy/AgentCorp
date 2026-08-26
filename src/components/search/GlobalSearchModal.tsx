import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { extractText } from '@/pages/Chat/message-utils';

export type SearchSessionItem = {
  key: string;
  label: string;
};

export type SearchAgentItem = {
  id: string;
  name: string;
  mainSessionKey: string;
  modelDisplay?: string;
  chatAccess?: 'direct' | 'leader_only';
  reportsTo?: string | null;
  isDefault?: boolean;
};

type SearchCategory = 'sessions' | 'agents' | 'pages';

type SearchResult = {
  id: string;
  label: string;
  subtitle?: string;
  category: SearchCategory;
  icon: string;
  action: () => void;
};

type StaticPageItem = {
  id: string;
  label: string;
  path: string;
  icon: string;
};

type SearchHistoryMessage = {
  role?: string;
  content?: unknown;
  text?: string;
};

type SearchHistoryResponse = {
  messages?: SearchHistoryMessage[];
};

type GatewayRpcEnvelope<T> = {
  success?: boolean;
  result?: T;
  error?: string;
};

type SearchHistoryEntry = {
  text: string;
  preview: string;
};

const STATIC_PAGE_ITEMS: StaticPageItem[] = [
  { id: 'home', label: 'Home', path: '/', icon: '✦' },
  { id: 'sessions', label: 'Sessions', path: '/chats', icon: '💬' },
  { id: 'marketplace', label: 'Marketplace', path: '/marketplace', icon: '🧭' },
  { id: 'workforce', label: 'Workforce', path: '/team-overview', icon: '👥' },
  { id: 'interview', label: 'Interview', path: '/interview', icon: '🗣️' },
  { id: 'evaluation', label: 'Evaluation', path: '/evaluation', icon: '📊' },
  { id: 'office', label: 'Office', path: '/office', icon: '🏢' },
  { id: 'memory', label: 'Memory & Knowledge', path: '/settings?section=memory-knowledge', icon: '🗂' },
  { id: 'costs', label: 'Costs & Usage', path: '/settings?section=costs-usage', icon: '💰' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: '⚙️' },
];

const CATEGORY_LABELS: Record<SearchCategory, string> = {
  sessions: 'SESSIONS',
  agents: 'AGENTS',
  pages: 'PAGES',
};

const MAX_PER_CATEGORY = 8;
const HISTORY_LIMIT = 50;
const HISTORY_CACHE = new Map<string, SearchHistoryEntry>();

export interface GlobalSearchModalProps {
  onOpenChange: (open: boolean) => void;
  sessions: SearchSessionItem[];
  agents: SearchAgentItem[];
  onSelectSession: (sessionKey: string) => void;
  onNavigate: (path: string) => void;
  onBlockedAgent?: (agent: SearchAgentItem) => void;
}

function matchSearch(query: string, value: string): boolean {
  if (!query) return true;
  return value.toLowerCase().includes(query);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function buildHistorySearchEntry(messages: SearchHistoryMessage[]): SearchHistoryEntry {
  const textParts = messages
    .map((message) => extractText(message))
    .map((value) => value.trim())
    .filter(Boolean);
  const joined = textParts.join('\n');
  return {
    text: joined.toLowerCase(),
    preview: joined,
  };
}

function buildPreviewSnippet(preview: string, query: string): string {
  if (!preview) return '';
  if (!query) return preview;

  const normalizedPreview = preview.toLowerCase();
  const matchIndex = normalizedPreview.indexOf(query);
  if (matchIndex === -1) {
    return preview.length > 90 ? `${preview.slice(0, 87)}...` : preview;
  }

  const start = Math.max(0, matchIndex - 24);
  const end = Math.min(preview.length, matchIndex + query.length + 48);
  const snippet = preview.slice(start, end).trim();
  const prefix = start > 0 ? '...' : '';
  const suffix = end < preview.length ? '...' : '';
  return `${prefix}${snippet}${suffix}`;
}

function unwrapHistoryResponse(
  response: SearchHistoryResponse | GatewayRpcEnvelope<SearchHistoryResponse> | null | undefined,
): SearchHistoryResponse {
  if (
    response
    && typeof response === 'object'
    && 'success' in response
    && typeof (response as GatewayRpcEnvelope<SearchHistoryResponse>).success === 'boolean'
  ) {
    return (response as GatewayRpcEnvelope<SearchHistoryResponse>).result ?? {};
  }
  return (response as SearchHistoryResponse | null | undefined) ?? {};
}

export function GlobalSearchModal({
  onOpenChange,
  sessions,
  agents,
  onSelectSession,
  onNavigate,
  onBlockedAgent,
}: GlobalSearchModalProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<Record<string, SearchHistoryEntry>>(() =>
    Object.fromEntries(HISTORY_CACHE.entries()),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sessionKeys = [...new Set([
      ...sessions.map((session) => session.key),
      ...agents.map((agent) => agent.mainSessionKey),
    ])].filter(Boolean);
    const missingKeys = sessionKeys.filter((sessionKey) => {
      const cached = HISTORY_CACHE.get(sessionKey);
      return !cached || cached.text.length === 0;
    });

    if (missingKeys.length === 0) return;

    void Promise.allSettled(
      missingKeys.map(async (sessionKey) => {
        const response = await invokeIpc<SearchHistoryResponse | GatewayRpcEnvelope<SearchHistoryResponse>>(
          'gateway:rpc',
          'chat.history',
          {
          sessionKey,
          limit: HISTORY_LIMIT,
          },
        );
        const history = unwrapHistoryResponse(response);
        HISTORY_CACHE.set(
          sessionKey,
          buildHistorySearchEntry(Array.isArray(history.messages) ? history.messages : []),
        );
      }),
    ).then(() => {
      if (!cancelled) {
        setHistoryIndex(Object.fromEntries(HISTORY_CACHE.entries()));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [agents, sessions]);

  const groupedResults = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const sessionResults = sessions
      .flatMap((session): SearchResult[] => {
        const history = historyIndex[session.key];
        const matchesLabel = matchSearch(normalizedQuery, session.label);
        const matchesHistory = matchSearch(normalizedQuery, history?.text ?? '');
        if (!matchesLabel && !matchesHistory) return [];

        return [{
          id: `session:${session.key}`,
          label: session.label,
          subtitle: matchesHistory && !matchesLabel
            ? buildPreviewSnippet(history?.preview ?? '', normalizedQuery)
            : undefined,
          category: 'sessions' as const,
          icon: '💬',
          action: () => {
            onSelectSession(session.key);
            onNavigate('/');
            onOpenChange(false);
          },
        }];
      })
      .slice(0, MAX_PER_CATEGORY);

    const agentResults = agents
      .flatMap((agent): SearchResult[] => {
        const searchableAgentLabel = `${agent.name} ${agent.modelDisplay ?? ''}`;
        const history = historyIndex[agent.mainSessionKey];
        const matchesLabel = matchSearch(normalizedQuery, searchableAgentLabel);
        const matchesHistory = matchSearch(normalizedQuery, history?.text ?? '');
        if (!matchesLabel && !matchesHistory) return [];

        return [{
          id: `agent:${agent.id}`,
          label: agent.name,
          subtitle: matchesHistory && !matchesLabel
            ? buildPreviewSnippet(history?.preview ?? '', normalizedQuery)
            : agent.modelDisplay,
          category: 'agents' as const,
          icon: '🤖',
          action: () => {
            if (agent.chatAccess === 'leader_only') {
              onBlockedAgent?.(agent);
              return;
            }
            onSelectSession(agent.mainSessionKey);
            onNavigate('/');
            onOpenChange(false);
          },
        }];
      })
      .slice(0, MAX_PER_CATEGORY);

    const pageResults: SearchResult[] = STATIC_PAGE_ITEMS
      .filter((page) => matchSearch(normalizedQuery, page.label))
      .slice(0, MAX_PER_CATEGORY)
      .map((page) => ({
        id: `page:${page.id}`,
        label: page.label,
        subtitle: page.path,
        category: 'pages' as const,
        icon: page.icon,
        action: () => {
          onNavigate(page.path);
          onOpenChange(false);
        },
      }));

    return {
      sessions: sessionResults,
      agents: agentResults,
      pages: pageResults,
    };
  }, [agents, historyIndex, onBlockedAgent, onNavigate, onOpenChange, onSelectSession, query, sessions]);

  const flatResults = useMemo(
    () => [...groupedResults.sessions, ...groupedResults.agents, ...groupedResults.pages],
    [groupedResults],
  );
  const safeActiveIndex = clamp(activeIndex, 0, Math.max(flatResults.length - 1, 0));

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (typeof active?.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [safeActiveIndex]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((previous) => clamp(previous + 1, 0, Math.max(flatResults.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((previous) => clamp(previous - 1, 0, Math.max(flatResults.length - 1, 0)));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      flatResults[safeActiveIndex]?.action();
    }
  };

  const renderGroup = (category: SearchCategory, offset: number) => {
    const items = groupedResults[category];
    if (items.length === 0) return null;

    return (
      <section key={category} className="px-2 pb-1">
        <h3 className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.5px] text-[#8e8e93]">
          {CATEGORY_LABELS[category]}
        </h3>
        {items.map((item, index) => {
          const currentIndex = offset + index;
          const isActive = currentIndex === safeActiveIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isActive}
              data-active={isActive}
              onMouseEnter={() => setActiveIndex(currentIndex)}
              onClick={item.action}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                isActive ? 'bg-[#e5e5ea]' : 'hover:bg-[#f2f2f7]',
              )}
            >
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-[14px]">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[#000000]">{item.label}</span>
                {item.subtitle ? (
                  <span className="block truncate text-[11px] text-[#8e8e93]">{item.subtitle}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </section>
    );
  };

  let offset = 0;
  const sessionOffset = offset;
  offset += groupedResults.sessions.length;
  const agentOffset = offset;
  offset += groupedResults.agents.length;
  const pageOffset = offset;

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          <Search className="h-4 w-4 text-[#8e8e93]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            aria-label="Search all"
            placeholder="Search sessions, agents, pages, and chat history..."
            className="w-full border-0 bg-transparent text-[14px] text-[#000000] outline-none placeholder:text-[#8e8e93]"
          />
          <kbd className="rounded border border-black/10 bg-[#f2f2f7] px-1.5 py-0.5 text-[10px] text-[#8e8e93]">Esc</kbd>
        </div>

        <div ref={listRef} role="listbox" aria-label="Search results" className="max-h-[420px] overflow-y-auto py-1">
          {flatResults.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-[#8e8e93]">No matching results</div>
          ) : (
            <>
              {renderGroup('sessions', sessionOffset)}
              {renderGroup('agents', agentOffset)}
              {renderGroup('pages', pageOffset)}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
