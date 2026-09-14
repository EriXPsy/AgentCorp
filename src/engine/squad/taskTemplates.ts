/**
 * src/engine/squad/taskTemplates.ts
 * 任务流程模板：命中特定场景的任务跳过 LLM 自由拆解（DECOMPOSE），
 * 直接按预置阶段执行。模板自带 acceptance 验收清单与 requiredSections
 * 交付契约，复用编排器既有的机检/审阅/返工链路，零特殊分支。
 *
 * 首个模板：「知识炼金」（知乎黑客松 2026 · 知识炼金场赛道）。
 * 用户在团队群聊贴一个知乎问题（或显式说"知识炼金"），团队按固定五阶段
 * 产出知识四件套：知识卡片 / 知识清单 / 思维导图 / 学习路径。
 *
 * 交付物拆分：S5 终稿要求用 `## 知识卡片` 等固定标题组织，
 * buildTemplateDeliverableFiles 按标题切成四个独立 .md 文件；
 * 拆不出来（模型没按格式）返回 null，调用方回退默认交付文件构建。
 */
import type { DeliverableFile } from './deliverableFiles';
import type { OrchestrationSubTask, SubTaskResult } from './squadOrchestration';

export interface TaskTemplate {
  id: string;
  /** 展示名（实况发言 / trace 用） */
  name: string;
  /** 命中判定：taskText = 任务标题 + 描述 */
  match: (taskText: string) => boolean;
  /** 预置阶段子任务；assigneeId 一律留空，交给 ASSIGN 路由兜底。 */
  buildSubtasks: (taskTitle: string) => OrchestrationSubTask[];
}

/** 知识四件套的固定部分标题（requiredSections 契约 + 文件拆分锚点共用）。 */
export const KNOWLEDGE_SECTIONS = ['知识卡片', '知识清单', '思维导图', '学习路径'] as const;

const knowledgeAlchemy: TaskTemplate = {
  id: 'knowledge-alchemy',
  name: '知识炼金',
  match: (taskText) => /知乎|zhihu\.com|知识炼金/i.test(taskText),
  buildSubtasks: (taskTitle) => [
    {
      title: 'S1 资料汇总',
      instruction:
        `围绕原问题「${taskTitle}」做资料与要点汇总：梳理问题背景、核心概念、` +
        '高赞讨论中的关键论据与数据。要求：每条要点注明来源（知乎回答/官方文档/公开数据），' +
        '存疑或无法验证的信息明确标注，不得编造。',
      acceptance: ['要点不少于 8 条', '每条要点有来源标注', '存疑信息单独列出'],
      requiredSections: ['资料要点', '来源清单'],
    },
    {
      title: 'S2 观点对照',
      instruction:
        '基于 S1 的汇总，把讨论中的观点按立场对照整理：主流共识、少数派/反对意见、' +
        '尚未有定论的争议焦点。要求：每个观点给出代表性论据，不预设立场。',
      acceptance: ['至少覆盖两种不同立场', '争议焦点单独成节', '每个观点有论据支撑'],
      requiredSections: ['正方观点', '反方观点', '争议焦点'],
    },
    {
      title: 'S3 结构化产出',
      instruction:
        '把 S1+S2 的材料炼成知识四件套初稿，四个部分分别以二级标题开头：\n' +
        '## 知识卡片（Anki 式问答对表格：| 问题 | 答案 |，不少于 10 张）\n' +
        '## 知识清单（要点按 必会/应会/了解 三级分级）\n' +
        '## 思维导图（Markdown 缩进大纲，中心主题→分支→叶子，兼容 Markmap 渲染）\n' +
        '## 学习路径（按周排的阶段计划，每周含目标与自测点）',
      acceptance: ['四部分齐全且标题严格为指定二级标题', '知识卡片不少于 10 张', '学习路径含自测点'],
      requiredSections: [...KNOWLEDGE_SECTIONS],
    },
    {
      title: 'S4 交叉校验',
      instruction:
        '对 S3 初稿做事实性回查：抽查关键数据/结论是否与 S1 来源一致，' +
        '指出错误并给出修正值；检查四件套之间口径一致（卡片答案与清单要点不打架）。',
      acceptance: ['关键数据全部回查', '修正值注明依据', '四件套口径一致'],
      requiredSections: ['事实核查', '修正说明'],
    },
    {
      title: 'S5 终稿整合',
      instruction:
        '按 S4 校验意见修订并输出终稿。终稿必须且只含四个部分，' +
        '每部分以二级标题开头（## 知识卡片 / ## 知识清单 / ## 思维导图 / ## 学习路径），' +
        '标题文字不得改动（交付系统按标题拆分成四个独立文件）。',
      acceptance: ['四个二级标题严格一致', 'S4 指出的问题已全部修订', '终稿可直接交付学习者使用'],
      requiredSections: [...KNOWLEDGE_SECTIONS],
    },
  ],
};

