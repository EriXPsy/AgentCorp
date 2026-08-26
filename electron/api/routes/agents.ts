import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'node:path';
import {
  assignChannelToAgent,
  clearChannelBinding,
  createAgent,
  deleteAgentConfig,
  finalizeAgentDeletion,
  listAgentsSnapshot,
  removeAgentWorkspaceDirectory,
  resolveAccountIdForAgent,
  updateAgentProfile,
} from '../../utils/agent-config';
import {
  assignInstalledSkillToAgentWorkspace,
  removeAgentWorkspaceSkill,
  updateAgentWorkspaceSkill,
} from '../../utils/agent-workspace-skills';
import {
  deleteAgentChannelAccounts,
  deleteChannelAccountConfig,
  readOpenClawConfig,
  writeOpenClawConfig,
} from '../../utils/channel-config';
import { logger } from '../../utils/logger';
import { syncAllProviderAuthToRuntime } from '../../services/providers/provider-runtime-sync';
import type { RoleCard } from '../../../src/engine/agents/roleCard';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { transformCronJob } from '../../utils/cron-transform';

function scheduleGatewayReload(ctx: HostApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state !== 'stopped') {
    ctx.gatewayManager.debouncedReload();
    return;
  }
  void reason;
}

function isGatewayPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1;
}

function isNoSuchProcessError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

type GatewayCronJob = {
  id: string;
  name: string;
  payload: { kind: string; message?: string; text?: string };
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  delivery?: { mode: string; channel?: string; to?: string };
  failureAlertAfter?: number;
  failureAlertCooldownSeconds?: number;
  failureAlertChannel?: string;
  deliveryBestEffort?: boolean;
  sessionTarget?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  state: {
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
    nextRunAtMs?: number;
  };
};

async function listAgentCronRelations(agentId: string, ctx: HostApiContext) {
  const snapshot = await listAgentsSnapshot();
  const agent = snapshot.agents.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const result = await ctx.gatewayManager.rpc('cron.list', { includeDisabled: true });
  const jobs = ((result as { jobs?: GatewayCronJob[] })?.jobs ?? []);

  const relations = jobs.flatMap((job) => {
    const sessionTargetMatch = Boolean(job.sessionTarget && job.sessionTarget.includes(agentId));
    const channelTypeMatch = Boolean(job.delivery?.channel && agent.channelTypes.includes(job.delivery.channel));
    const defaultFallback = agentId === 'main' && (!job.sessionTarget || job.sessionTarget === 'isolated');

    let relationReason: 'session-target' | 'channel-type' | 'default-session-target' | null = null;
    if (sessionTargetMatch) {
      relationReason = 'session-target';
    } else if (channelTypeMatch) {
      relationReason = 'channel-type';
    } else if (defaultFallback) {
      relationReason = 'default-session-target';
    }

    if (!relationReason) {
      return [];
    }

    return [{
      job: transformCronJob(job),
      relationReason,
      deepLink: `/team-overview`,
    }];
  });

  return {
    success: true,
    relations,
  };
}

/**
 * Force a full Gateway process restart after agent deletion.
 *
 * A SIGUSR1 in-process reload is NOT sufficient here: channel plugins
 * (e.g. Feishu) maintain long-lived WebSocket connections to external
 * services and do not disconnect accounts that were removed from the
 * config during an in-process reload. The only reliable way to drop
 * stale bot connections is to kill the Gateway process entirely and
 * spawn a fresh one that reads the updated openclaw.json from scratch.
 */
