/**
 * shared/token-usage.ts
 *
 * token 用量记录的双端共享类型（L2 契约下沉）。
 * 主进程解析（electron/utils/token-usage-core.ts）与渲染层采集客户端
 * （src/services/tokenUsageCollector.ts 等）共用，避免 src → electron 的
 * 类型 import 造成依赖违规（renderer-must-not-import-electron-main）。
 */

export interface TokenUsageHistoryEntry {
  timestamp: string;
  sessionId: string;
  agentId: string;
  cronJobId?: string;
  model?: string;
  provider?: string;
  content?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}
