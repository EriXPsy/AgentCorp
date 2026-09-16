/**
 * @domain ipc
 * @purpose 外链协议白名单守卫（providers/shell 共用）。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Shell-related IPC handlers
 */
