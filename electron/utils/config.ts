/**
 * Application Configuration
 * Centralized configuration constants and helpers
 */

/**
 * Port configuration
 */
export const PORTS = {
  /** AgentCorp GUI development server port */
  CLAWX_DEV: 5173,
  
  /** AgentCorp GUI production port (for reference) */
  CLAWX_GUI: 23333,

  /** Local host API server port */
  CLAWX_HOST_API: 3210,
  
  /** OpenClaw Gateway port */
  OPENCLAW_GATEWAY: 18789,
} as const;

/**
 * ════════════ Host API 即「MCP 等价契约」承载面（GOAI SP-13 / 见 docs/artifacts/mcp-equivalent-contract.md） ════════════
 * `CLAWX_HOST_API (3210)` 上的每个路由（见 electron/api/server.ts 的 routeHandlers）在语义上
 * 等价于一个 MCP tool：evaluate.run / chat-judge / arena.compare / arena.user-pick / agents.* / convergence.*。
 * 鉴权统一用 `x-clawx-host-session`；RPC 帧为 { type, id, method, params }。
 * 复赛迁移到真 MCP 时，这些路由逐 tool 1:1 映射，无需重设计角色卡/Skill。
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Get port from environment or default
 */
export function getPort(key: keyof typeof PORTS): number {
  const envKey = `CLAWX_PORT_${key}`;
  const envValue = process.env[envKey];
  return envValue ? parseInt(envValue, 10) : PORTS[key];
}

/**
 * Application paths
 */
export const APP_PATHS = {
  /** OpenClaw configuration directory */
  OPENCLAW_CONFIG: '~/.openclaw',
  
  /** AgentCorp configuration directory */
  CLAWX_CONFIG: '~/.clawx',
  
  /** Log files directory */
  LOGS: '~/.clawx/logs',
} as const;

/**
 * Update channels
 */
export const UPDATE_CHANNELS = ['stable', 'beta', 'dev'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/**
 * Default update configuration
 */
export const UPDATE_CONFIG = {
  /** Check interval in milliseconds (6 hours) */
  CHECK_INTERVAL: 6 * 60 * 60 * 1000,
  
  /** Default update channel */
  DEFAULT_CHANNEL: 'stable' as UpdateChannel,
  
  /** Auto download updates */
  AUTO_DOWNLOAD: false,
  
  /** Show update notifications */
  SHOW_NOTIFICATION: true,
};

/**
 * Gateway configuration
 */
export const GATEWAY_CONFIG = {
  /** WebSocket reconnection delay (ms) */
  RECONNECT_DELAY: 5000,
  
  /** RPC call timeout (ms) */
  RPC_TIMEOUT: 30000,
  
  /** Health check interval (ms) */
  HEALTH_CHECK_INTERVAL: 30000,
  
  /** Maximum startup retries */
  MAX_STARTUP_RETRIES: 30,
  
  /** Startup retry interval (ms) */
  STARTUP_RETRY_INTERVAL: 1000,
};
