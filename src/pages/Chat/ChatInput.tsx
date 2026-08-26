/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { SendHorizontal, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  buildConversationExportFileName,
  buildConversationMarkdownExport,
  encodeUtf8ToBase64,
} from '@/lib/chat-session-export';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useSettingsStore } from '@/stores/settings';
import { useProviderStore } from '@/stores/providers';
import type { AgentSummary } from '@/types/agent';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  buildLeaderOnlyBlockedMessage,
  isLeaderOnlyAgent,
  resolveReportingLeader,
} from '@/lib/team-chat-access';
import { getChatInputSlashMatches, isSlashCommandPrefixInput, parseChatInputSlashCommand } from './slash-commands';

const CHAT_REQUEST_FILE_UPLOAD_EVENT = 'chat:request-file-upload';
const CHAT_UPLOAD_PENDING_KEY = 'agentcorp:pending-upload';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;        // disk path for gateway
  preview: string | null;    // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[], targetAgentId?: string | null, workingDir?: string | null) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  isEmpty?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────

export function ChatInput({ onSend, onStop, disabled = false, sending = false, isEmpty = false }: ChatInputProps) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const rawComposerDraft = useChatStore((s) => ('composerDraft' in s && typeof s.composerDraft === 'string' ? s.composerDraft : undefined));
  const rawSetComposerDraft = useChatStore((s) => ('setComposerDraft' in s && typeof s.setComposerDraft === 'function'
    ? s.setComposerDraft
    : undefined));
  const [localComposerDraft, setLocalComposerDraft] = useState(rawComposerDraft ?? '');
  const composerDraft = typeof rawComposerDraft === 'string' ? rawComposerDraft : localComposerDraft;
  const setComposerDraft = useCallback((value: string) => {
    if (rawSetComposerDraft) {
      rawSetComposerDraft(value);
    }
    setLocalComposerDraft(value);
  }, [rawSetComposerDraft]);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  // 弹层开关只被写入、不再被读取（选择器 UI 已下线），故省略取值绑定，仅保留 setter。
  const [, setFolderPopoverOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const agents = useAgentsStore((s) => s.agents);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const messages = useChatStore((s) => s.messages);
  const newSession = useChatStore((s) => s.newSession);
  const currentAgent = useMemo(
    () => agents.find((agent) => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const currentAgentName = currentAgent?.name ?? 'AgentCorp';
  const currentModelDisplay = currentAgent?.modelDisplay ?? defaultModel ?? 'Not configured';

  // Model selector
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const providerAccounts = useProviderStore((s) => s.accounts);
  const providerVendors = useProviderStore((s) => s.vendors);
  const updateAgent = useAgentsStore((s) => s.updateAgent);
  const modelOptions = useMemo(() => {
    const vendorMap = new Map(providerVendors.map((v) => [v.id, v]));
    const options: Array<{ value: string; label: string }> = [];
    for (const account of providerAccounts) {
      if (!account.enabled) continue;
      const vendor = vendorMap.get(account.vendorId);
      const modelId = account.model || vendor?.defaultModelId;
      if (!modelId) continue;
      const value = `${account.vendorId}/${modelId}`;
      const label = `${vendor?.name || account.vendorId} / ${modelId}`;
      if (!options.some((o) => o.value === value)) {
        options.push({ value, label });
      }
    }
    return options;
  }, [providerAccounts, providerVendors]);
  const selectedTarget = useMemo(
    () => agents.find((agent) => agent.id === targetAgentId) ?? null,
    [agents, targetAgentId],
  );
  const showLeaderOnlyBlockedMessage = useCallback((agentId: string) => {
    const blockedAgent = agents.find((agent) => agent.id === agentId);
    if (!blockedAgent) {
      toast.error('No matching agent found.');
      return;
    }
    toast.error(buildLeaderOnlyBlockedMessage(blockedAgent, resolveReportingLeader(blockedAgent, agents)));
  }, [agents]);
  const slashMatches = useMemo(() => getChatInputSlashMatches(composerDraft), [composerDraft]);
  const showSlashMenu = useMemo(
    () => isSlashCommandPrefixInput(composerDraft) && slashMatches.length > 0,
    [composerDraft, slashMatches.length],
  );
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const activeSlashCommand = showSlashMenu
    ? (slashMatches[Math.min(slashActiveIndex, slashMatches.length - 1)] ?? null)
    : null;

  useEffect(() => {
    if (typeof rawComposerDraft === 'string') {
      setLocalComposerDraft(rawComposerDraft);
    }
  }, [rawComposerDraft]);

  const applySlashCompletion = useCallback((commandName: string) => {
    setComposerDraft(`${commandName} `);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [setComposerDraft]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [composerDraft]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (!targetAgentId) return;
    if (targetAgentId === currentAgentId) {
      setTargetAgentId(null);
      setPickerOpen(false);
      return;
    }
    if (!agents.some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(null);
      setPickerOpen(false);
    }
  }, [agents, currentAgentId, targetAgentId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [pickerOpen]);

  // ── File staging via native dialog ─────────────────────────────

  const pickFiles = useCallback(async () => {
    try {
      const result = await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      }) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;

      // Add placeholder entries immediately
      const tempIds: string[] = [];
      for (const filePath of result.filePaths) {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        setAttachments(prev => [...prev, {
          id: tempId,
          fileName,
          mimeType: '',
          fileSize: 0,
          stagedPath: '',
          preview: null,
          status: 'staging' as const,
        }]);
      }

      // Stage all files via IPC
      const staged = await hostApiFetch<Array<{
        id: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        stagedPath: string;
        preview: string | null;
      }>>('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: result.filePaths }),
      });
      // Update each placeholder with real data
      setAttachments(prev => {
        let updated = [...prev];
        for (let i = 0; i < tempIds.length; i++) {
          const tempId = tempIds[i];
          const data = staged[i];
          if (data) {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...data, status: 'ready' as const }
                : a,
            );
          } else {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...a, status: 'error' as const, error: 'Staging failed' }
                : a,
            );
          }
        }
        return updated;
      });
    } catch (err) {
      // Silently fail — attachments already marked as 'error' above
      // Mark any stuck 'staging' attachments as 'error' so the user can remove them
      // and the send button isn't permanently blocked
      setAttachments(prev => prev.map(a =>
        a.status === 'staging'
          ? { ...a, status: 'error' as const, error: String(err) }
          : a,
      ));
    }
  }, []);

  useEffect(() => {
    const consumePendingUpload = () => {
      try {
        const pendingUpload = sessionStorage.getItem(CHAT_UPLOAD_PENDING_KEY);
        if (pendingUpload === '1') {
          sessionStorage.removeItem(CHAT_UPLOAD_PENDING_KEY);
          void pickFiles();
        }
      } catch {
        // ignore storage read errors
      }
    };

    consumePendingUpload();

    const onRequestUpload = () => {
      void pickFiles();
    };
    window.addEventListener(CHAT_REQUEST_FILE_UPLOAD_EVENT, onRequestUpload);
    return () => {
      window.removeEventListener(CHAT_REQUEST_FILE_UPLOAD_EVENT, onRequestUpload);
    };
  }, [pickFiles]);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachments(prev => [...prev, {
        id: tempId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        stagedPath: '',
        preview: null,
        status: 'staging' as const,
      }]);

      try {
        const base64 = await readFileAsBase64(file);
        const staged = await hostApiFetch<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>('/api/files/stage-buffer', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        setAttachments(prev => prev.map(a =>
          a.id === tempId ? { ...staged, status: 'ready' as const } : a,
        ));
      } catch (err) {
        // Silently fail — attachment already marked as 'error'
        setAttachments(prev => prev.map(a =>
          a.id === tempId
            ? { ...a, status: 'error' as const, error: String(err) }
            : a,
        ));
      }
    }
  }, []);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const canSend = (composerDraft.trim() || attachments.length > 0) && allReady && !disabled && !sending;
  const canStop = sending && !disabled && !!onStop;

  const executeLocalSlashCommand = useCallback((rawInput: string): boolean => {
    const parsed = parseChatInputSlashCommand(rawInput);
    if (!parsed) return false;

    switch (parsed.command.key) {
      case 'new': {
        newSession();
        setComposerDraft('');
        setAttachments([]);
        setTargetAgentId(null);
        setPickerOpen(false);
        setWorkingDirectory(null);
        setFolderPopoverOpen(false);
        setSlashActiveIndex(0);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return true;
      }
      case 'stop': {
        if (canStop) {
          onStop?.();
        } else {
          toast.info('No active run to stop.');
        }
        setComposerDraft('');
        return true;
      }
      case 'agent': {
        const query = parsed.args.trim();
        if (!query) {
          setPickerOpen(true);
          setComposerDraft('');
          return true;
        }
        const normalizedQuery = query.toLowerCase();
        if (normalizedQuery === 'clear' || normalizedQuery === 'none' || normalizedQuery === 'off') {
          setTargetAgentId(null);
          setPickerOpen(false);
          setComposerDraft('');
          return true;
        }

        const exactMatch = agents.find((agent) => (
          agent.id.toLowerCase() === normalizedQuery || agent.name.toLowerCase() === normalizedQuery
        ));
        const fuzzyMatch = agents.find((agent) => (
          agent.id !== currentAgentId
          && (
            agent.id.toLowerCase().includes(normalizedQuery)
            || agent.name.toLowerCase().includes(normalizedQuery)
          )
        ));
        const match = exactMatch ?? fuzzyMatch;
        if (!match || match.id === currentAgentId) {
          toast.error(`No matching agent found for "${query}".`);
          return true;
        }
        if (isLeaderOnlyAgent(match)) {
          showLeaderOnlyBlockedMessage(match.id);
          setTargetAgentId(null);
          setPickerOpen(false);
          setComposerDraft('');
          return true;
        }

        setTargetAgentId(match.id);
        setPickerOpen(false);
        setComposerDraft('');
        return true;
      }
      case 'cwd': {
        const query = parsed.args.trim();
        if (!query) {
          setFolderPopoverOpen(true);
          setComposerDraft('');
          return true;
        }
        const normalizedQuery = query.toLowerCase();
        if (normalizedQuery === 'clear' || normalizedQuery === 'none' || normalizedQuery === 'off') {
          setWorkingDirectory(null);
          setComposerDraft('');
          return true;
        }
        setWorkingDirectory(query);
        setFolderPopoverOpen(false);
        setComposerDraft('');
        return true;
      }
      case 'help': {
        setComposerDraft('/');
        setSlashActiveIndex(0);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
        return true;
      }
      case 'memory': {
        navigate('/settings?section=memory-knowledge');
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'cron': {
        navigate('/team-overview');
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'settings': {
        navigate('/settings');
        setComposerDraft('');
        setSlashActiveIndex(0);
        return true;
      }
      case 'clear': {
        newSession();
        setComposerDraft('');
        setAttachments([]);
        setTargetAgentId(null);
        setPickerOpen(false);
        setWorkingDirectory(null);
        setFolderPopoverOpen(false);
        setSlashActiveIndex(0);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return true;
      }
      case 'export': {
        setComposerDraft('');
        setSlashActiveIndex(0);
        if (messages.length === 0) {
          toast.info('No conversation messages to export yet.');
          return true;
        }

        const markdown = buildConversationMarkdownExport(messages, currentSessionKey);
        const base64 = encodeUtf8ToBase64(markdown);
        const defaultFileName = buildConversationExportFileName(currentSessionKey);
        void hostApiFetch<{ success?: boolean; savedPath?: string; error?: string }>('/api/files/save-image', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            mimeType: 'text/markdown',
            defaultFileName,
          }),
        })
          .then((result) => {
            if (result?.success) {
              toast.success(result.savedPath ? `Exported to ${result.savedPath}` : 'Conversation exported.');
              return;
            }
            if (result?.error) {
              toast.info(`Export canceled: ${result.error}`);
              return;
            }
            toast.info('Export canceled.');
          })
          .catch((error) => {
            toast.error(`Failed to export conversation: ${String(error)}`);
          });
        return true;
      }
      default:
        return false;
    }
  }, [agents, canStop, currentAgentId, currentSessionKey, messages, navigate, newSession, onStop, setComposerDraft, showLeaderOnlyBlockedMessage]);

  const handleSend = useCallback(() => {
    if (executeLocalSlashCommand(composerDraft)) return;
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    // Capture values before clearing — clear composer draft immediately for snappy UX,
    // but keep attachments available for the async send
    const textToSend = composerDraft.trim();
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    setComposerDraft('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(textToSend, attachmentsToSend, targetAgentId, workingDirectory);
    setTargetAgentId(null);
    setPickerOpen(false);
    setWorkingDirectory(null);
  }, [attachments, canSend, executeLocalSlashCommand, composerDraft, onSend, setComposerDraft, targetAgentId, workingDirectory]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlashMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSlashActiveIndex((prev) => {
          if (slashMatches.length === 0) return 0;
          if (e.key === 'ArrowDown') {
            return (prev + 1) % slashMatches.length;
          }
          return (prev - 1 + slashMatches.length) % slashMatches.length;
        });
        return;
      }
      if (showSlashMenu && e.key === 'Tab' && activeSlashCommand) {
        e.preventDefault();
        applySlashCompletion(activeSlashCommand.name);
        return;
      }
      if (e.key === 'Backspace' && !composerDraft && targetAgentId) {
        setTargetAgentId(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        if (showSlashMenu && activeSlashCommand) {
          const normalizedInput = composerDraft.trim();
          if (normalizedInput === activeSlashCommand.name && !activeSlashCommand.argsHint) {
            handleSend();
            return;
          }
          applySlashCompletion(activeSlashCommand.name);
          return;
        }
        handleSend();
      }
    },
    [activeSlashCommand, applySlashCompletion, handleSend, composerDraft, showSlashMenu, slashMatches.length, targetAgentId],
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles],
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) {
        stageBufferFiles(Array.from(e.dataTransfer.files));
      }
    },
    [stageBufferFiles],
  );

  return (
    <div
      data-testid="chat-input-frame"
      className={cn('chat-input-frame flex w-full justify-center px-3 pb-4 sm:px-8 sm:pb-8', isEmpty ? 'chat-input-layout-empty' : 'chat-input-layout-active')}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full max-w-full">
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-3 flex-wrap">
            {attachments.map((att) => (
              <AttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Input Row */}
        <div
          data-testid="chat-composer-shell"
          className={cn(
            'chat-composer-shell relative overflow-hidden rounded-[24px] border transition-all duration-200',
            'bg-[#f2f2f7] dark:bg-card/95',
            dragOver
              ? 'border-primary/60 ring-2 ring-primary/25'
              : 'border-transparent',
            'focus-within:border-[#d1d1d1] focus-within:bg-white focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
          )}
        >
          {(selectedTarget || workingDirectory) && (
            <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2 pb-1">
              {selectedTarget && (
                <button
                  type="button"
                  onClick={() => setTargetAgentId(null)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-primary/15"
                  title={t('composer.clearTarget')}
                >
                  <span>{t('composer.targetChip', { agent: selectedTarget.name })}</span>
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
              {workingDirectory && (
                <button
                  type="button"
                  onClick={() => setWorkingDirectory(null)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[13px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15"
                  title={workingDirectory}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span className="max-w-[160px] truncate">
                    {workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? workingDirectory}
                  </span>
                  <X className="h-3 w-3 opacity-70" />
                </button>
              )}
            </div>
          )}

          {showSlashMenu && (
            <div
              data-testid="chat-slash-menu"
              className="mx-3 mt-2 mb-1 overflow-hidden rounded-2xl border border-black/[0.08] bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
            >
              {slashMatches.map((command, index) => (
                <button
                  key={command.key}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[12px] transition-colors',
                    index === slashActiveIndex ? 'bg-[#f2f2f7]' : 'hover:bg-[#f7f7fa]',
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => applySlashCompletion(command.name)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold text-foreground">{command.name}</span>
                    {command.argsHint && (
                      <span className="text-[#8e8e93]">{command.argsHint}</span>
                    )}
                  </div>
                  <span className="truncate text-[#8e8e93]">{command.description}</span>
                </button>
              ))}
            </div>
          )}

          <div data-testid="chat-composer-toolbar" className="chat-composer-toolbar relative flex flex-wrap items-end gap-2.5 py-2.5 pl-[14px] pr-[12px] sm:flex-nowrap sm:pl-[18px] sm:pr-[14px]">
            {/* Attach Button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-[30px] w-[30px] shrink-0 rounded-full bg-transparent text-[#3c3c43] transition-colors hover:bg-[#e5e5ea] hover:text-black"
              onClick={pickFiles}
              disabled={disabled || sending}
              title={t('composer.attachFiles')}
            >
              <Paperclip className="h-4 w-4" />
            </Button>

            {/* Textarea */}
            <div className="flex-1 relative">
              <Textarea
                ref={textareaRef}
                value={composerDraft}
                onChange={(e) => setComposerDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                placeholder={`给 ${currentAgentName ?? 'AgentCorp'} 发消息...`}
                aria-label={`给 ${currentAgentName ?? 'AgentCorp'} 发消息`}
                disabled={disabled}
                className="min-h-[22px] max-h-[200px] resize-none border-0 bg-transparent px-0 py-0 text-[14px] leading-[22px] text-black placeholder:text-[#8e8e93] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:text-white"
                rows={1}
              />
            </div>

            {/* Model Pill */}
            <div className="relative" ref={modelPickerRef}>
              <button
                type="button"
                data-testid="chat-composer-model-pill"
                className="flex shrink-0 items-center gap-1 rounded-full border border-black/10 bg-white px-2.5 py-1 text-[12px] text-[#3c3c43] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-black/20 hover:bg-[#f9f9f9]"
                onClick={() => setModelPickerOpen((v) => !v)}
              >
                <span className={cn('h-[6px] w-[6px] rounded-full', currentModelDisplay === 'Not configured' ? 'bg-[#f59e0b]' : 'bg-[#10b981]')} />
                <span className="max-w-[140px] truncate font-medium">{currentModelDisplay}</span>
                <span className="text-[#8e8e93]">▾</span>
              </button>

              {modelPickerOpen && createPortal(
                <ModelPickerDropdown
                  anchorRef={modelPickerRef}
                  modelOptions={modelOptions}
                  currentAgent={currentAgent}
                  onSelect={async (model) => {
                    if (currentAgent) {
                      await updateAgent(currentAgent.id, { model });
                    }
                    setModelPickerOpen(false);
                  }}
                  onClose={() => setModelPickerOpen(false)}
                />,
                document.body,
              )}
            </div>

            {/* Send Button */}
            <Button
              onClick={sending ? handleStop : handleSend}
              disabled={sending ? !canStop : !canSend}
              size="icon"
              className={`h-[30px] w-[30px] shrink-0 rounded-full transition-opacity ${
                (sending || canSend)
                  ? 'bg-[#10b981] text-white hover:bg-[#059669]'
                  : 'text-muted-foreground/50 hover:bg-transparent bg-transparent'
              }`}
              variant="ghost"
              title={sending ? t('composer.stop') : t('composer.send')}
              aria-label={sending ? t('composer.stop') : t('composer.send')}
            >
              {sending ? (
                <Square className="h-4 w-4" fill="currentColor" />
              ) : (
                <SendHorizontal className="h-[16px] w-[16px]" strokeWidth={2} />
              )}
            </Button>
          </div>

        </div>

        <div
          data-testid="chat-composer-footer"
          className="chat-composer-footer mt-2 px-2 text-center text-[11px] text-[#8e8e93] sm:px-0"
        >
          <span>Agent 在本地安全运行 · 由 AI 模型生成内容</span>
        </div>
      </div>
    </div>
  );
}

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: FileAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith('image/') && attachment.preview;

  return (
    <div className="relative group rounded-lg overflow-hidden border border-border">
      {isImage ? (
        // Image thumbnail
        <div className="w-16 h-16">
          <img
            src={attachment.preview!}
            alt={attachment.fileName}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        // Generic file card
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 max-w-[200px]">
          <FileIcon mimeType={attachment.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 overflow-hidden">
            <p className="text-xs font-medium truncate">{attachment.fileName}</p>
            <p className="text-[10px] text-muted-foreground">
              {attachment.fileSize > 0 ? formatFileSize(attachment.fileSize) : '...'}
            </p>
          </div>
        </div>
      )}

      {/* Staging overlay */}
      {attachment.status === 'staging' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Loader2 className="h-4 w-4 text-white animate-spin" />
        </div>
      )}

      {/* Error overlay */}
      {attachment.status === 'error' && (
        <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center">
          <span className="text-[10px] text-destructive font-medium px-1">Error</span>
        </div>
      )}

      {/* Remove button */}
      <button
        onClick={onRemove}
        className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Model Picker Dropdown (portal) ──────────────────────────────

function ModelPickerDropdown({
  anchorRef,
  modelOptions,
  currentAgent,
  onSelect,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  modelOptions: Array<{ value: string; label: string }>;
  currentAgent: AgentSummary | null;
  onSelect: (model: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pos, setPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.top - 8,
      right: window.innerWidth - rect.right,
    });
  }, [anchorRef]);

  return (
    <div className="fixed inset-0 z-[200]" onMouseDown={onClose}>
      <div
        className="fixed z-[201] w-[260px] max-h-[320px] overflow-y-auto rounded-xl border border-black/10 bg-white py-1 shadow-xl"
        style={{ top: pos.top, right: pos.right, transform: 'translateY(-100%)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#8e8e93]">选择模型</div>
        {modelOptions.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-[#8e8e93]">
            暂无可用模型，请先在设置中配置 AI 服务商
          </div>
        ) : (
          <>
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]',
                (currentAgent?.inheritedModel || !currentAgent?.model) && 'text-agentcorp-ac font-medium',
              )}
              onClick={() => void onSelect('')}
            >
              <span className="truncate">继承默认模型</span>
              {(currentAgent?.inheritedModel || !currentAgent?.model) && <span className="ml-auto text-agentcorp-ac">✓</span>}
            </button>
            <div className="mx-3 border-t border-black/[0.06]" />
            {modelOptions.map((opt) => {
              const isActive = currentAgent?.model === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#f2f2f7]',
                    isActive && 'text-agentcorp-ac font-medium',
                  )}
                  onClick={() => void onSelect(opt.value)}
                >
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {isActive && <span className="shrink-0 text-agentcorp-ac">✓</span>}
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