async function restartGatewayForAgentDeletion(ctx: HostApiContext): Promise<void> {
  const status = ctx.gatewayManager.getStatus();
  if (status.state === 'stopped') return;

  // Safety gate: never do blind "kill by port" for deletion flows.
  // Without a PID we cannot validate process identity, so surface
  // partial failure instead of risking unrelated processes.
  if (!isGatewayPid(status.pid)) {
    throw new Error(
      'Agent deleted, but Gateway restart could not be safely completed: missing Gateway PID (port-kill disabled).',
    );
  }

  const pid = status.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw new Error(
        `Failed to stop Gateway PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw new Error(
        `Failed to force-stop Gateway PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  try {
    await ctx.gatewayManager.restart();
  } catch (error) {
    throw new Error(
      `Agent deleted, but Gateway restart failed after config removal: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/agents' && req.method === 'GET') {
    sendJson(res, 200, { success: true, ...(await listAgentsSnapshot()) });
    return true;
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'GET') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 2 && parts[1] === 'cron-relations') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        sendJson(res, 200, await listAgentCronRelations(agentId, ctx));
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error), relations: [] });
      }
      return true;
    }
  }

  if (url.pathname === '/api/agents' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        name: string;
        persona?: string;
        teamRole?: 'leader' | 'worker';
        model?: string;
        roleCard?: RoleCard;
      }>(req);
      const result = await createAgent({
        name: body.name,
        ...(body.persona !== undefined ? { persona: body.persona } : {}),
        ...(body.teamRole !== undefined ? { teamRole: body.teamRole } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.roleCard !== undefined ? { roleCard: body.roleCard } : {}),
      });
      // Sync provider API keys to the new agent's auth-profiles.json so the
      // embedded runner can authenticate with LLM providers when messages
      // arrive via channel bots (e.g. Feishu). Without this, the copied
      // auth-profiles.json may contain a stale key -> 401 from the LLM.
      syncAllProviderAuthToRuntime().catch((err) => {
        logger.warn('[agents] Failed to sync provider auth after agent creation:', err);
      });
      scheduleGatewayReload(ctx, 'create-agent');
      sendJson(res, 200, {
        success: true,
        createdAgentId: result.createdAgentId,
        ...result.snapshot,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'PUT') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const body = await parseJsonBody<{
          name?: string;
          persona?: string;
          model?: string;
          avatar?: string | null;
          reportsTo?: string | null;
          teamRole?: 'leader' | 'worker';
          chatAccess?: 'direct' | 'leader_only';
          responsibility?: string;
          roleCard?: RoleCard;
        }>(req);
        const agentId = decodeURIComponent(parts[0]);
        const snapshot = await updateAgentProfile(agentId, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.persona !== undefined ? { persona: body.persona } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
          ...(body.reportsTo !== undefined ? { reportsTo: body.reportsTo } : {}),
          ...(body.teamRole !== undefined ? { teamRole: body.teamRole } : {}),
          ...(body.chatAccess !== undefined ? { chatAccess: body.chatAccess } : {}),
          ...(body.responsibility !== undefined ? { responsibility: body.responsibility } : {}),
          ...(body.roleCard !== undefined ? { roleCard: body.roleCard } : {}),
        });
        scheduleGatewayReload(ctx, 'update-agent');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const snapshot = await assignChannelToAgent(agentId, channelType);
        scheduleGatewayReload(ctx, 'assign-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      let rollbackConfig: Record<string, unknown> | null = null;
      let deletionResult: { snapshot: Awaited<ReturnType<typeof listAgentsSnapshot>>; removedEntry: { id: string; workspace?: string } } | null = null;
      try {
        const agentId = decodeURIComponent(parts[0]);
        rollbackConfig = await readOpenClawConfig() as Record<string, unknown>;
        deletionResult = await deleteAgentConfig(agentId);
        await deleteAgentChannelAccounts(agentId);
        // Await reload synchronously BEFORE responding to the client.
        // This ensures the Feishu plugin has disconnected the deleted bot
        // before the UI shows "delete success" and the user tries chatting.
        await restartGatewayForAgentDeletion(ctx);
        await finalizeAgentDeletion(agentId).catch((err) => {
          logger.warn('[agents] Failed to remove agent runtime after deletion:', err);
        });
        // Delete workspace after reload so the new config is already live.
        await removeAgentWorkspaceDirectory(deletionResult.removedEntry).catch((err) => {
          logger.warn('[agents] Failed to remove workspace after agent deletion:', err);
        });
        sendJson(res, 200, { success: true, ...deletionResult.snapshot });
      } catch (error) {
        if (rollbackConfig && deletionResult) {
          try {
            await writeOpenClawConfig(rollbackConfig);
          } catch (rollbackError) {
            logger.warn('[agents] Failed to rollback agent deletion after gateway restart failure:', rollbackError);
          }
        }
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const accountId = resolveAccountIdForAgent(agentId);
        await deleteChannelAccountConfig(channelType, accountId);
        const snapshot = await clearChannelBinding(channelType, accountId);
        scheduleGatewayReload(ctx, 'remove-agent-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  // Skills listing: GET /api/agents/:agentId/workspace/skills
  const skillsListMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace\/skills$/);
  if (skillsListMatch && req.method === 'POST') {
    const agentId = decodeURIComponent(skillsListMatch[1]);
    try {
      const body = await parseJsonBody<{ slug: string }>(req);
      if (typeof body?.slug !== 'string' || !/^[\w-]+$/.test(body.slug)) {
        sendJson(res, 400, { success: false, error: 'Invalid skill slug' });
        return true;
      }
      await assignInstalledSkillToAgentWorkspace(agentId, body.slug);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (skillsListMatch && req.method === 'GET') {
    const agentId = decodeURIComponent(skillsListMatch[1]);
    try {
      const snapshot = await listAgentsSnapshot();
      const agent = snapshot.agents.find((a) => a.id === agentId);
      if (!agent?.workspace) {
        sendJson(res, 200, { success: true, skills: [] });
        return true;
      }
      const { expandPath } = await import('../../utils/paths');
      const fsP = await import('node:fs/promises');
      const skillsDir = join(expandPath(agent.workspace), 'skills');
      try {
        const entries = await fsP.readdir(skillsDir, { withFileTypes: true });
        const skills = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        sendJson(res, 200, { success: true, skills });
      } catch {
        sendJson(res, 200, { success: true, skills: [] });
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // Skill file read: GET /api/agents/:agentId/workspace/skills/:skillName
  const skillFileMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace\/skills\/([^/]+)$/);
  if (skillFileMatch && req.method === 'PUT') {
    const agentId = decodeURIComponent(skillFileMatch[1]);
    const skillName = decodeURIComponent(skillFileMatch[2]);
    if (!/^[\w-]+$/.test(skillName)) {
      sendJson(res, 400, { success: false, error: 'Invalid skill name' });
      return true;
    }

    try {
      const body = await parseJsonBody<{ content: string }>(req);
      if (typeof body?.content !== 'string') {
        sendJson(res, 400, { success: false, error: 'content required' });
        return true;
      }
      await updateAgentWorkspaceSkill(agentId, skillName, body.content);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (skillFileMatch && req.method === 'DELETE') {
    const agentId = decodeURIComponent(skillFileMatch[1]);
    const skillName = decodeURIComponent(skillFileMatch[2]);
    if (!/^[\w-]+$/.test(skillName)) {
      sendJson(res, 400, { success: false, error: 'Invalid skill name' });
      return true;
    }

    try {
      await removeAgentWorkspaceSkill(agentId, skillName);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (skillFileMatch && req.method === 'GET') {
    const agentId = decodeURIComponent(skillFileMatch[1]);
    const skillName = decodeURIComponent(skillFileMatch[2]);
    // Security: only alphanumeric, dash, underscore skill names
    if (!/^[\w-]+$/.test(skillName)) {
      sendJson(res, 400, { success: false, error: 'Invalid skill name' });
      return true;
    }
    try {
      const snapshot = await listAgentsSnapshot();
      const agent = snapshot.agents.find((a) => a.id === agentId);
      if (!agent?.workspace) {
        sendJson(res, 200, { success: true, content: '', exists: false });
        return true;
      }
      const { expandPath } = await import('../../utils/paths');
      const fsP = await import('node:fs/promises');
      const filePath = join(expandPath(agent.workspace), 'skills', skillName, 'SKILL.md');
      try {
        const content = await fsP.readFile(filePath, 'utf8');
        sendJson(res, 200, { success: true, content, exists: true });
      } catch {
        sendJson(res, 200, { success: true, content: '', exists: false });
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const workspaceFileMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace\/([^/]+)$/);
  if (workspaceFileMatch && req.method === 'GET') {
    const agentId = decodeURIComponent(workspaceFileMatch[1]);
    const filename = decodeURIComponent(workspaceFileMatch[2]);

    // Security: only allow safe workspace filenames
    const ALLOWED_FILES = new Set([
      'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'USER.md',
      'IDENTITY.md', 'HEARTBEAT.md', 'BOOT.md', 'MEMORY.md',
    ]);
    if (!ALLOWED_FILES.has(filename)) {
      sendJson(res, 400, { success: false, error: 'File not allowed' });
      return true;
    }

    try {
      const snapshot = await listAgentsSnapshot();
      const agent = snapshot.agents.find((a) => a.id === agentId);
      if (!agent) {
        sendJson(res, 404, { success: false, error: 'Agent not found' });
        return true;
      }

      const workspacePath = agent.workspace;
      if (!workspacePath) {
        sendJson(res, 404, { success: false, error: 'Agent has no workspace configured' });
        return true;
      }

      const { expandPath } = await import('../../utils/paths');
      const fsP = await import('node:fs/promises');
      const filePath = join(expandPath(workspacePath), filename);

      try {
        const content = await fsP.readFile(filePath, 'utf8');
        sendJson(res, 200, { success: true, content, exists: true });
      } catch {
        // File does not exist — return empty content, not an error
        sendJson(res, 200, { success: true, content: '', exists: false });
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // Workspace file write: PUT /api/agents/:agentId/workspace/:filename
  if (workspaceFileMatch && req.method === 'PUT') {
    const agentId = decodeURIComponent(workspaceFileMatch[1]);
    const filename = decodeURIComponent(workspaceFileMatch[2]);

    const WRITABLE_FILES = new Set(['AGENTS.md', 'SOUL.md']);
    if (!WRITABLE_FILES.has(filename)) {
      sendJson(res, 400, { success: false, error: 'File not writable' });
      return true;
    }

    try {
      const body = await parseJsonBody<{ content: string }>(req);
      if (typeof body?.content !== 'string') {
        sendJson(res, 400, { success: false, error: 'content required' });
        return true;
      }

      const snapshot = await listAgentsSnapshot();
      const agent = snapshot.agents.find((a) => a.id === agentId);
      if (!agent) {
        sendJson(res, 404, { success: false, error: 'Agent not found' });
        return true;
      }
      if (!agent.workspace) {
        sendJson(res, 404, { success: false, error: 'Agent has no workspace configured' });
        return true;
      }

      const { expandPath } = await import('../../utils/paths');
      const fsP = await import('node:fs/promises');
      const filePath = join(expandPath(agent.workspace), filename);
      await fsP.writeFile(filePath, body.content, 'utf8');
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
