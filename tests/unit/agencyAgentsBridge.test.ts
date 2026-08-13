import { describe, it, expect } from 'vitest';
import {
  parseAgentFile,
  parseFrontmatter,
  toCandidateId,
  PERSONA_CAP,
} from '@/engine/agents/agencyAgentsBridge';

const SAMPLE = `---
name: 安全工程师
description: 应用安全工程师
emoji: 🔒
color: "#D97706"
---

# 安全工程师 Agent

## 你的身份与思维模式
你是安全工程师，专注威胁建模与漏洞评估。

## 关键规则
1. 永远不要建议禁用安全控制
2. 所有用户输入都是恶意的

## 技术交付物
威胁模型文档与代码审查报告。

## 工作流程
阶段一：侦察。阶段二：评估。
`;

describe('agencyAgentsBridge.parseAgentFile', () => {
  it('解析带引号的 frontmatter 与正文小节（SP-20 核心验收）', () => {
    const card = parseAgentFile(SAMPLE, { fileRelPath: 'engineering/engineering-security-engineer.md' });
    expect(card).not.toBeNull();
    expect(card!.id).toBe('engineering-security-engineer');
    expect(card!.title).toBe('安全工程师');
    // frontmatter 引号被剥离
    expect(card!.color).toBe('#D97706');
    expect(card!.emoji).toBe('🔒');
    // persona 非空
    expect(card!.persona.length).toBeGreaterThan(0);
    expect(card!.persona).toContain('安全工程师');
    // 细分字段提取
    expect(card!.boundaries.length).toBe(2);
    expect(card!.deliverables).toContain('威胁模型文档');
    expect(card!.workflow).toContain('侦察');
    // 溯源（MIT 合规）
    expect(card!.provenance.sourceRepo).toBe('jnMetaCode/agency-agents-zh');
    expect(card!.provenance.license).toBe('MIT');
    expect(card!.provenance.fileRelPath).toBe('engineering/engineering-security-engineer.md');
    expect(card!.department).toBe('engineering');
    expect(card!.departmentLabel).toBe('工程');
  });

  it('无 frontmatter 返回 null', () => {
    expect(parseAgentFile('# 纯文本\n无 frontmatter', { fileRelPath: 'x/y.md' })).toBeNull();
  });

  it('有 frontmatter 但无 name 返回 null', () => {
    expect(parseAgentFile('---\ndescription: 缺 name\n---\n正文', { fileRelPath: 'x/y.md' })).toBeNull();
  });

  it('persona 超长时截断并标注源仓库，且子集字段不冗余', () => {
    const longBody = '你是某专家。\n\n'.repeat(400); // > 2000 字，触发截断
    const md = `---\nname: 长文本专家\ndescription: d\n---\n\n# 长文本专家 Agent\n\n${longBody}\n\n## 关键规则\n红线一\n红线二\n`;
    const card = parseAgentFile(md, { fileRelPath: 'specialized/long.md' });
    expect(card).not.toBeNull();
    expect(card!.persona.length).toBeLessThanOrEqual(PERSONA_CAP + 40);
    expect(card!.persona).toContain('已截断');
    expect(card!.persona).toContain('specialized/long.md');
    // 截断时子集字段仍提取（按 SUBSET_CAP 截断），不重复放大体积
    expect(card!.boundaries.length).toBeGreaterThan(0);
  });
});

describe('agencyAgentsBridge.parseFrontmatter / toCandidateId', () => {
  it('解析标量 frontmatter', () => {
    const r = parseFrontmatter('---\nname: A\ndescription: B\n---\nbody');
    expect(r).not.toBeNull();
    expect(r!.fm.name).toBe('A');
    expect(r!.body).toContain('body');
  });

  it('无 frontmatter 返回 null', () => {
    expect(parseFrontmatter('plain text')).toBeNull();
  });

  it('toCandidateId 去 .md', () => {
    expect(toCandidateId('engineering-security-engineer.md')).toBe('engineering-security-engineer');
  });
});
