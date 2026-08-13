/**
 * 经验沉淀 Store（GOAI SP-08 · 经验复用闭环）
 * --------------------------------------------------------------------------
 * 把 runClosedLoop 每轮沉淀的 PrecipitatedRule（结构化可复用规则）持久化，
 * 供下一轮闭环作为「历史经验」注入 interviewer / evaluator 上下文，实现经验复用闭环。
 *
 * 双模持久化（设计决策，与 traceSink 同源）：
 *   - 浏览器（Demo / web 预览 5174）：localStorage（key = `agentcorp:experience`）
 *   - Node（vitest / 服务端）：进程内内存 Map 单例（同一进程内跨调用持久，
 *     满足「连跑两次、第二次含第一次规则」的验证；不落盘，避免单测污染工作区）
 *
 * 永不抛出：任何存储异常都降级为静默 no-op，保证经验复用是「加分项」而非「阻断项」。
 */
import type { PrecipitatedRule } from '../closedLoop';

const LS_KEY = 'agentcorp:experience';

/** 浏览器判定：window + localStorage 都存在才算（jsdom/vitest 默认没有 window）。 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { localStorage?: unknown }).localStorage !== 'undefined';
}

/* ───────────── 内存单例（node / vitest 进程内持久） ───────────── */

const memStore = new Map<string, PrecipitatedRule[]>();

/** 测试 / 调试用：清空内存存储（不影响 localStorage）。 */
export function resetRules(): void {
  memStore.clear();
}

function memSave(candidateId: string, rule: PrecipitatedRule): void {
  const arr = memStore.get(candidateId) ?? [];
  arr.push(rule);
  memStore.set(candidateId, arr);
}

function memLoad(candidateId?: string): PrecipitatedRule[] {
  if (candidateId) return memStore.get(candidateId) ?? [];
  const all: PrecipitatedRule[] = [];
  for (const arr of memStore.values()) all.push(...arr);
  return all;
}

/* ───────────── localStorage（浏览器 Demo） ───────────── */

function lsReadAll(): Record<string, PrecipitatedRule[]> {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PrecipitatedRule[]>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function lsSave(candidateId: string, rule: PrecipitatedRule): void {
  try {
    const all = lsReadAll();
    const arr = all[candidateId] ?? [];
    arr.push(rule);
    all[candidateId] = arr;
    window.localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* 静默降级 */
  }
}

function lsLoad(candidateId?: string): PrecipitatedRule[] {
  try {
    const all = lsReadAll();
    if (candidateId) return all[candidateId] ?? [];
    const out: PrecipitatedRule[] = [];
    for (const arr of Object.values(all)) out.push(...arr);
    return out;
  } catch {
    return [];
  }
}

/* ───────────── 对外 API ───────────── */

/** 保存一条结构化经验规则（按 candidateId 归并）。 */
export function saveRule(candidateId: string, rule: PrecipitatedRule): void {
  if (!candidateId) return;
  if (isBrowser()) lsSave(candidateId, rule);
  else memSave(candidateId, rule);
}

/** 读取历史经验规则：传 candidateId 取该候选的；省略则取全部。 */
export function loadRules(candidateId?: string): PrecipitatedRule[] {
  if (isBrowser()) return lsLoad(candidateId);
  return memLoad(candidateId);
}
