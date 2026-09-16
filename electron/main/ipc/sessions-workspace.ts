/**
 * @domain ipc
 * @purpose 会话列表与工作区管理通道。
 * @behaviors 由 ipc/index.ts 统一装配，channel 名与注册顺序与拆分前逐字符一致
 * @dive contracts: preload/index.ts 暴露面 · details: 本文件即实现
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { join, extname, basename } from 'node:path';
import { getOpenClawStatus, getOpenClawDir, getOpenClawConfigDir, getOpenClawSkillsDir, ensureDir } from '../utils/paths';
import { getAllSettings, getSetting, resetSettings, setSetting, type AppSettings } from '../utils/store';
import { logger } from '../utils/logger';
import { cloneWorkspaceFromTemplate, importLocalWorkspace, hireTeamFromTemplate, listMarketplaceTemplates, hireFromMarketplaceTemplate, hireTeamFromMarketplaceTemplate, readAgentPersona } from '../utils/openclaw-workspace';
import { importGithubRepo, type GithubCandidate } from '../utils/github-import';

function registerSessionHandlers(): void {
  ipcMain.handle('session:delete', async (_, sessionKey: string) => {
    try {
      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        return { success: false, error: `Invalid sessionKey: ${sessionKey}` };
      }

      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        return { success: false, error: `sessionKey has too few parts: ${sessionKey}` };
      }

      const agentId = parts[1];
      // Prevent path traversal — agentId is joined into a filesystem path below
      if (!agentId || agentId.includes('/') || agentId.includes('\\') || agentId.includes('..')) {
        return { success: false, error: `Invalid agentId in sessionKey: ${sessionKey}` };
      }
      const openclawConfigDir = getOpenClawConfigDir();
      const sessionsDir = join(openclawConfigDir, 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');

      logger.info(`[session:delete] key=${sessionKey} agentId=${agentId}`);
      logger.info(`[session:delete] sessionsJson=${sessionsJsonPath}`);

      const fsP = await import('fs/promises');

      // ── Step 1: read sessions.json to find the UUID file for this sessionKey ──
      let sessionsJson: Record<string, unknown> = {};
      try {
        const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
        sessionsJson = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        logger.warn(`[session:delete] Could not read sessions.json: ${String(e)}`);
        return { success: false, error: `Could not read sessions.json: ${String(e)}` };
      }

      // sessions.json structure: try common shapes used by OpenClaw Gateway:
      //   Shape A (array):  { sessions: [{ key, file, ... }] }
      //   Shape B (object): { [sessionKey]: { file, ... } }
      //   Shape C (array):  { sessions: [{ key, id, ... }] }  — id is the UUID
      let uuidFileName: string | undefined;

      // Shape A / C — array under "sessions" key
      if (Array.isArray(sessionsJson.sessions)) {
        const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
          .find((s) => s.key === sessionKey || s.sessionKey === sessionKey);
        if (entry) {
          // Could be "file", "fileName", "id" + ".jsonl", or "path"
          uuidFileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (!uuidFileName && typeof entry.id === 'string') {
            uuidFileName = `${entry.id}.jsonl`;
          }
        }
      }

      // Shape B — flat object keyed by sessionKey; value may be a string or an object.
      // Actual Gateway format: { sessionFile: "/abs/path/uuid.jsonl", sessionId: "uuid", ... }
      let resolvedSrcPath: string | undefined;

      if (!uuidFileName && sessionsJson[sessionKey] != null) {
        const val = sessionsJson[sessionKey];
        if (typeof val === 'string') {
          uuidFileName = val;
        } else if (typeof val === 'object' && val !== null) {
          const entry = val as Record<string, unknown>;
          // Priority: absolute sessionFile path > relative file/fileName/path > id/sessionId as UUID
          const absFile = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (absFile) {
            if (absFile.startsWith('/') || absFile.match(/^[A-Za-z]:\\/)) {
              // Absolute path — use directly
              resolvedSrcPath = absFile;
            } else {
              uuidFileName = absFile;
            }
          } else {
            // Fall back to UUID fields
            const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
            if (uuidVal) uuidFileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
          }
        }
      }

      if (!uuidFileName && !resolvedSrcPath) {
        const rawVal = sessionsJson[sessionKey];
        logger.warn(`[session:delete] Cannot resolve file for "${sessionKey}". Raw value: ${JSON.stringify(rawVal)}`);
        return { success: false, error: `Cannot resolve file for session: ${sessionKey}` };
      }

      // Normalise: if we got a relative filename, resolve it against sessionsDir
      if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }

      const dstPath = resolvedSrcPath.replace(/\.jsonl$/, '.deleted.jsonl');
      logger.info(`[session:delete] file: ${resolvedSrcPath}`);

      // ── Step 2: rename the JSONL file ──
      try {
        await fsP.access(resolvedSrcPath);
        await fsP.rename(resolvedSrcPath, dstPath);
        logger.info(`[session:delete] Renamed ${resolvedSrcPath} → ${dstPath}`);
      } catch (e) {
        logger.warn(`[session:delete] Could not rename file: ${String(e)}`);
      }

      // ── Step 3: remove the entry from sessions.json ──
      try {
        // Re-read to avoid race conditions
        const raw2 = await fsP.readFile(sessionsJsonPath, 'utf8');
        const json2 = JSON.parse(raw2) as Record<string, unknown>;

        if (Array.isArray(json2.sessions)) {
          json2.sessions = (json2.sessions as Array<Record<string, unknown>>)
            .filter((s) => s.key !== sessionKey && s.sessionKey !== sessionKey);
        } else if (json2[sessionKey]) {
          delete json2[sessionKey];
        }

        await fsP.writeFile(sessionsJsonPath, JSON.stringify(json2, null, 2), 'utf8');
        logger.info(`[session:delete] Removed "${sessionKey}" from sessions.json`);
      } catch (e) {
        logger.warn(`[session:delete] Could not update sessions.json: ${String(e)}`);
        // Non-fatal — JSONL rename already done
      }

      return { success: true };
    } catch (err) {
      logger.error(`[session:delete] Unexpected error for ${sessionKey}:`, err);
      return { success: false, error: String(err) };
    }
  });
}

/**
 * Workspace IPC handlers
 * Wraps workspace operations from openclaw-workspace.ts
 */
