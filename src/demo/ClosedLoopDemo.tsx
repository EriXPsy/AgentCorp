/**
 * GOAI 多 Agent 闭环演示页（web 预览 5174 可用，路径 /demo.html）。
 * 展示 boss → recruiter → evaluator → boss 端到端闭环，并把每一步对齐 GOAI 八步闭环。
 * 评委默认走 demoJudge（真实网关可达用真评委，否则降级 mock，闭环永不中断）。
 */
import { useState } from 'react';
import { ROLE_CARDS } from '@/engine/agents/roleCard';
import { runClosedLoop, phaseLabel, type ClosedLoopResult, type ClosedLoopRequest, type LoopStep } from './closedLoop';
import { demoJudge } from './liveJudge';
import { RADAR_DIMS } from '@/engine/scoring/registry';

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

export default function ClosedLoopDemo() {
  const [req, setReq] = useState({ ...SAMPLE, candidateId: 'fe-agent-07' });
  const [result, setResult] = useState<ClosedLoopResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const payload: ClosedLoopRequest = {
        requirement: req.requirement,
        candidateId: req.candidateId,
        candidateName: req.candidateName,
        candidatePersona: req.candidatePersona,
        transcript: req.transcript,
        k: 3,
        threshold: 3.5,
        judge: demoJudge,
      };
      const res = await runClosedLoop(payload);
      setResult(res);
    } finally {
      setRunning(false);
    }
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

      <button onClick={run} disabled={running} style={{ marginTop: 12, padding: '10px 18px', fontSize: 15, borderRadius: 8, border: 'none', background: '#1a1c1e', color: '#fff', cursor: running ? 'default' : 'pointer' }}>
        {running ? '运行中…' : '▶ 运行闭环（boss→recruiter→evaluator→boss）'}
      </button>

      {result && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18 }}>闭环结果</h2>

          <Section title="① 编排计划（dispatcher 拆解）">
            <div style={{ fontSize: 13 }}>目标维度：{result.plan.targetDims.join(' / ')}</div>
            <ol style={{ fontSize: 13, margin: '4px 0' }}>{result.plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </Section>

          <Section title="② 评估中心结论（evaluator · tool+verify）">
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

          <Section title="③ 老板拍板（approve · 高风险需人工确认）">
            <div style={{ fontSize: 15, fontWeight: 700, color: actionColor[result.bossDecision.action] }}>
              {result.bossDecision.action.toUpperCase()}
            </div>
            <div style={{ fontSize: 13 }}>{result.bossDecision.reason}</div>
            <div style={{ fontSize: 12, color: '#777' }}>需人工确认：{String(result.bossDecision.requiresHumanAck)}</div>
          </Section>

          <Section title="④ 经验沉淀（precipitate · 可复用规则）">
            <div style={{ fontSize: 13 }}>{result.experience}</div>
          </Section>

          <Section title="⑤ 全链路执行轨迹（evidence · Trace）">
            {result.trace.map((s: LoopStep, i: number) => (
              <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px dashed #eee' }}>
                <span style={{ color: '#3b82f6', fontWeight: 600 }}>[{phaseLabel[s.phase]}]</span>{' '}
                <span style={{ color: '#555' }}>{s.agentName}：</span>{s.summary}
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, marginTop: 12, fontWeight: 600 };
const taStyle: React.CSSProperties = { width: '100%', minHeight: 64, marginTop: 4, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontFamily: 'inherit' };
const inputStyle: React.CSSProperties = { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', fontFamily: 'inherit' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
