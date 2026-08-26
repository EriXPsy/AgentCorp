/**
 * src/components/upload/AgentUpload.tsx
 *
 * Agent 上传组件：用户上传自己的 agent 后自动触发评估→进化闭环。
 *
 * 上传方式：
 *   1. GitHub Repo URL — 自动拉取仓库信息
 *   2. 手动输入 — 名称 + 描述 + 能力标签 + 示例代码
 *   3. JSON 导入 — 标准 AgentCard 格式
 *
 * 上传后自动流程：
 *   1. 创建 Agent（POST /api/agents）
 *   2. 根据 jobType 归入团队（自动创建或加入现有团队）
 *   3. 触发首次 Designer 出题（POST /api/designer/challenge）
 *   4. StyleMemory 初始化开始
 *
 * 设计约束：
 *   - createAgent() 返回 { createdAgentId }
 *   - createTeam() 需要 leaderId + memberIds[]
 *   - 团队分配：相同 jobType 的 agent 自动成组
 *   - 上传失败不阻塞 UI，展示错误信息
 */
import { useCallback, useState } from 'react';
import { Upload, Github, FileJson, Loader2, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';

import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import { useDesignerStore } from '@/stores/designerStore';

// ── 类型 ──────────────────────────────────────────────────────────────
type UploadMode = 'github' | 'manual' | 'json';

interface UploadForm {
  name: string;
  description: string;
  jobType: string;
  capabilities: string[];
  githubUrl: string;
  sampleCode: string;
  jsonPayload: string;
}

interface UploadResult {
  agentId: string;
  teamId: string;
  status: 'success' | 'partial' | 'error';
  message: string;
}

// ── jobType → 团队名映射 ──────────────────────────────────────────────
const JOB_TYPES = [
  { value: 'code', label: '代码生成', teamName: '代码团队' },
  { value: 'text', label: '文本处理', teamName: '文本团队' },
  { value: 'analysis', label: '数据分析', teamName: '分析团队' },
  { value: 'creative', label: '创意写作', teamName: '创意团队' },
  { value: 'agent', label: '通用 Agent', teamName: '综合团队' },
] as const;

const INITIAL_FORM: UploadForm = {
  name: '',
  description: '',
  jobType: 'code',
  capabilities: [],
  githubUrl: '',
  sampleCode: '',
  jsonPayload: '',
};

// ── 主组件 ────────────────────────────────────────────────────────────
export function AgentUpload() {
  const [mode, setMode] = useState<UploadMode>('manual');
  const [form, setForm] = useState<UploadForm>(INITIAL_FORM);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createAgent = useAgentsStore((s) => s.createAgent);
  const updateAgent = useAgentsStore((s) => s.updateAgent);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const teams = useTeamsStore((s) => s.teams);
  const createTeam = useTeamsStore((s) => s.createTeam);
  const fetchTeams = useTeamsStore((s) => s.fetchTeams);
  const designerRequestChallenge = useDesignerStore((s) => s.requestChallenge);

  // ── 找到或创建对应 jobType 的团队 ─────────────────────────────────
  const findOrCreateTeam = useCallback(
    async (jobType: string, agentId: string): Promise<string> => {
      const jobConfig = JOB_TYPES.find((j) => j.value === jobType);
      const teamName = jobConfig?.teamName ?? '综合团队';

      // 查找现有团队
      const existing = teams.find(
        (t) => t.name === teamName || t.name.includes(jobType),
      );
      if (existing) {
        // 加入现有团队
        await useTeamsStore.getState().addMember(existing.id, agentId);
        return existing.id;
      }

      // 没有则创建（agent 作为 leader）
      await createTeam({
        leaderId: agentId,
        memberIds: [],
        name: teamName,
        description: `自动创建：${jobConfig?.label ?? jobType} 方向的 Agent 团队`,
      });

      // createTeam 不返回值，从 store 中找新建的团队
      const updatedTeams = useTeamsStore.getState().teams;
      const newTeam = updatedTeams.find((t) => t.name === teamName);
      if (!newTeam) {
        throw new Error(`团队创建后未找到: ${teamName}`);
      }
      return newTeam.id;
    },
    [teams, createTeam],
  );

  // ── 从 GitHub 拉取信息 ────────────────────────────────────────────
  const fetchGithubInfo = useCallback(async (url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error('无效的 GitHub URL');

    const [, owner, repo] = match;
    const cleanRepo = repo.replace(/\.git$/, '');

    const apiUrl = `https://api.github.com/repos/${owner}/${cleanRepo}`;
    const resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error(`GitHub API 错误: ${resp.status}`);
    const data = await resp.json();

    let readme = '';
    try {
      const readmeResp = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepo}/readme`,
        { headers: { Accept: 'application/vnd.github.v3.raw' } },
      );
      if (readmeResp.ok) readme = await readmeResp.text();
    } catch {
      // README 可选
    }

    return {
      name: data.name ?? cleanRepo,
      description: data.description ?? '',
      readme: readme.slice(0, 2000),
      language: data.language ?? 'Unknown',
      stars: data.stargazers_count ?? 0,
      topics: data.topics ?? [],
    };
  }, []);

  // ── 构建 persona 文本（将元数据嵌入）───────────────────────────────
  const buildPersona = useCallback(
    (desc: string, jobType: string, caps: string[], codeRepo: string, sample: string) => {
      const parts = [desc];
      if (caps.length > 0) parts.push(`\n能力标签: ${caps.join(', ')}`);
      if (codeRepo) parts.push(`\n代码仓库: ${codeRepo}`);
      if (sample) parts.push(`\n示例代码:\n${sample.slice(0, 500)}`);
      parts.push(`\n方向: ${jobType}`);
      return parts.join('\n');
    },
    [],
  );

  // ── 提交上传 ──────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    setError(null);
    setResult(null);

    // 校验
    if (mode === 'github' && !form.githubUrl) {
      setError('请输入 GitHub 仓库 URL');
      return;
    }
    if (mode === 'manual' && (!form.name || !form.description)) {
      setError('请填写名称和描述');
      return;
    }
    if (mode === 'json' && !form.jsonPayload) {
      setError('请粘贴 AgentCard JSON');
      return;
    }

    setUploading(true);

    try {
      let agentName = form.name;
      let agentDesc = form.description;
      let capabilities = form.capabilities;
      let codeRepo = '';
      let sampleCode = form.sampleCode;

      // 根据模式准备数据
      if (mode === 'github') {
        const info = await fetchGithubInfo(form.githubUrl);
        agentName = agentName || info.name;
        agentDesc = agentDesc || info.description || info.readme.slice(0, 200);
        capabilities = capabilities.length > 0 ? capabilities : info.topics.slice(0, 5);
        codeRepo = form.githubUrl;
      } else if (mode === 'json') {
        try {
          const card = JSON.parse(form.jsonPayload);
          agentName = card.name ?? agentName;
          agentDesc = card.description ?? card.persona ?? agentDesc;
          capabilities = card.capabilities ?? capabilities;
          codeRepo = card.code_repo?.url ?? '';
          sampleCode = card.sample_code ?? sampleCode;
        } catch {
          throw new Error('JSON 格式错误');
        }
      }

      // Step 1: 创建 Agent
      const persona = buildPersona(agentDesc, form.jobType, capabilities, codeRepo, sampleCode);
      const { createdAgentId } = await createAgent({
        name: agentName,
        persona,
        teamRole: 'worker',
        model: 'uploaded-agent',
      });

      // Step 2: 归入团队（agent 作为 leader，因为是第一个）
      let teamId: string;
      try {
        teamId = await findOrCreateTeam(form.jobType, createdAgentId);
        // 更新 agent 的 teamId
        await updateAgent(createdAgentId, {
          teamRole: teams.find((t) => t.id === teamId)?.leaderId === createdAgentId ? 'leader' : 'worker',
          reportsTo: teamId,
        });
      } catch (teamErr) {
        console.warn('[AgentUpload] Team assignment failed:', teamErr);
        teamId = '';
      }

      // Step 3: 触发首次 Designer 出题（如果团队创建成功）
      if (teamId) {
        try {
          await designerRequestChallenge(teamId, {
            jobType: form.jobType,
            description: agentDesc,
            memberCount: 1,
          });
        } catch (designerErr) {
          console.warn('[AgentUpload] Designer challenge failed:', designerErr);
        }
      }

      // 刷新数据
      await fetchAgents();
      await fetchTeams();

      const status: UploadResult['status'] = teamId ? 'success' : 'partial';
      setResult({
        agentId: createdAgentId,
        teamId,
        status,
        message:
          status === 'success'
            ? `Agent "${agentName}" 已上传并归入团队。Designer 已自动出题，StyleMemory 开始初始化。`
            : `Agent "${agentName}" 已创建，但团队分配失败。可在团队管理页面手动加入。`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setResult({
        agentId: '',
        teamId: '',
        status: 'error',
        message: msg,
      });
    } finally {
      setUploading(false);
    }
  }, [
    mode, form, createAgent, updateAgent, findOrCreateTeam,
    designerRequestChallenge, fetchAgents, fetchTeams,
    buildPersona, fetchGithubInfo, teams,
  ]);

  // ── 重置 ──────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setForm(INITIAL_FORM);
    setResult(null);
    setError(null);
  }, []);

  // ── 更新字段 ──────────────────────────────────────────────────────
  const updateField = useCallback(
    <K extends keyof UploadForm>(key: K, value: UploadForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // ── 渲染 ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* 模式选择 */}
      <div className="flex gap-2">
        {([
          { key: 'manual' as const, icon: Upload, label: '手动输入' },
          { key: 'github' as const, icon: Github, label: 'GitHub 仓库' },
          { key: 'json' as const, icon: FileJson, label: 'JSON 导入' },
        ]).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-[12px] font-bold transition-all ${
              mode === key
                ? 'bg-[#1A1C1E] text-white dark:bg-white dark:text-[#1A1C1E]'
                : 'border border-gray-200 text-gray-500 hover:border-[#FFD233] dark:border-white/20'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* GitHub 模式 */}
      {mode === 'github' && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
              GitHub 仓库 URL <span className="text-rose-500">*</span>
            </label>
            <input
              type="url"
              value={form.githubUrl}
              onChange={(e) => updateField('githubUrl', e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="w-full rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
              自定义名称（留空自动获取）
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="留空则使用仓库名"
              className="w-full rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
              方向分类
            </label>
            <select
              value={form.jobType}
              onChange={(e) => updateField('jobType', e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
            >
              {JOB_TYPES.map((j) => (
                <option key={j.value} value={j.value}>
                  {j.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* 手动输入模式 */}
      {mode === 'manual' && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
              Agent 名称 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="例如：DeepSeek-Coder-V2"
              className="w-full rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
              能力描述 <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              placeholder="描述这个 agent 擅长的方向、能力和特点..."
              rows={3}
              className="w-full resize-none rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
                方向分类
              </label>
              <select
                value={form.jobType}
                onChange={(e) => updateField('jobType', e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
              >
                {JOB_TYPES.map((j) => (
                  <option key={j.value} value={j.value}>
                    {j.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
                能力标签（逗号分隔）
              </label>
              <input
                type="text"
                value={form.capabilities.join(', ')}
                onChange={(e) =>
                  updateField(
                    'capabilities',
                    e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  )
                }
                placeholder="Python, 算法, 数据处理"
                className="w-full rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-[13px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
              示例代码（可选）
            </label>
            <textarea
              value={form.sampleCode}
              onChange={(e) => updateField('sampleCode', e.target.value)}
              placeholder="粘贴一段代表性代码..."
              rows={4}
              className="w-full resize-none rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 font-mono text-[12px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
            />
          </div>
        </div>
      )}

      {/* JSON 导入模式 */}
      {mode === 'json' && (
        <div>
          <label className="mb-1 block text-[12px] font-bold text-[#1A1C1E] dark:text-white">
            AgentCard JSON
          </label>
          <textarea
            value={form.jsonPayload}
            onChange={(e) => updateField('jsonPayload', e.target.value)}
            placeholder={'{\n  "name": "MyAgent",\n  "description": "...",\n  "capabilities": ["code", "analysis"],\n  "code_repo": { "url": "https://github.com/..." }\n}'}
            rows={10}
            className="w-full resize-none rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 font-mono text-[12px] outline-none focus:border-[#FFD233] dark:border-white/20 dark:bg-white/5 dark:text-white"
          />
        </div>
      )}

      {/* 错误信息 */}
      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-rose-500/10 px-4 py-2.5 text-[12px] text-rose-600">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* 成功结果 */}
      {result && result.status !== 'error' && (
        <div className={`space-y-2 rounded-xl px-4 py-3 text-[12px] ${
          result.status === 'success'
            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
            : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
        }`}>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span className="font-bold">
              {result.status === 'success' ? '上传成功' : '部分成功'}
            </span>
          </div>
          <p>{result.message}</p>
          {result.agentId && (
            <div className="flex gap-3 text-[11px] opacity-70">
              <span>Agent ID: {result.agentId}</span>
              {result.teamId && <span>Team ID: {result.teamId}</span>}
            </div>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={uploading}
          className="flex items-center gap-2 rounded-full bg-[#1A1C1E] px-6 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-[#FF6B4A] disabled:opacity-50 dark:bg-white dark:text-[#1A1C1E]"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {uploading ? '上传中...' : '上传 Agent'}
        </button>
        {(result || error) && (
          <button
            type="button"
            onClick={handleReset}
            className="rounded-full border border-gray-200 px-6 py-2.5 text-[13px] font-bold text-gray-500 transition-all hover:border-[#FFD233] dark:border-white/20 dark:text-gray-400"
          >
            继续上传
          </button>
        )}
      </div>

      {/* 说明 */}
      <div className="rounded-xl bg-gray-50 px-4 py-3 text-[11px] leading-relaxed text-gray-400 dark:bg-white/5">
        <p className="font-bold text-gray-500 dark:text-gray-300">上传后自动执行：</p>
        <ol className="mt-1 list-inside list-decimal space-y-0.5">
          <li>创建 Agent 档案（名称、描述、能力标签）</li>
          <li>根据方向分类自动归入团队（同方向 agent 共享 StyleMemory）</li>
          <li>Designer 自动出首道挑战题</li>
          <li>进入评估→反思→进化循环，团队风格逐步形成</li>
        </ol>
      </div>
    </div>
  );
}

export default AgentUpload;
