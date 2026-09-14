/**
 * tests/unit/taskTemplates.test.ts
 *
 * 「知识炼金」任务模板（知乎黑客松 · 知识炼金场）：
 * - matchTaskTemplate 命中/未命中判定
 * - 模板五阶段结构契约（S1~S5、requiredSections、acceptance）
 * - buildTemplateDeliverableFiles 四件套拆分 / 缺部分回退 null
 * - 编排集成：命中模板跳过 LLM 拆解（DECOMPOSE 零调用），五阶段按序指派执行
 */
import { describe, it, expect } from 'vitest';
import {
  matchTaskTemplate,
  buildTemplateDeliverableFiles,
  KNOWLEDGE_SECTIONS,
} from '@/engine/squad/taskTemplates';
import {
  runSquadOrchestration,
  type OrchestrationInput,
  type SubTaskResult,
} from '@/engine/squad/squadOrchestration';
import type { ChatMessage } from '@/engine/squad/squadCollaboration';

describe('matchTaskTemplate 命中判定', () => {
  it('含「知乎」命中知识炼金', () => {
    expect(matchTaskTemplate('如何系统学习分布式？ - 知乎')?.id).toBe('knowledge-alchemy');
  });
  it('知乎链接命中', () => {
    expect(matchTaskTemplate('整理这个问题 https://www.zhihu.com/question/123456')?.id).toBe('knowledge-alchemy');
  });
  it('显式「知识炼金」命中', () => {
    expect(matchTaskTemplate('知识炼金：大学生如何规划第一份工作')?.id).toBe('knowledge-alchemy');
  });
  it('普通开发任务不命中', () => {
    expect(matchTaskTemplate('给官网加一个登录页')).toBeNull();
  });
});

describe('知识炼金模板结构契约', () => {
  const tpl = matchTaskTemplate('知乎问题')!;
  const stages = tpl.buildSubtasks('测试问题');

  it('固定五阶段 S1~S5 按序', () => {
    expect(stages.map((s) => s.title.slice(0, 2))).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
  });

  it('指派一律留空（交给 ASSIGN 路由），且每条都有验收清单', () => {
    for (const st of stages) {
      expect(st.assigneeId).toBeUndefined();
      expect(st.acceptance?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('S3/S5 交付契约为四件套标题', () => {
    expect(stages[2].requiredSections).toEqual([...KNOWLEDGE_SECTIONS]);
    expect(stages[4].requiredSections).toEqual([...KNOWLEDGE_SECTIONS]);
  });
});

const FINAL_OUTPUT = `
## 知识卡片
| 问题 | 答案 |
|---|---|
| 什么是分布式？ | 多机协同的系统 |

## 知识清单
- 必会：CAP
- 应会：共识算法

## 思维导图
- 分布式
  - 一致性
  - 可用性

## 学习路径
- 第 1 周：CAP 与 BASE（自测：默写取舍场景）
`;

function st(title: string, output: string | null): SubTaskResult {
  return { title, assigneeId: 'm1', assignedBy: 'routing', approved: true, rounds: 1, output, verdict: 'PASS' };
}

describe('buildTemplateDeliverableFiles 四件套拆分', () => {
  it('S5 产出含四标题 → 拆成 5 个文件（含 00 汇总）', () => {
    const files = buildTemplateDeliverableFiles([st('S5 终稿整合', FINAL_OUTPUT)], '汇总内容')!;
    expect(files.map((f) => f.name)).toEqual([
      '00-交付汇总.md', '知识卡片.md', '知识清单.md', '思维导图.md', '学习路径.md',
    ]);
    expect(files[1].content).toContain('## 知识卡片');
    expect(files[1].content).toContain('| 问题 | 答案 |');
  });

  it('缺任一部分 → 返回 null（回退默认构建）', () => {
    const broken = FINAL_OUTPUT.replace('## 学习路径', '## 别的标题');
    expect(buildTemplateDeliverableFiles([st('S5 终稿整合', broken)], '汇总')).toBeNull();
  });

  it('子任务都没有时看汇总；汇总也没有 → null', () => {
    expect(buildTemplateDeliverableFiles([st('S5 终稿整合', null)], FINAL_OUTPUT)!.length).toBe(5);
    expect(buildTemplateDeliverableFiles([st('S5 终稿整合', null)], '无关汇总')).toBeNull();
  });
});

describe('编排集成：命中模板跳过 LLM 拆解', () => {
  function templateInput(calls: { agentId: string; sys: string }[]): OrchestrationInput {
    return {
      taskId: 'task-zhihu',
      taskTitle: '如何系统学习分布式？ - 知乎',
      taskDescription: '整理这个知乎问题的高赞讨论，产出学习资料',
      team: { id: 'team-1', name: '测试团队', leaderId: 'leader', memberIds: ['m1', 'm2'] } as OrchestrationInput['team'],
      candidates: [
        { agentId: 'leader', active: true, userFit: 50 },
        { agentId: 'm1', active: true, userFit: 90 },
        { agentId: 'm2', active: true, userFit: 80 },
      ],
      chat: async (agentId, msgs: ChatMessage[]) => {
        const sys = msgs[0]?.content ?? '';
        calls.push({ agentId, sys });
        // 拆解一旦被调用直接判失败：模板任务不该产生 DECOMPOSE LLM 调用
        if (sys.includes('拆解')) throw new Error('模板任务不应触发 LLM 拆解');
        // 审阅先于汇总判定：S1 子任务标题含「汇总」，审阅 prompt 会带出标题
        if (sys.includes('审阅') || sys.includes('盲审')) return 'PASS';
        if (sys.includes('汇总')) return '汇总交付物';
        if (sys.includes('交叉评审') || sys.includes('重规划') || sys.includes('开工确认') || sys.includes('批量解答')) return 'OK';
        // 成员执行：产出覆盖所有 requiredSections 关键词，机检必过
        return '资料要点 来源清单 正方观点 反方观点 争议焦点 事实核查 修正说明\n' + FINAL_OUTPUT;
      },
    };
  }

  it('五阶段按序指派、DECOMPOSE 零调用、全部交付', async () => {
    const calls: { agentId: string; sys: string }[] = [];
    const result = await runSquadOrchestration(templateInput(calls));

    expect(result.subtasks.map((s) => s.title)).toEqual([
      'S1 资料汇总', 'S2 观点对照', 'S3 结构化产出', 'S4 交叉校验', 'S5 终稿整合',
    ]);
    expect(result.subtasks.every((s) => s.approved)).toBe(true);
    // 没有任何一条 system 包含「拆解」指令
    expect(calls.some((c) => c.sys.includes('拆解'))).toBe(false);
    // 五件套文件可从 S5 产出拆出
    const files = buildTemplateDeliverableFiles(result.subtasks, result.deliverable)!;
    expect(files.map((f) => f.name)).toContain('思维导图.md');
  });
});
