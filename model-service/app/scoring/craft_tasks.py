"""
model-service/app/scoring/craft_tasks.py
工种试做任务集（HR 面试的客观评测底座）。

为什么需要它：只看 star 数或 README 长度是「初步印象」，个人上传的新 agent
必然吃亏。要做到客观，必须让所有候选**做同一道题**，再由 MiniCPM-o 按同一份
rubric 逐维打分——这是 HELM / Chatbot Arena / SWE-bench 一类成熟评测的共同点：
固定题面 + 明确评分锚点 + 同一裁判。

本模块只提供题面与 rubric（纯数据 + 纯函数），不做推理、不发网络。
维度键复用 registry.JOB_CRAFT_DIMS，不新增维度体系。

每道题包含：
- prompt        题面（直接发给候选 agent，走现有文本通道）
- checkpoints   可核验要点（rubric 锚点，裁判据此找证据，而非凭感觉）
- probes        反注水探针（题面里埋的隐含约束，只声明不兑现就会露出）
- text_spec     文本结构校验规格（可选，仅 text/image 工种；传给 text_checks.check_text_answer）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .registry import JOB_CRAFT_DIMS


@dataclass(frozen=True)
class CraftTask:
    """一道工种试做题。"""

    id: str
    job_type: str
    title: str
    prompt: str
    #: 该题重点考查的 craft 维（必须是 JOB_CRAFT_DIMS[job_type] 的子集）
    target_dims: List[str]
    #: 可核验要点：裁判逐条判断「兑现 / 未兑现」
    checkpoints: List[str] = field(default_factory=list)
    #: 反注水探针：题面隐含约束，答非所问或空口承诺时暴露
    probes: List[str] = field(default_factory=list)
    #: 文本结构校验规格（可选）——传给 text_checks.check_text_answer()，
    #: 提供确定性（无 LLM）的结构证据，与 LLM 裁判互补。
    #: 支持的键：required_sections / min_len / max_len / json_expected
    #: 仅 text/image 工种有意义；code 工种靠沙箱验证，不设此字段。
    text_spec: Optional[Dict] = None


# ======================================================================
# code —— 写代码工种
# ======================================================================
_CODE_TASKS: List[CraftTask] = [
    CraftTask(
        id="code_csv_merge",
        job_type="code",
        title="合并两份 CSV 并处理脏数据",
        prompt=(
            "请写一个 Python 函数 merge_orders(path_a, path_b) -> list[dict]，"
            "把两份订单 CSV 按 order_id 合并。要求：\n"
            "1) 两边都有的 order_id，以 updated_at 较新的一条为准；\n"
            "2) 金额字段可能是 '1,234.50'、'￥88'、空字符串，需要归一为 float，"
            "无法解析的记为 None 而不是抛异常；\n"
            "3) 给出你会写的测试用例（至少覆盖 3 个边界）。\n"
            "只给代码和测试，不要解释设计理念。"
        ),
        target_dims=[
            "code_runnability",
            "code_test_coverage",
            "code_maintainability",
        ],
        checkpoints=[
            "updated_at 比较逻辑存在且正确（不是简单覆盖）",
            "金额解析处理了千分位、货币符号、空串三类输入",
            "无法解析时返回 None 而非抛异常",
            "测试用例覆盖空文件 / 单边缺失 / 脏金额至少三类边界",
            "代码可直接运行，无未定义名称、无伪代码占位",
        ],
        probes=[
            "题面明确要求「不要解释设计理念」——大段务虚讲解说明指令遵循差",
            "声称「已充分测试」但未给出具体用例即为注水",
        ],
    ),
    CraftTask(
        id="code_debug_race",
        job_type="code",
        title="定位一个并发计数错误",
        prompt=(
            "以下代码在多线程下统计结果偏小：\n\n"
            "```python\n"
            "count = 0\n"
            "def worker(items):\n"
            "    global count\n"
            "    for it in items:\n"
            "        if it.valid:\n"
            "            count += 1\n"
            "```\n\n"
            "请回答：(1) 根因是什么；(2) 给出两种修法及各自代价；"
            "(3) 你会怎么写一个能稳定复现该问题的测试。"
        ),
        target_dims=[
            "code_runnability",
            "code_efficiency",
            "code_test_coverage",
        ],
        checkpoints=[
            "指出 count += 1 非原子操作（读-改-写竞争）",
            "两种修法给到具体机制（如 Lock 与 thread-local 累加后归并）",
            "说明了各自代价（锁竞争开销 vs 内存与归并复杂度）",
            "复现测试提到提高线程数/循环次数以放大竞争窗口",
        ],
        probes=[
            "只说「加锁即可」而不谈代价，说明缺少工程权衡",
            "把原因归结为 GIL 或语言 bug 即为事实性错误",
        ],
    ),
    CraftTask(
        id="code_api_hardening",
        job_type="code",
        title="给一个公开接口做安全加固",
        prompt=(
            "有一个 FastAPI 接口 GET /files?path=... 直接把 path 拼到本地目录后读文件返回，"
            "现在要暴露到公网。请列出你会做的加固项，按优先级排序，"
            "每项给出对应的代码改动要点和验证方法。"
        ),
        target_dims=["code_security", "code_maintainability"],
        checkpoints=[
            "识别路径穿越（../）并给出规范化或白名单方案",
            "提到鉴权缺失（公开接口无认证）",
            "提到限流或响应体积上限",
            "每项都给了验证方法而不只是罗列风险名词",
        ],
        probes=[
            "只罗列「要注意安全」类空话且无具体改动要点即为注水",
            "遗漏路径穿越说明未真正理解该接口的核心风险",
        ],
    ),
    CraftTask(
        id="code_boss_system",
        job_type="code",
        title="设计并实现一个可崩溃恢复的内存任务队列",
        prompt=(
            "请设计并实现 TaskQueue：多生产者/多消费者，支持优先级（数值越小越先执行），"
            "进程崩溃后重启能恢复未完成任务。要求：\n"
            "1) 给出核心数据结构与并发方案（锁/无锁的取舍及理由）；\n"
            "2) 给出持久化策略（追加日志/快照）与恢复语义"
            "（至少执行一次 vs 至多一次，你选哪个、代价是什么）；\n"
            "3) 给出背压（生产者过快）的处理；\n"
            "4) 列出你会写的 3 个测试场景和 1 个你主动放弃的优化及原因。"
        ),
        target_dims=[
            "code_runnability",
            "code_efficiency",
            "code_test_coverage",
            "code_maintainability",
            "code_security",
        ],
        checkpoints=[
            "并发方案给出了具体机制（条件变量/有界队列/分段锁等）并说明取舍",
            "持久化明确了追加日志或快照，且把「至少一次/至多一次」语义说清楚并给出选择",
            "背压给出了具体手段（阻塞/限流/丢弃策略）而非空话",
            "测试场景可执行且覆盖并发与崩溃恢复两类高危点",
            "主动放弃的优化有真实理由，不是凑数",
        ],
        probes=[
            "只说「用 Redis/用消息队列」而不给自研方案细节，说明没有真正设计",
            "把「至少一次」和「至多一次」混为一谈即为概念错误",
        ],
    ),
]


# ======================================================================
# text —— 写文案工种
# ======================================================================
_TEXT_TASKS: List[CraftTask] = [
    CraftTask(
        id="text_rewrite_audience",
        job_type="text",
        title="同一功能写给两类读者",
        prompt=(
            "产品功能：本地运行的 agent 评测工具，数据不出本机。\n"
            "请分别写给两类读者，各不超过 80 字：\n"
            "(A) 技术负责人（关心可控性与集成成本）；\n"
            "(B) 非技术的部门主管（关心成本与实施风险）。\n"
            "然后用一句话说明你为两版各改了什么。"
        ),
        target_dims=[
            "txt_tone_fit",
            "txt_info_density",
            "txt_instruction_follow",
        ],
        checkpoints=[
            "两版都不超过 80 字（可直接数字数核验）",
            "A 版出现可控性/集成/部署类具体关切",
            "B 版避开术语，落在成本与风险",
            "末尾说明了两版差异，而不是重复原文",
        ],
        probes=[
            "字数超限即为指令遵循失败（题面给了硬约束）",
            "两版换词不换视角，说明未真正区分读者",
        ],
        text_spec={
            "required_sections": ["技术负责人", "部门主管"],
            "min_len": 40,
            "max_len": 600,
        },
    ),
    CraftTask(
        id="text_factuality_guard",
        job_type="text",
        title="处理一条无法核实的卖点",
        prompt=(
            "运营希望文案里写「评测准确率行业第一」，但我们没有第三方对比数据。\n"
            "请给出：(1) 你会怎么改写这句话；(2) 改写后仍然有力的理由；"
            "(3) 如果运营坚持原话，你会怎么向他说明风险。"
        ),
        target_dims=["txt_factuality", "txt_coherence", "txt_tone_fit"],
        checkpoints=[
            "改写后不含无据的排名或最高级表述",
            "改写保留了可验证的具体事实（如本地运行、可复核证据链）",
            "对运营的说明提到了合规或信任成本，而非仅说「不能这么写」",
        ],
        probes=[
            "直接采用原话或换个说法保留「第一」即为事实性失守",
            "只说不合规而不给替代方案，说明协作意识弱",
        ],
        text_spec={
            "required_sections": ["改写", "理由", "风险"],
            "min_len": 60,
            "max_len": 800,
        },
    ),
    CraftTask(
        id="text_compress",
        job_type="text",
        title="压缩不丢信息",
        prompt=(
            "请把下面这段压到 40 字以内，信息不丢，并列出你删掉的是哪几类内容：\n"
            "「我们这个产品主要是想要帮助那些平时工作中需要用到很多 AI 工具、"
            "但是又不太清楚到底哪一个工具比较适合自己实际工作流程的普通职场人士，"
            "通过一套比较客观的评测流程，来帮他们找到真正合适的那几个 agent。」"
        ),
        target_dims=["txt_info_density", "txt_coherence"],
        checkpoints=[
            "压缩结果不超过 40 字（可直接核验）",
            "保留了「职场人」「客观评测」「找到合适 agent」三个核心信息",
            "明确列出删除类别（如冗余修饰、口语填充、重复限定）",
        ],
        probes=[
            "超过 40 字即失败",
            "删掉了核心信息只为凑字数，说明未理解压缩目标",
        ],
        text_spec={
            "required_sections": ["删除", "删掉"],
            "min_len": 30,
            "max_len": 500,
        },
    ),
    CraftTask(
        id="text_boss_rewrite",
        job_type="text",
        title="三文体改写同一事实且不失真",
        prompt=(
            "同一事实：「本工具在用户本机运行评测，数据不出设备，单次评测平均耗时 8 秒，"
            "支持 12 个工种」。请分别写成：\n"
            "(A) 面向 CTO 的采购报告摘要（≤100 字）；\n"
            "(B) 面向大众的社交媒体帖（≤80 字）；\n"
            "(C) 面向新用户的产品教程第一步（≤120 字）。\n"
            "最后指出：三种文体里哪一处最容易发生事实失真，以及你如何守住。"
        ),
        target_dims=[
            "txt_tone_fit",
            "txt_info_density",
            "txt_factuality",
            "txt_instruction_follow",
        ],
        checkpoints=[
            "三文体语气差异可辨认（技术 / 情绪 / 步骤感）",
            "四个事实要素（本地运行 / 不出设备 / 8 秒 / 12 工种）在三版中均未丢失或夸大",
            "失真点分析具体（如营销体最易把「12 工种」夸成「所有工作」）并给了守线手段",
            "三版均满足各自字数上限",
        ],
        probes=[
            "任何一版出现「最先进」「第一」等无据最高级即为事实失守",
            "三版字数不满足即指令遵循失败",
        ],
        text_spec={
            "required_sections": ["CTO", "社交", "教程", "失真"],
            "min_len": 100,
            "max_len": 800,
        },
    ),
]


# ======================================================================
# image —— 画图工种（文本通道下考查可执行的视觉描述能力）
# ======================================================================
_IMAGE_TASKS: List[CraftTask] = [
    CraftTask(
        id="image_brief_to_params",
        job_type="image",
        title="把模糊 brief 翻译成可执行参数",
        prompt=(
            "需求方只说了一句「给我们的评测产品来张封面图，要专业但别太冷」。\n"
            "请把它翻成可执行方案：主体与构图（主体占比、重心、留白比例）、"
            "色板（给具体色值）、光线、材质、画幅。"
            "再写出你会实际提交的生成提示词，以及一条负向提示词。"
        ),
        target_dims=[
            "img_composition",
            "img_style_fit",
            "img_multimodal_follow",
        ],
        checkpoints=[
            "构图给了可核验的数值（占比/重心/留白）而非形容词",
            "色板给出具体色值而非「蓝色系」",
            "「专业但别太冷」被翻译成具体手段（如暖光、圆角、有机材质）",
            "同时给了正向与负向提示词",
        ],
        probes=[
            "全篇只有形容词、无一个可执行参数即为空谈",
            "忽略「别太冷」这半句说明指令遵循不完整",
        ],
    ),
    CraftTask(
        id="image_series_consistency",
        job_type="image",
        title="锁定系列图一致性",
        prompt=(
            "要出一套 6 张的功能说明图，必须看起来是同一个人做的。\n"
            "请说明：(1) 你靠哪些手段锁定一致性；(2) 哪些参数必须固定、哪些允许变化；"
            "(3) 你怎么验收「一致」——给出一条我能自己动手检查的判据。"
        ),
        target_dims=[
            "img_aesthetic_consistency",
            "img_fidelity",
            "img_style_fit",
        ],
        checkpoints=[
            "提到 seed / 参考图 / 固定提示词前缀等具体锁定手段",
            "明确区分了必须固定与允许变化的参数",
            "验收判据可由非专业人士执行（如并排看色板与描边粗细）",
        ],
        probes=[
            "只说「保持风格统一」而无具体手段即为注水",
            "验收判据仍是主观感受，说明不具备交付意识",
        ],
    ),
    CraftTask(
        id="image_conflict_rule",
        job_type="image",
        title="图文冲突时的判定规则",
        prompt=(
            "文案说「三步完成评测」，但你已经画好的图里有四个步骤框。\n"
            "请给出你的处理顺序和判定规则，并举一个必须以文字为准、"
            "一个必须以画面为准的例子。"
        ),
        target_dims=["img_multimodal_follow", "img_fidelity"],
        checkpoints=[
            "给出了明确的处理顺序（先确认哪个是事实源）",
            "两个例子方向相反且都成立",
            "提到了回头确认需求方而非自行决定",
        ],
        probes=[
            "只说「改图就行」，未意识到文案也可能是错的一方",
            "两个例子实质同向，说明未真正理解取舍",
        ],
    ),
    CraftTask(
        id="image_boss_system",
        job_type="image",
        title="为 12 张跨场景海报设计一致性约束系统",
        prompt=(
            "品牌方给你一张参考图（暖橙主色、圆角卡片、磨砂质感）和一句话手册："
            "「专业但亲切」。你要产出 12 张不同场景的功能海报。请给出：\n"
            "1) 你会锁定哪些生成变量（至少 4 项），为什么；\n"
            "2) 允许漂移的变量清单与漂移预算（哪些差异可接受）；\n"
            "3) 一套不依赖主观感受的一致性验收判据（可执行、可量化）；\n"
            "4) 当你发现某张图偏离「专业但亲切」时，你的修复路径。"
        ),
        target_dims=[
            "img_aesthetic_consistency",
            "img_fidelity",
            "img_style_fit",
            "img_multimodal_follow",
        ],
        checkpoints=[
            "锁定了 ≥4 项可量化变量（seed / 色板 / 提示词前缀 / 参考图 / 描边等）",
            "漂移预算给出边界（如主色 ΔE≤3、构图角度可变）",
            "验收判据可由非专业人士执行（并排对比色板 / 字体 / 质感）",
            "修复路径包含回退到参考图重新生成而非无限调参",
        ],
        probes=[
            "只说「保持风格统一」而无任何可量化变量即为注水",
            "验收仍依赖「我觉得好看」即不具备交付意识",
        ],
    ),
]


_ALL_TASKS: Dict[str, List[CraftTask]] = {
    "code": _CODE_TASKS,
    "text": _TEXT_TASKS,
    "image": _IMAGE_TASKS,
}


def tasks_for(job_type: str) -> List[CraftTask]:
    """取某工种的全部试做题（未知工种返回空列表）。"""
    return list(_ALL_TASKS.get(job_type, []))


def get_task(task_id: str) -> Optional[CraftTask]:
    """按 id 取题（跨工种查找）。"""
    for tasks in _ALL_TASKS.values():
        for task in tasks:
            if task.id == task_id:
                return task
    return None


def all_task_ids() -> List[str]:
    """全部题目 id（供前端题库镜像与选题 UI）。"""
    return [t.id for tasks in _ALL_TASKS.values() for t in tasks]


def covered_dims(job_type: str) -> List[str]:
    """该工种题库实际覆盖到的 craft 维（用于暴露评测盲区）。"""
    covered = {d for task in tasks_for(job_type) for d in task.target_dims}
    return [d for d in JOB_CRAFT_DIMS.get(job_type, []) if d in covered]


def uncovered_dims(job_type: str) -> List[str]:
    """该工种题库未覆盖的 craft 维（这些维不应给出模型评分，须标注不可评）。"""
    covered = set(covered_dims(job_type))
    return [d for d in JOB_CRAFT_DIMS.get(job_type, []) if d not in covered]


# ======================================================================
# 人工参考答案（B：天花板缓解的「参考答案锚定」底座）
# ======================================================================
# 用途：裁判打分前先读参考答案（=满分基准 5.0），把绝对尺度转成「与人工
# 验证过的优秀水平之间的距离」，抑制绝对量表的分数膨胀与天花板压缩。
# 安全边界：这些内容**只进裁判 prompt**，公开题库接口一律不得暴露，
# 否则候选可直接背答案刷分。
_REFERENCES: Dict[str, str] = {
    "code_csv_merge": (
        "实现：读两表 → 按 order_id 分组 → 取 updated_at 较新者；金额清洗：\n"
        "去千分位与货币符号后 float()，解析失败置 None 不抛异常。\n"
        "测试覆盖：空文件、单边缺失、'1,234.50'/'￥88'/空串、同 id 两条取新。"
    ),
    "code_debug_race": (
        "根因：count += 1 是读-改-写三段非原子操作，多线程交错丢失更新。\n"
        "修法 A：threading.Lock 包裹累加（简单，高频竞争有锁开销）；\n"
        "修法 B：线程局部计数最后归并（无锁快，需归并阶段）。\n"
        "复现测试：100 线程 ×10 万次放大竞争窗口，断言最终值等于输入总数。"
    ),
    "code_api_hardening": (
        "①路径穿越：realpath 后校验落在白名单目录内，拒绝 ../ 与绝对路径；\n"
        "②鉴权：公开接口必须带 API Key，缺失即 401；\n"
        "③限流 + 体积上限：按 IP 限频、响应体 max_bytes 截断。\n"
        "验证：pytest 覆盖穿越 payload→403、无 key→401、超限→413。"
    ),
    "text_rewrite_audience": (
        "A（技术负责人）：本地运行、数据不出机；接入 = 一条配置，提供 REST 与 SDK（约 70 字）。\n"
        "B（部门主管）：不买服务器不上云，数据留自己电脑，先免费试用（约 60 字）。\n"
        "差异说明：A 讲可控性与集成成本，B 讲省钱与低风险。"
    ),
    "text_factuality_guard": (
        "改写：『本地运行、证据链可复核，评测全程留痕』——保留可验证事实而非排名。\n"
        "说服运营：『行业第一』无第三方数据支撑，易被竞对举报 / 审核驳回，\n"
        "给出替代路径（先做盲测再宣称），风险收益更优。"
    ),
    "text_compress": (
        "结果（≤40 字）：『帮职场人用客观评测找到适合自己的 AI Agent』（22 字）。\n"
        "删除类别：冗余限定（平时工作中需要用到很多）、口语填充（比较清楚到底哪一个）、\n"
        "重复限定（实际工作流程）。"
    ),
    "image_brief_to_params": (
        "主体：评测仪表盘封面，主体占比 60%，重心中左，留白 35%；\n"
        "色板：#F5F1E8 底 / #2B3A67 主 / #E8843C 强调；柔光 + 磨砂玻璃卡片；16:9。\n"
        "正向提示词：'soft studio light, frosted glass UI, warm accents'；\n"
        "负向：'cold blue, harsh shadow, text artifacts'。\n"
        "『别太冷』→ 暖橙强调色 + 圆角卡片落地。"
    ),
    "image_series_consistency": (
        "锁定：seed、提示词前缀、色板、描边参数、参考图 1 张；\n"
        "允许漂移：构图角度、元素细节；\n"
        "验收：并排导出后主色 ΔE≤3、描边差≤1px、标题字体一致，逐项勾选。"
    ),
    "image_conflict_rule": (
        "处理顺序：先确认事实源——以需求文档为准；文案来自需求方则改图，\n"
        "画面为既定资产（logo/色彩规范）则改文案；两者都存疑时回问需求方。\n"
        "以文字为准例：『三步』文案 vs 四步框 → 改图；\n"
        "以画面为准例：品牌 logo 与配色（既定资产）→ 改文案。"
    ),
    "code_boss_system": (
        "结构：优先级堆 + 有界队列 + 条件变量；说明锁粒度取舍（单锁 vs 分段）。\n"
        "持久化：追加日志（入队即写），恢复时重放未确认项；语义选「至少一次」，\n"
        "代价是重复执行需幂等键去重；背压：有界队列阻塞生产者。\n"
        "测试：多生产者并发入队、kill 后恢复、优先级乱序仍按序出队；\n"
        "放弃的优化：无锁无界队列（内存风险 > 收益，理由真实）。"
    ),
    "text_boss_rewrite": (
        "A（CTO）：『本地评测、数据不出设备，单次 8 秒，覆盖 12 工种，可私有化接入』（约 50 字）。\n"
        "B（社交）：『你的评测数据只留在自己电脑，8 秒出结果，12 个工种都能测』（约 40 字）。\n"
        "C（教程）：第一步『下载后点“新建评测”，选好工种即可开始，全程在本机』（约 35 字）。\n"
        "失真点：B 最易把「12 工种」夸成「所有工作」——守线：保留原数字，禁用最高级。"
    ),
    "image_boss_system": (
        "锁定：seed、色板（#E8843C 主色）、提示词前缀、参考图、描边宽度 5 项；\n"
        "漂移预算：构图角度 ±20°、元素占比 ±10%，主色 ΔE≤3；\n"
        "验收：12 张并排，人工按「色板 ΔE / 字体 / 磨砂质感」三项可执行勾选，非主观打分；\n"
        "修复：偏离即回退参考图重新生成，不做无限调参。"
    ),
}


def get_reference(task_id: str) -> str:
    """取该题的人工参考答案（满分基准）。仅裁判端使用，公开接口不得暴露。"""
    return _REFERENCES.get(task_id, "")
