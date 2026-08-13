/**
 * GOAI 多 Agent 闭环演示页（web 预览 5174 可用，路径 /demo.html）。
 * 展示 boss → recruiter → evaluator → boss 端到端闭环，并把每一步对齐 GOAI 八步闭环。
 * 评委默认走 demoJudge（真实网关可达用真评委，否则降级 mock，闭环永不中断）。
 *
 * SP-05：本页不再直接调 runClosedLoop，而是走 AgentTeams 薄适配的
 *   createTeam → createTask → runTask，步骤面板标注「Agent + Skill」（run.steps[].skill），
 *   与复赛「以 AgentTeams 为协同设计基点」对齐。
 * SP-10：新增「保存轨迹 / 回放」按钮，把一次 Run 落盘（traceSink）并可回放复盘。
 */
import { useState } from 'react';
import { ROLE_CARDS } from '@/engine/agents/roleCard';
import { createTeam, createTask, runTask, type ATRun } from './agentteams-adapter';
import { phaseLabel, type ClosedLoopResult } from './closedLoop';
import { RADAR_DIMS } from '@/engine/scoring/registry';
import { sinkRun, replayRun } from './observability/traceSink';

const SAMPLE = {
  requirement: '招聘一名能独立承担前端组件库开发的 Agent 工程师，要求稳定可靠、沟通清晰。',
  candidateName: 'FrontendAgent-07',
  candidatePersona:
    '我是一名前端组件库 Agent，擅长 React/TS 组件拆分与无障碍实现，习惯先复述需求再动手，遇到歧义会主动追问。',
  transcript:
    '面试官：请描述你如何把一个大型表单拆成可控组件。\n候选：我会先复述需求——表单需支持分步校验与错误聚合。然后按职责拆为 FormProvider（状态）、Field（受控单元）、Validator（纯函数校验）、ErrorSummary（聚合展示）。每步我会先给最小可用版本再增强。\n面试官：如果校验规则频繁变化怎么办？\n候选：我会把规则抽成配置驱动，并用纯函数 Validator 便于单测；变更时只改配置不改组件，并保留回滚点。',
};

const actionColor: Record<string, string> = {
  hire: '#2e7d32',
  observe: '#ef6c00',
  reject: '#c62828',
  rollback: '#6a1b9a',
};
const statusColor: Record<string, string> = {
  ok: '#2e7d32',
  warn: '#ef6c00',
  blocked: '#c62828',
};

