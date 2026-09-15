import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { normalizeAppError } from './error-model';
import { isBrowserPreviewMode } from './browser-preview';
import {
  isTaskApprovalMockPath,
  handleTaskApprovalMock,
} from './task-approval-preview-mock';

const HOST_API_PORT = 3210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;
const LOCALHOST_FALLBACK_FLAG = 'agentcorp:allow-localhost-fallback';
const LEGACY_LOCALHOST_FALLBACK_FLAG = 'clawx:allow-localhost-fallback';

// NOTE: Host API 会话 token 不再进入渲染进程（原 ipc 'hostapi:token' 已移除）——
// 渲染进程一旦 XSS，持有 token 即获 Host API 全权限。
// 普通请求走 hostApiFetch（ipc 代理），SSE 流走 hostApiStream（主进程拉流转发）。
// 浏览器直连回退路径（dev flag 开启的非 Electron 场景）改为无 token 访问，
// 只能命中无需鉴权的端点；这是有意的能力收缩。

type HostApiProxyResponse = {
  ok?: boolean;
  data?: {
    status?: number;
    ok?: boolean;
    json?: unknown;
    text?: string;
  };
  error?: { message?: string } | string;
  // backward compatibility fields
  success: boolean;
  status?: number;
  json?: unknown;
  text?: string;
};

type HostApiProxyData = {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
};

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function resolveProxyErrorMessage(error: HostApiProxyResponse['error']): string {
  return typeof error === 'string'
    ? error
    : (error?.message || 'Host API proxy request failed');
}

function parseUnifiedProxyResponse<T>(
  response: HostApiProxyResponse,
  path: string,
  method: string,
  startedAt: number,
): T {
  if (!response.ok) {
    throw new Error(resolveProxyErrorMessage(response.error));
  }

  const data: HostApiProxyData = response.data ?? {};
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy',
    durationMs: Date.now() - startedAt,
    status: data.status ?? 200,
  });

  if (data.status === 204) return undefined as T;
  if (data.ok === false) {
    const errorMsg = typeof data.json === 'object' && data.json !== null && 'error' in (data.json as Record<string, unknown>)
      ? String((data.json as Record<string, unknown>).error)
      : `HTTP ${data.status ?? 'unknown'}`;
    throw new Error(errorMsg);
  }
  if (data.json !== undefined) return data.json as T;
  return data.text as T;
}

function parseLegacyProxyResponse<T>(
  response: HostApiProxyResponse,
  path: string,
  method: string,
  startedAt: number,
): T {
  if (!response.success) {
    throw new Error(resolveProxyErrorMessage(response.error));
  }

  if (!response.ok) {
    const message = response.text
      || (typeof response.json === 'object' && response.json != null && 'error' in (response.json as Record<string, unknown>)
        ? String((response.json as Record<string, unknown>).error)
        : `HTTP ${response.status ?? 'unknown'}`);
    throw new Error(message);
  }

  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy-legacy',
    durationMs: Date.now() - startedAt,
    status: response.status ?? 200,
  });

  if (response.status === 204) return undefined as T;
  if (response.json !== undefined) return response.json as T;
  return response.text as T;
}

function shouldFallbackToBrowser(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('invalid ipc channel: hostapi:fetch')
    || normalized.includes("no handler registered for 'hostapi:fetch'")
    || normalized.includes('no handler registered for "hostapi:fetch"')
    || normalized.includes('no handler registered for hostapi:fetch')
    || normalized.includes('window is not defined');
}

