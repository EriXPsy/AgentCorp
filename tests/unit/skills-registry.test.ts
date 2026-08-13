import { describe, it, expect } from 'vitest';
import { getSkill, listSkills } from '@/demo/skills/registry';

describe('Skill 注册表（GOAI 复赛必选项 · 2.1 全字段 + 调用入口）', () => {
  it('boss_review 已注册且 handler 为可调用函数', () => {
    expect(getSkill('boss_review')?.handler).toBeTypeOf('function');
  });

  it('5 个 Skill 全部注册（roleCard 4 卡共 5 个唯一 Skill id）', () => {
    expect(listSkills().length).toBe(5);
  });

  it('SkillDefinition 含 2.1 全字段（purpose 等）', () => {
    const def = getSkill('capability_assessment');
    expect(def).toHaveProperty('purpose');
    expect(def).toHaveProperty('inputs');
    expect(def).toHaveProperty('outputs');
    expect(def).toHaveProperty('invokeCondition');
    expect(def).toHaveProperty('dependsOn');
    expect(def).toHaveProperty('failureHandling');
    expect(def).toHaveProperty('securityBoundary');
    expect(def).toHaveProperty('reuseValue');
    expect(def).toHaveProperty('collaboration');
    expect(Array.isArray(def?.dependsOn)).toBe(true);
  });
});
