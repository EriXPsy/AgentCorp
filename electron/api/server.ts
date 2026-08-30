import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PORTS } from '../utils/config';
import { logger } from '../utils/logger';
import type { HostApiContext } from './context';
import { handleAppRoutes } from './routes/app';
import { handleGatewayRoutes } from './routes/gateway';
import { handleSettingsRoutes } from './routes/settings';
import { handleProviderRoutes } from './routes/providers';
import { handleAgentRoutes } from './routes/agents';
import { handleLogRoutes } from './routes/logs';
import { handleUsageRoutes } from './routes/usage';
import { handleSkillRoutes } from './routes/skills';
import { handleFileRoutes } from './routes/files';
import { handleSessionRoutes } from './routes/sessions';
import { handleApprovalRoutes } from './routes/approvals';
import { handleHealthRoutes } from './routes/health';
import { handleMemoryRoutes } from './routes/memory';
import { handleMcpRoutes } from './routes/mcp';
import { handleCostsRoutes } from './routes/costs';
import { handleLlmUsageRoutes } from './routes/llm-usage';
import { handleEvaluateRoutes } from './routes/evaluate';
import { handleAlertsRoutes } from './routes/alerts';
import { handleFeishuRoutes } from './routes/feishu';
import { handleTeamRoutes } from './routes/teams';
import { handleTaskRoutes } from './routes/tasks';
import { handleScheduleRoutes } from './routes/schedules';
import { handleMemberStatsRoutes } from './routes/member-stats';
import { handleTeamExperienceRoutes } from './routes/team-experience';
import { handleReactionsRoutes } from './routes/reactions';
import { handleArenaRoutes } from './routes/arena';
import { handleConvergenceRoutes } from './routes/convergence';
import { handleCraftRoutes } from './routes/craft';
import { handleTraceRoutes } from './routes/traces';
import { handleCapsuleRoutes } from './routes/capsules';
import { handleLlmChatRoutes } from './routes/llm-chat';
import { isAuthorizedHostApiRequest, applyCorsOrigin, sendJson, sendNoContent, sendUnauthorized } from './route-utils';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
) => Promise<boolean>;

/**
 * MCP 等价契约：本 route 表即 AgentCorp 的「MCP 等价层」——
 * 每个 handler 对应契约文档中的一组 tool（evaluate.run / judge.chat / craft.judge /
 * arena.compare / arena.userPick / agents.* / eval.* / gateway.* …），
 * 统一鉴权 x-agentcorp-host-session，错误约定 { success:false, error }。
 * 迁移真 MCP = 把各 tool 的 params 包成 MCP tool schema 后原样转发到此表，
 * 调用链不变。完整契约：docs/artifacts/mcp-equivalent-contract.md。
 */
const routeHandlers: RouteHandler[] = [
  handleAppRoutes,
  handleGatewayRoutes,
  handleSettingsRoutes,
  handleProviderRoutes,
  handleAgentRoutes,
  handleTeamRoutes,
  handleTaskRoutes,
  handleScheduleRoutes,
  handleMemberStatsRoutes,
  handleTeamExperienceRoutes,
  handleSkillRoutes,
  handleFileRoutes,
  handleSessionRoutes,
  handleApprovalRoutes,
  handleHealthRoutes,
  handleMemoryRoutes,
  handleMcpRoutes,
  handleCostsRoutes,
  handleLlmUsageRoutes,
  handleEvaluateRoutes,
  handleAlertsRoutes,
  handleFeishuRoutes,
  handleLogRoutes,
  handleUsageRoutes,
  handleReactionsRoutes,
  handleArenaRoutes,
  handleConvergenceRoutes,
  handleCraftRoutes,
  handleTraceRoutes,
  handleCapsuleRoutes,
  handleLlmChatRoutes,
];

/**
 * Per-session secret token used to authenticate Host API requests.
 * Generated once at server start and shared with the renderer via IPC.
 * This prevents cross-origin attackers from reading sensitive data even
 * if they can reach 127.0.0.1:3210 (the CORS wildcard alone is not
 * sufficient because browsers attach the Origin header but not a secret).
 */
let hostApiToken: string = '';

/** Retrieve the current Host API auth token (for use by IPC proxy). */
export function getHostApiToken(): string {
  return hostApiToken;
}

export function startHostApiServer(ctx: HostApiContext, port = PORTS.CLAWX_HOST_API): Server {
  // Generate a cryptographically random token for this session.
  hostApiToken = randomBytes(32).toString('hex');

  const server = createServer(async (req, res) => {
    try {
      // Apply CORS origin restriction before any response is sent.
      applyCorsOrigin(req, res);
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'OPTIONS') {
        sendNoContent(res);
        return;
      }
      if (!isAuthorizedHostApiRequest(req, ctx.hostApiSessionToken)) {
        sendUnauthorized(res);
        return;
      }
      for (const handler of routeHandlers) {
        if (await handler(req, res, requestUrl, ctx)) {
          return;
        }
      }
      sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
    } catch (error) {
      logger.error('Host API request failed:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Host API server listening on http://127.0.0.1:${port}`);
  });

  return server;
}