function allowLocalhostFallback(): boolean {
  try {
    const flag = window.localStorage.getItem(LOCALHOST_FALLBACK_FLAG);
    if (flag === '1') {
      return true;
    }
    const legacyFlag = window.localStorage.getItem(LEGACY_LOCALHOST_FALLBACK_FLAG);
    if (legacyFlag === '1') {
      window.localStorage.setItem(LOCALHOST_FALLBACK_FLAG, '1');
      window.localStorage.removeItem(LEGACY_LOCALHOST_FALLBACK_FLAG);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isBrowserPreviewShimEnabled(): boolean {
  try {
    return Boolean(
      (window.electron as { __agentcorpBrowserPreviewShim?: boolean } | undefined)
        ?.__agentcorpBrowserPreviewShim,
    );
  } catch {
    return false;
  }
}

/**
 * 解析 Host API 基址：
 * - 浏览器预览 shim（同源 Web 部署，如统一算力环境 Web 形态）→ 当前源；
 * - 其余场景（Electron 回退 / 本地 dev）→ 本地 Host API（127.0.0.1:3210）。
 */
export function resolveHostApiBase(): string {
  if (isBrowserPreviewShimEnabled()) {
    try {
      return window.location.origin;
    } catch {
      // fall through：极端环境下退回本地 Host API
    }
  }
  return HOST_API_BASE;
}

type BrowserFetchMode = {
  source: 'browser-preview-shim' | 'browser-fallback';
};

function shouldAttachJsonContentType(method: string, body: BodyInit | null | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  return typeof body === 'string';
}

async function runBrowserFetch<T>(
  path: string,
  init: RequestInit | undefined,
  method: string,
  startedAt: number,
  mode: BrowserFetchMode,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (shouldAttachJsonContentType(method, init?.body) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${resolveHostApiBase()}${path}`, {
    ...init,
    method,
    headers,
  });
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: mode.source,
    durationMs: Date.now() - startedAt,
    status: response.status,
  });

  if (response.status === 204) return undefined as T;

  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return await response.json() as T;
    }
    return await response.text() as T;
  } catch (error) {
    throw normalizeAppError(error, { source: mode.source, path, method });
  }
}

export async function hostApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const startedAt = Date.now();
  const method = init?.method || 'GET';

  // Web 预览：任务看板 / 审批用内存 mock，不走不存在的 host API（127.0.0.1:3210）。
  if (isBrowserPreviewMode() && isTaskApprovalMockPath(path)) {
    trackUiEvent('hostapi.fetch', {
      path,
      method,
      source: 'browser-preview-mock',
      durationMs: Date.now() - startedAt,
      status: 200,
    });
    return handleTaskApprovalMock<T>(path, init);
  }

  if (isBrowserPreviewShimEnabled()) {
    return runBrowserFetch<T>(path, init, method, startedAt, {
      source: 'browser-preview-shim',
    });
  }
  // In Electron renderer, always proxy through main process to avoid CORS.
  try {
    const response = await invokeIpc<HostApiProxyResponse>('hostapi:fetch', {
      path,
      method,
      headers: headersToRecord(init?.headers),
      body: init?.body ?? null,
    });

    if (typeof response?.ok === 'boolean' && 'data' in response) {
      return parseUnifiedProxyResponse<T>(response, path, method, startedAt);
    }

    return parseLegacyProxyResponse<T>(response, path, method, startedAt);
  } catch (error) {
    const normalized = normalizeAppError(error, { source: 'ipc-proxy', path, method });
    const message = normalized.message;
    trackUiEvent('hostapi.fetch_error', {
      path,
      method,
      source: 'ipc-proxy',
      durationMs: Date.now() - startedAt,
      message,
      code: normalized.code,
    });
    if (!shouldFallbackToBrowser(message)) {
      throw normalized;
    }
    if (!allowLocalhostFallback()) {
      trackUiEvent('hostapi.fetch_error', {
        path,
        method,
        source: 'ipc-proxy',
        durationMs: Date.now() - startedAt,
        message: 'localhost fallback blocked by policy',
        code: 'CHANNEL_UNAVAILABLE',
      });
      throw normalized;
    }
  }

  // Browser-only fallback (non-Electron environments)。
  // token 不下发渲染进程后，此回退只能命中无需鉴权的端点（有意收缩）。
  return runBrowserFetch<T>(path, init, method, startedAt, {
    source: 'browser-fallback',
  });
}

export function createHostEventSource(path = '/api/events'): EventSource {
  // 仅浏览器预览模式使用（Electron 内 host 事件走 IPC 映射，见 host-events.ts）。
  // token 不再下发渲染进程，故不再附带 token 参数；预览模式本无 Host API 可连。
  // 同源 Web 部署（预览 shim）下指向当前源，其余指向本地 Host API。
  return new EventSource(`${resolveHostApiBase()}${path}`);
}

/**
 * SSE/流式端点的主进程代理：invoke 'hostapi:stream' 拿 streamId，
 * 订阅静态事件通道按 streamId 分流，把数据块重组为 ReadableStream。
 * token 由主进程代持，全程不进入渲染进程。
 */
export async function hostApiStream(
  path: string,
  init?: { method?: string; body?: string },
): Promise<{ status: number; ok: boolean; body: ReadableStream<Uint8Array> }> {
  const ipc = window.electron?.ipcRenderer;

  // 同源 Web 形态（统一算力环境：渲染进程与 model-service 同源，无 Electron
  // 主进程）或纯浏览器环境：流式端点直接 fetch，不再要求 IPC。
  if (!ipc || isBrowserPreviewShimEnabled()) {
    const response = await fetch(`${resolveHostApiBase()}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body ?? null,
    });
    if (!response.body) {
      throw new Error('hostApiStream: response body is unavailable');
    }
    return { status: response.status, ok: response.ok, body: response.body };
  }

  const { streamId } = (await ipc.invoke('hostapi:stream', {
    path,
    method: init?.method ?? 'GET',
    body: init?.body ?? null,
  })) as { streamId: string };

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const cleanup = () => {
      settled = true;
      unsubscribe?.();
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cleanup();
      },
    });
    const off = ipc.on('hostapi:stream-event', (raw: unknown) => {
      const ev = raw as
        | { streamId: string; kind: 'meta'; status: number; ok: boolean }
        | { streamId: string; kind: 'data'; chunk: Uint8Array }
        | { streamId: string; kind: 'end' }
        | { streamId: string; kind: 'error'; message: string };
      if (!ev || ev.streamId !== streamId) return;
      if (ev.kind === 'meta') {
        if (settled) return;
        settled = true;
        resolvePromise({ status: ev.status, ok: ev.ok, body });
      } else if (ev.kind === 'data') {
        controller?.enqueue(ev.chunk instanceof Uint8Array ? ev.chunk : new Uint8Array(ev.chunk));
      } else if (ev.kind === 'end') {
        controller?.close();
        cleanup();
      } else if (ev.kind === 'error') {
        if (!settled) {
          cleanup();
          rejectPromise(new Error(ev.message));
        } else {
          controller?.error(new Error(ev.message));
          cleanup();
        }
      }
    });
    // preload 的 on 成功时返回退订函数；类型上也可能是 void（声明兼容），收一下
    unsubscribe = typeof off === 'function' ? off : undefined;
  });
}

export function getHostApiBase(): string {
  return HOST_API_BASE;
}
