/**
 * Application Configuration
 * Centralized configuration constants and helpers
 */

/**
 * Port configuration
 *
 * MCP 等价契约：以下三个端口共同构成 AgentCorp 的「MCP 等价层」——
 *   :3210 CLAWX_HOST_API   Electron Host API（REST，鉴权头 x-agentcorp-host-session）
 *   :18789 OPENCLAW_GATEWAY OpenClaw 网关（WS RPC 帧 {type,id,method,params}）
 *   :8000 model-service    Python 评分/评委后端（端口定义见 electron/utils/store.ts）
 * 完整 tool schema（evaluate.run / judge.chat / craft.judge / arena.* / agents.* /
 * eval.* / gateway.*）与「迁移真 MCP = 协议适配」的逐 tool 步骤见
 * docs/artifacts/mcp-equivalent-contract.md。
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
