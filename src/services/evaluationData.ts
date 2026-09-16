/**
 * src/services/evaluationData.ts
 * 评估数据 Host API 客户端（真实遥测链路）。
 *
 * 渲染层不直接触碰文件系统 / electron-store（nodeIntegration=false），
 * 会话列举与运行数据采集由主进程 electron/services/evaluation/eval-data.ts 完成，
 * 本模块只做 HTTP 调用与类型收窄。
 */
import { hostApiFetch } from '@/lib/host-api';
import type { A2aTraceRecord, TelemetryEvent } from '@/types/evaluation';
import type { TokenUsageHistoryEntry } from '../../shared/token-usage';

/** 会话下拉框选项（与主进程 AgentSessionOption 对应） */
export interface AgentSessionOption {
  sessionKey: string;
  sessionId: string;
  updatedAt: string;
}

/** 一次运行采集的全部数据 */
export interface RunData {
  events: TelemetryEvent[];
  transcript: string;
  entries: TokenUsageHistoryEntry[];
  /** 本次运行关联到的 A2A 委派 trace（仅加法；供 judge 证据引用 trace_id） */
  traces: A2aTraceRecord[];
}

interface HostResponse {
  success: boolean;
  error?: string;
}

/** 列出 agent 的真实会话（按更新时间降序；agentId 非法或目录不可读时返回空） */
export async function listAgentSessions(agentId: string): Promise<AgentSessionOption[]> {
  const res = await hostApiFetch<HostResponse & { sessions?: AgentSessionOption[] }>(
    `/api/eval/sessions?agentId=${encodeURIComponent(agentId)}`,
  );
  if (!res.success) throw new Error(res.error ?? 'listAgentSessions failed');
  return res.sessions ?? [];
}

/** 采集某次运行的遥测 + 转录 + token 用量（sessionId 为空时仅按 agent 兜底用量） */
export async function collectRunData(agentId: string, sessionId: string): Promise<RunData> {
  const res = await hostApiFetch<HostResponse & Partial<RunData>>('/api/eval/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, sessionId }),
  });
  if (!res.success) throw new Error(res.error ?? 'collectRunData failed');
  return {
    events: res.events ?? [],
    transcript: res.transcript ?? '',
    entries: res.entries ?? [],
    traces: res.traces ?? [],
  };
}