export default function ClosedLoopDemo() {
  const [req, setReq] = useState({ ...SAMPLE, candidateId: 'fe-agent-07' });
  const [run, setRun] = useState<ATRun | null>(null);
  const [running, setRunning] = useState(false);
  const [sinkMsg, setSinkMsg] = useState('');
  const [replay, setReplay] = useState<ATRun | null>(null);

  const result: ClosedLoopResult | undefined = run?.result;

  const runLoop = async () => {
    setRunning(true);
    setSinkMsg('');
    setReplay(null);
    try {
      // SP-05：走 AgentTeams 薄适配（createTeam → createTask → runTask）
      const team = createTeam();
      const task = createTask({
        title: req.requirement,
        requirement: req.requirement,
        candidateId: req.candidateId,
        candidateName: req.candidateName,
        candidatePersona: req.candidatePersona,
        transcript: req.transcript,
      });
      const r = await runTask(team, task);
      setRun(r);
    } finally {
      setRunning(false);
    }
  };

  const saveTrace = async () => {
    if (!run) return;
    const loc = await sinkRun(run);
    setSinkMsg(`已保存轨迹 → ${loc}`);
  };

  const replayTrace = async () => {
    if (!run) return;
    const r = await replayRun(run.runId);
    setReplay(r);
    setSinkMsg(r ? `已回放 Run ${r.runId}（status=${r.status}, steps=${r.steps.length}）` : '回放失败：未找到轨迹');
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#1a1c1e' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>AgentCorp · 多 Agent 闭环 Demo</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        数字员工招募与管理训练场 · 对齐阿里 GOAI 八步闭环（任务输入→拆解→上下文→工具→验证→证据→审批→经验）
      </p>

      <h2 style={{ fontSize: 18, marginTop: 24 }}>Agent Identity 清单（4 异构职能 Agent）</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12 }}>
        {ROLE_CARDS.map((c) => (
          <div key={c.id} style={{ border: '1px solid #ddd', borderRadius: 10, padding: 12, background: '#fafafa' }}>
            <div style={{ fontWeight: 700 }}>{c.name}</div>
            <div style={{ fontSize: 12, color: '#777', margin: '2px 0 6px' }}>{c.role} · {c.teamRole}</div>
            <div style={{ fontSize: 13 }}>{c.goal}</div>
            <div style={{ fontSize: 12, marginTop: 8, color: c.boundaries.riskLevel === 'high' ? '#c62828' : '#555' }}>
              边界风险：{c.boundaries.riskLevel}{c.boundaries.requiresApproval ? ' · 需审批' : ''}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 18, marginTop: 24 }}>招聘需求 & 候选上下文</h2>
      <label style={labelStyle}>任务输入（boss 需求）</label>
      <textarea style={taStyle} value={req.requirement} onChange={(e) => setReq({ ...req, requirement: e.target.value })} />
      <label style={labelStyle}>候选 Agent 名称</label>
      <input style={inputStyle} value={req.candidateName} onChange={(e) => setReq({ ...req, candidateName: e.target.value })} />
      <label style={labelStyle}>候选 persona</label>
      <textarea style={taStyle} value={req.candidatePersona} onChange={(e) => setReq({ ...req, candidatePersona: e.target.value })} />
      <label style={labelStyle}>面试转录（recruiter 产出，交接 evaluator）</label>
      <textarea style={taStyle} value={req.transcript} onChange={(e) => setReq({ ...req, transcript: e.target.value })} />

      <button onClick={runLoop} disabled={running} style={{ marginTop: 12, padding: '10px 18px', fontSize: 15, borderRadius: 8, border: 'none', background: '#1a1c1e', color: '#fff', cursor: running ? 'default' : 'pointer' }}>
        {running ? '运行中…' : '▶ 运行闭环（boss→recruiter→evaluator→boss）'}
      </button>

      {run && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Run {run.runId}</span>
            <span style={{ fontSize: 12, color: statusColor[run.status === 'completed' ? 'ok' : 'blocked'] }}>status={run.status}</span>
            {typeof run.tokenEstimate === 'number' && (
              <span style={{ fontSize: 12, color: '#555' }}>· 估算 token≈{run.tokenEstimate}</span>
            )}
            <button onClick={saveTrace} style={btnStyle}>💾 保存轨迹</button>
            <button onClick={replayTrace} style={btnStyle}>⤴ 回放</button>
          </div>
          {sinkMsg && <div style={{ fontSize: 12, color: '#2e7d32', marginTop: 4 }}>{sinkMsg}</div>}

          <h2 style={{ fontSize: 18 }}>闭环结果</h2>

          <Section title="① 编排计划（dispatcher 动态拆解）">
            {result ? (
              <>
                <div style={{ fontSize: 13 }}>目标维度：{result.plan.targetDims.join(' / ')}</div>
                <ol style={{ fontSize: 13, margin: '4px 0' }}>{result.plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              </>
            ) : <div style={{ fontSize: 13, color: '#c62828' }}>闭环未产出结果（评委降级）。</div>}
          </Section>

          <Section title="② 执行轨迹（evidence · Agent + Skill 标注）">
            {run.steps.map((s, i) => (
              <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px dashed #eee' }}>
                <span style={{ color: '#3b82f6', fontWeight: 600 }}>[{phaseLabel[s.phase as keyof typeof phaseLabel] ?? s.phase}]</span>{' '}
                <span style={{ color: '#555' }}>{s.agent}</span>
                {s.skill && <span style={{ marginLeft: 6, fontSize: 11, background: '#eef', color: '#336', borderRadius: 4, padding: '1px 6px' }}>skill:{s.skill}</span>}
                <span style={{ marginLeft: 6, fontSize: 11, color: statusColor[s.status] }}>●{s.status}</span>
                ：{s.summary}
              </div>
            ))}
          </Section>

          {result && (
            <>
              <Section title="③ 评估中心结论（evaluator · tool+verify）">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {RADAR_DIMS.map((d) => {
                    const v = result.evaluation.meanRadar[d] ?? 0;
                    return (
                      <div key={d} style={{ width: 150 }}>
                        <div style={{ fontSize: 12 }}>{d}：{v}</div>
                        <div style={{ height: 8, background: '#eee', borderRadius: 4 }}>
                          <div style={{ height: 8, width: `${(v / 5) * 100}%`, background: '#3b82f6', borderRadius: 4 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ fontSize: 13, marginTop: 8 }}>
                  判定：<b>{result.evaluation.verdict}</b> · 置信度：{result.evaluation.confidence} · 来源：{result.evaluation.source}
                </div>
                <div style={{ fontSize: 13 }}>
                  pass^k：allPass={String(result.evaluation.passK.allPass)} · passRate={result.evaluation.passK.passRate} · k={result.evaluation.passK.k}
                </div>
                <div style={{ fontSize: 13, color: result.evaluation.biasAudit.unstable ? '#c62828' : '#555' }}>
                  偏差审计：unstable={String(result.evaluation.biasAudit.unstable)} · maxSpread={result.evaluation.biasAudit.maxSpread}
                </div>
              </Section>

              <Section title="④ 老板拍板（approve · 高风险需人工确认）">
                <div style={{ fontSize: 15, fontWeight: 700, color: actionColor[result.bossDecision.action] }}>
                  {result.bossDecision.action.toUpperCase()}
                </div>
                <div style={{ fontSize: 13 }}>{result.bossDecision.reason}</div>
                <div style={{ fontSize: 12, color: '#777' }}>需人工确认：{String(result.bossDecision.requiresHumanAck)}</div>
              </Section>

              <Section title="⑤ 经验沉淀（precipitate · 可复用规则）">
                <div style={{ fontSize: 13 }}>{result.experience}</div>
                {result.priorExperience.length > 0 && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>
                    复用历史经验 {result.priorExperience.length} 条：{result.priorExperience.map((r) => r.weakestDim).join('/')}
                  </div>
                )}
              </Section>
            </>
          )}

          {replay && (
            <Section title="⤴ 回放结果">
              <div style={{ fontSize: 13 }}>status={replay.status} · steps={replay.steps.length} · tokenEstimate≈{replay.tokenEstimate}</div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, marginTop: 12, fontWeight: 600 };
const taStyle: React.CSSProperties = { width: '100%', minHeight: 64, marginTop: 4, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontFamily: 'inherit' };
const inputStyle: React.CSSProperties = { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', fontFamily: 'inherit' };
const btnStyle: React.CSSProperties = { padding: '6px 12px', fontSize: 13, borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