const TEMPLATES: TaskTemplate[] = [knowledgeAlchemy];

/**
 * 「知识炼金」快速开始的预填草稿（Plan B：不接知乎 API，用户手动粘贴）。
 * 返回的标题/描述自带模板命中词（知识炼金 / 知乎），粘贴即触发五阶段流程；
 * UI 层（新建团队任务弹窗）只做填充，不内联文案，方便单测锁住契约。
 */
export function buildKnowledgeAlchemyDraft(): { title: string; description: string } {
  return {
    title: '知识炼金：',
    description:
      '知乎问题链接：\n\n' +
      '问题/回答正文粘贴处：\n\n' +
      '（团队将按「资料汇总 → 观点对照 → 结构化产出 → 交叉校验 → 终稿整合」五阶段，' +
      '炼出知识四件套：知识卡片 / 知识清单 / 思维导图 / 学习路径）',
  };
}

/** 命中第一个匹配的模板；未命中返回 null（走默认 LLM 拆解）。 */
export function matchTaskTemplate(taskText: string): TaskTemplate | null {
  const text = taskText ?? '';
  for (const tpl of TEMPLATES) {
    try {
      if (tpl.match(text)) return tpl;
    } catch {
      /* 单个模板判定异常不影响其它模板 */
    }
  }
  return null;
}

const SECTION_HEADER_RE = /^\s{0,3}#{1,4}\s*(知识卡片|知识清单|思维导图|学习路径)\s*$/;

/**
 * 知识炼金交付文件构建：从产出文本按四件套标题切分成独立 .md。
 * 产出取「最后一个包含全部四部分标题的子任务产出」，都没有则看汇总；
 * 都拆不出来返回 null（调用方回退 buildDeliverableFiles）。
 */
export function buildTemplateDeliverableFiles(
  subtasks: SubTaskResult[],
  summary: string,
): DeliverableFile[] | null {
  const candidate =
    [...subtasks].reverse().find((st) => st.output && KNOWLEDGE_SECTIONS.every((s) => st.output!.includes(s)))
      ?.output ?? (KNOWLEDGE_SECTIONS.every((s) => summary.includes(s)) ? summary : null);
  if (!candidate) return null;

  const lines = candidate.split(/\r?\n/);
  const buckets = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const m = SECTION_HEADER_RE.exec(line);
    if (m) {
      current = m[1];
      if (!buckets.has(current)) buckets.set(current, []);
    }
    if (current) buckets.get(current)!.push(line);
  }
  // 四个部分都切到才算成功；缺任何一个都回退默认构建（诚实，不硬凑）。
  if (!KNOWLEDGE_SECTIONS.every((s) => (buckets.get(s)?.join('\n').trim().length ?? 0) > 0)) {
    return null;
  }

  const files: DeliverableFile[] = [{ name: '00-交付汇总.md', content: summary }];
  for (const sec of KNOWLEDGE_SECTIONS) {
    files.push({ name: `${sec}.md`, content: buckets.get(sec)!.join('\n').trim() });
  }
  return files;
}
