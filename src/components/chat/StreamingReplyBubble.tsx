/**
 * src/components/chat/StreamingReplyBubble.tsx
 * leader/成员回复的流式气泡（Knowe S24 形态）：名字行下方是可折叠的
 * 「∞ AI 推理中…」面板，正文随 onDelta 逐段出现，末尾带闪烁光标
 * （光标样式复用 ChatMessage 的流式光标）。final 落房间后本气泡被移除，
 * 由正式消息气泡取代（替换逻辑在 TeamChatView）。
 */
import { useState } from 'react';
import { ChevronDown, Infinity as InfinityIcon } from 'lucide-react';
import { AgentAvatar } from '@/components/chat/AgentAvatar';

export function StreamingReplyBubble({
  name,
  role,
  avatar,
  text,
}: {
  name: string;
  role?: string;
  avatar?: string | null;
  /** 已累积的回复文本（空串 = 还没拿到首段，显示三点动画） */
  text: string;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div data-testid="streaming-reply" className="flex items-start gap-2.5">
      <AgentAvatar
        avatar={avatar}
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[16px]"
      />
      <div className="min-w-0 max-w-[78%]">
        <div className="mb-1 flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-foreground">{name}</span>
          {role && <span className="text-muted-foreground">· {role}</span>}
        </div>
        <div className="rounded-2xl rounded-tl-md border border-black/[0.06] bg-white px-3.5 py-2.5 shadow-sm">
          <button
            type="button"
            aria-label={expanded ? '折叠推理面板' : '展开推理面板'}
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1.5 text-left text-[11.5px] font-semibold text-muted-foreground"
          >
            <InfinityIcon className="h-3.5 w-3.5" style={{ color: '#b8860b' }} />
            AI 推理中…
            <span className="text-[10px] font-normal">{expanded ? '可折叠' : '可展开'}</span>
            <ChevronDown
              className={`ml-auto h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
          {expanded && (
            <div className="mt-1.5 text-[13px] leading-relaxed text-foreground">
              {text ? (
                <>
                  {text}
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/50 align-middle" />
                </>
              ) : (
                <span className="flex gap-1 py-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: '0ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: '150ms' }} />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: '300ms' }} />
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default StreamingReplyBubble;