function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:clone', async (_, templateId: string, agentName: string) => {
    try {
      const path = await cloneWorkspaceFromTemplate(templateId, agentName);
      return { success: true, path };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('workspace:import', async (_, sourcePath: string) => {
    try {
      const path = await importLocalWorkspace(sourcePath);
      return { success: true, path };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('workspace:hireTeam', async (_event, templateId: string, teamName: string, capabilities: string[]) => {
    try {
      const result = await hireTeamFromTemplate(templateId, teamName, capabilities);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('marketplace:listTemplates', async () => {
    try {
      const templates = await listMarketplaceTemplates();
      return { success: true, templates };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * GitHub 一键导入：把开源仓库变成人才市集里的候选卡。
   *
   * 出网与 SSRF 防护全在主进程（github-import.ts），渲染层只递一个字符串。
   * 导入结果落 electron-store 持久化，但**不含任何能力分**——
   * 导入只是让候选进场，能不能用要靠 S1/S2 实测说话。
   */
  ipcMain.handle('marketplace:importGithub', async (_event, input: string) => {
    try {
      const candidate = await importGithubRepo(String(input ?? ''));
      logger.info(
        `GitHub 导入：${candidate.githubMeta.owner}/${candidate.githubMeta.repo}（★${candidate.githubMeta.stars}，未评测）`,
      );
      const existing = ((await getSetting('githubImports')) ?? []) as GithubCandidate[];
      // 同一仓库重复导入 → 覆盖旧记录（保持幂等，不产生重复卡）
      const next = [candidate, ...existing.filter((c) => c?.id !== candidate.id)].slice(0, 200);
      await setSetting('githubImports', next);
      return { success: true, candidate };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('marketplace:listGithubImports', async () => {
    try {
      const list = ((await getSetting('githubImports')) ?? []) as GithubCandidate[];
      return { success: true, candidates: list };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('marketplace:removeGithubImport', async (_event, id: string) => {
    try {
      const list = ((await getSetting('githubImports')) ?? []) as GithubCandidate[];
      await setSetting('githubImports', list.filter((c) => c?.id !== id));
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('marketplace:hireSingle', async (_event, templateId: string, agentName: string) => {
    try {
      const result = await hireFromMarketplaceTemplate(templateId, agentName);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('marketplace:hireTeam', async (_event, templateId: string, teamName: string, capabilities: string[]) => {
    try {
      const result = await hireTeamFromMarketplaceTemplate(templateId, teamName, capabilities);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // 读取 agent 人格文本（SOUL.md），不存在时返回 null，由调用方兜底
  ipcMain.handle('agent:getPersona', async (_event, agentId: string) => {
    try {
      const persona = await readAgentPersona(agentId);
      return { success: true, persona };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
