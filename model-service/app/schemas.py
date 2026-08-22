"""
model-service/app/schemas.py
后端 Pydantic 契约（与前端 src/types/index.ts 严格镜像。

任何一端改动数据结构，必须同步另一端。
"""
from __future__ import annotations

from enum import Enum
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, ConfigDict, AliasGenerator
from pydantic.alias_generators import to_camel


class RadarDim(str, Enum):
    TASK = "task"
    QUALITY = "quality"
    COMM = "comm"
    CREATIVITY = "creativity"
    RELIABILITY = "reliability"
    COST = "cost"


class Verdict(str, Enum):
    MVP = "MVP"
    OBSERVE = "OBSERVE"
    FIRED = "FIRED"


class Aesthetic(str, Enum):
    MINIMAL = "minimal"
    RICH = "rich"
    NEUTRAL = "neutral"


class RadarScore(BaseModel):
    task: float = 0.0
    quality: float = 0.0
    comm: float = 0.0
    creativity: float = 0.0
    reliability: float = 0.0
    cost: float = 0.0


class WeightVector(BaseModel):
    task: float = 0.2
    quality: float = 0.2
    comm: float = 0.15
    creativity: float = 0.15
    reliability: float = 0.15
    cost: float = 0.15


class UserPreference(BaseModel):
    aesthetic: Aesthetic = Aesthetic.NEUTRAL
    budget_max: float = 200.0
    preferred_stack: List[str] = Field(default_factory=lambda: ["React"])
    weight: WeightVector = Field(default_factory=WeightVector)


class PersonaText(BaseModel):
    type: str = "text/markdown"
    content: str = ""


class MediaRef(BaseModel):
    type: str = ""
    url: str = ""


class CodeRef(BaseModel):
    type: str = "application/zip"
    url: str = ""
    lang: str = ""


class Evaluation(BaseModel):
    radar: RadarScore = Field(default_factory=RadarScore)
    user_fit: float = 0.0
    verdict: Verdict = Verdict.OBSERVE
    evidence_trace: List[str] = Field(default_factory=list)
    confidence: float = 0.0


class CandidateProfile(BaseModel):
    id: str
    name: str = ""
    declared_tags: List[str] = Field(default_factory=list)
    declared_budget: float = 0.0
    persona_text: PersonaText = Field(default_factory=PersonaText)
    video_demo: MediaRef = Field(default_factory=MediaRef)
    voice_intro: MediaRef = Field(default_factory=MediaRef)
    artwork: List[MediaRef] = Field(default_factory=list)
    code_repo: CodeRef = Field(default_factory=CodeRef)
    evaluation: Evaluation = Field(default_factory=Evaluation)


class EvaluationRequest(BaseModel):
    candidate: CandidateProfile
    preference: UserPreference
    options: Optional[dict] = None


# ===================== 运行期裁判请求（api/evaluate-run） =====================
class JudgeTask(BaseModel):
    """评估关联的任务（轻量结构，对齐前端 JudgeRunInput.task）"""
    title: str = ""
    description: str = ""
    weight: float = 1.0


class JudgeRunRequest(BaseModel):
    """
    运行期裁判请求。
    由前端 judgeClient 经 Host API 代理 POST 至模型服务。
    携带真实 transcript + usage（TokenUsageHistoryEntry[]）+ task，
    后端据此产出与 /api/evaluate 同构的 SSE 事件流
    （radar_update ×6 + verdict + done）。

    契约兼容：前端经 Host API 代理发送的 JSON 为 camelCase（agentId /
    agentName），而后端旧有测试与内部调用使用 snake_case（agent_id /
    agent_name）。此处通过 pydantic 的 AliasGenerator + populate_by_name 同时
    接受两种写法，避免前端真实请求缺少 agent_id 触发 422 而静默回退 mock。
    """
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    agent_name: str = ""
    persona: Optional[str] = None
    task: JudgeTask = Field(default_factory=JudgeTask)
    transcript: str = ""
    usage: List[dict] = Field(default_factory=list)
    preference: Optional[dict] = None
    # Layer3 收敛扩展：命中则 /api/evaluate-run 记录收敛轨迹
    # 并发 convergence_update / convergence_score SSE 事件（不破坏既有字段）。
    convergence: Optional[dict] = None
    # 任务集扩展（可选）：指定任务集调度；缺省 usage_efficiency。
    task_set_id: Optional[str] = None


# ===================== SSE 事件（五种） =====================
# 运行时每个事件序列化为 dict 后发送：data: <json>\n\n


class RadarUpdateEvent(BaseModel):
    type: Literal["radar_update"] = "radar_update"
    dim: RadarDim
    score: float
    confidence: float
    evidence: str = ""


class NarrationEvent(BaseModel):
    type: Literal["narration"] = "narration"
    delta: str = ""
    is_final: bool = False


class AudioEvent(BaseModel):
    type: Literal["audio"] = "audio"
    chunk: str = ""  # base64：真实为 PCM16/wav 字节；Mock 为 UTF-8 文本
    format: Literal["pcm16", "wav"] = "wav"
    sample_rate: int = 16000


class VerdictEvent(BaseModel):
    type: Literal["verdict"] = "verdict"
    verdict: Verdict
    user_fit: float
    evidence_trace: List[str] = Field(default_factory=list)
    confidence: float = 0.0


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    evaluation_id: str = ""


def to_event_dict(event: BaseModel) -> dict:
    """将事件模型转为可 JSON 序列化的 dict（枚举转字符串）"""
    return event.model_dump(mode="json")


# ===================== 评估层扩展 =====================
# 仅追加模型，不修改/删除既有模型（如 JudgeRunRequest 已含 convergence 字段）。

class ObjectiveScoreItem(BaseModel):
    """单次客观维得分（含来源 + 扁平权重，供 Q7 craft 独立存库/工种雷达）。"""
    dim: str
    score: float = 0.0
    source: str = "judge"  # judge / telemetry / mixed
    weight: float = 0.0
    evidence: Optional[str] = None


class SubjectiveScore(BaseModel):
    """单次主观赋分（由使用者给出）。"""
    agentId: str = ""
    stage: str = ""
    scores: Dict[str, float] = Field(default_factory=dict)  # sub_* 维 -> 0–5
    notes: Optional[str] = None
    scoredBy: str = "owner"
    ts: str = ""


class CraftScores(BaseModel):
    """craft 维独立存库（Q7），不并入 objective 总分，供工种 craft 雷达对比。"""
    jobType: str = "code"
    dims: Dict[str, float] = Field(default_factory=dict)  # craft dim -> 0–5
    downweighted: List[str] = Field(default_factory=list)  # Q6 降权维
    evidence: Dict[str, str] = Field(default_factory=dict)  # dim -> 证据/标注


class StageScore(BaseModel):
    """三阶段评分卡（S1/S2/S3 同构）。"""
    agentId: str = "unknown"
    stage: str = ""
    jobType: str = "code"
    objective: List[ObjectiveScoreItem] = Field(default_factory=list)
    subjective: SubjectiveScore = Field(default_factory=SubjectiveScore)
    objectiveWeight: float = 0.5
    subjectiveWeight: float = 0.5
    objectiveScore: float = 0.0
    subjectiveScore: float = 0.0
    total: float = 0.0
    verdict: str = "OBSERVE"
    craftScores: CraftScores = Field(default_factory=CraftScores)
    window: Optional[str] = None
    ts: str = ""


class StageScoreRequest(BaseModel):
    """POST /api/evaluate-stage 入参。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agentId: str = "unknown"
    stage: str
    jobType: str = "code"
    objective: Dict[str, float] = Field(default_factory=dict)  # dim -> 0–5
    subjective: Dict[str, float] = Field(default_factory=dict)  # sub_* -> 0–5
    craftEvidence: Dict[str, str] = Field(default_factory=dict)  # craft dim -> 证据文本（含裁判引文）
    # requiresReal 维（code_runnability / code_security）的**机器可核验**证据：
    # 真实执行结果（测试通过率 / 构建日志）或真实扫描结果。
    # 关键：裁判模型自己的引文不算数——若允许模型引文抵消降权，
    # 「缺真实执行则降权」这道闸门就等于自己把自己关掉了。
    verifiedEvidence: Dict[str, str] = Field(default_factory=dict)
    presetId: str = "default"
    scoredBy: str = "owner"
    window: Optional[str] = None


class LeaderboardEntry(BaseModel):
    """双 Leaderboard · 客观榜条目（按 objectiveScore 排序）。"""
    agentId: str
    name: str = ""
    jobType: str = "code"
    objectiveScore: float = 0.0
    roiNorm: float = 0.0
    rank: int = 0  # 客观名次（1=榜首）
    state: str = "ACTIVE"
    tier: str = "NORMAL"  # MVP / NORMAL / BOTTOM


class SubjectiveRankEntry(BaseModel):
    """双 Leaderboard · 主观榜条目（可拖拽）。"""
    agentId: str
    name: str = ""
    jobType: str = "code"
    subjectiveScore: float = 0.0
    objectiveRank: int = 0  # 客观预排名次（默认序来源）
    dragRank: int = 0  # 用户拖拽后的名次（持久化）


class RankDivergence(BaseModel):
    """客观序 vs 拖拽序发散。"""
    agentId: str
    objectiveRank: int
    dragRank: int
    delta: int  # dragRank - objectiveRank（负=被提升）


class DualLeaderboard(BaseModel):
    """双 Leaderboard（客观榜 + 可拖拽主观榜 + 复核发散）。"""
    stage: str
    jobType: str = "all"
    objective: List[LeaderboardEntry] = Field(default_factory=list)
    subjective: List[SubjectiveRankEntry] = Field(default_factory=list)
    divergences: List[RankDivergence] = Field(default_factory=list)
    updatedAt: str = ""


class PreferenceSignal(BaseModel):
    """一次拖拽 = 一个偏好信号（Q5 回灌）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    id: str = ""
    ownerId: str = "default"
    stage: str = ""
    jobType: str = "code"
    agentId: str
    srcRank: int = 0
    dstRank: int = 0
    direction: str = "up"  # up / down
    craftScores: Optional[Dict[str, float]] = None  # 可选：被提升 agent 的 craft 维得分
    ts: str = ""


class PreferenceProfile(BaseModel):
    """聚合后回灌 UserPreference.weight 的偏好画像。"""
    ownerId: str = "default"
    signals: List[PreferenceSignal] = Field(default_factory=list)
    pairwiseWins: Dict[str, int] = Field(default_factory=dict)
    dimLift: Dict[str, float] = Field(default_factory=dict)
    updatedAt: str = ""


class PreferenceFeedbackRequest(BaseModel):
    """POST /api/preference 入参（前端携带累计信号列表 + 当前权重）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    ownerId: str = "default"
    signals: List[PreferenceSignal] = Field(default_factory=list)
    currentWeight: Optional[Dict[str, float]] = None


class ScoringRulesLoad(BaseModel):
    """PUT /api/rules 入参。"""
    presetId: str
    rules: dict


class TaskRunResult(BaseModel):
    """任务集运行结果。"""
    agentId: str
    taskSetId: str
    jobType: str = "code"
    objectiveScores: Dict[str, float] = Field(default_factory=dict)
    telemetry: List[dict] = Field(default_factory=list)
    usage: List[dict] = Field(default_factory=list)
    craftEvidence: Dict[str, str] = Field(default_factory=dict)
    meta: Dict[str, float] = Field(default_factory=dict)
    # 难度校准时间戳（ISO 8601）：题面难度经基准解校准的时间；None = 未校准，
    # 消费方应把「未校准」与「校准过」严格区分，不得把 None 当校准过展示。
    difficultyCalibratedAt: Optional[str] = None


class TaskSetMeta(BaseModel):
    """TaskSet 元数据（前端注册表镜像用）。"""
    id: str
    title: str = ""
    description: str = ""
    applicableJobs: List[str] = Field(default_factory=list)
    # 难度校准时间戳（与 TaskRunResult.difficultyCalibratedAt 同源）
    difficultyCalibratedAt: Optional[str] = None


# ===================== Arena 个性化对决 =====================
# 契约见 docs/api/contracts.md；camelCase 兼容经 AliasGenerator 处理。


class ArenaCandidateRef(BaseModel):
    """候选引用：text 通道直接给 answer；gateway 通道给 endpoint/model/apiKey。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    agent_name: str = ""
    channel: str = "text"  # text / gateway
    answer: Optional[str] = None
    endpoint: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None


class ArenaCompareRequest(BaseModel):
    """POST /api/arena/compare 入参（需求 → 题面 → 逐 agent 跑题 → 客观评判）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    requirement_text: str
    job_type: str = "code"
    candidates: List[ArenaCandidateRef] = Field(default_factory=list)
    context: Literal["arena", "interview"] = "arena"
    interview_id: Optional[str] = None


class ArenaCandidateAnswer(BaseModel):
    """单个候选的对决作答（含 arena_judge 客观评判）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    agent_name: str = ""
    answer_text: str = ""
    channel: str = ""
    latency_ms: float = 0.0
    judgement: Optional[dict] = None  # arena_judge 输出（dims/checkpoints/padding/confidence/fit）
    objective_total: float = 0.0  # 客观分汇总（dims 均值 + fit 加权）


class ArenaMatch(BaseModel):
    """一场对决（pending → picked/abandoned），模型服务进程内缓存 + 前端落库。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    match_id: str
    context: Literal["arena", "interview"] = "arena"
    interview_id: Optional[str] = None
    requirement_text: str = ""
    task_prompt: str = ""
    job_type: str = "code"
    candidates: List[ArenaCandidateAnswer] = Field(default_factory=list)
    objective_leader: Optional[str] = None
    #: pairwise 鲁棒相对比较结果（仅双候选时产出）：winner/consistent/position_bias 等。
    #: 由 judge_pairwise_robust 产出，用位置 swap 消位置偏差，比单一客观分更鲁棒。
    pairwise: Optional[dict] = None
    user_pick: Optional[str] = None  # agent_id | "draw" | "none"
    status: Literal["pending", "picked", "abandoned"] = "pending"
    elo_delta: Dict[str, float] = Field(default_factory=dict)
    created_at: str = ""
    picked_at: Optional[str] = None


class ArenaUserPickRequest(BaseModel):
    """POST /api/arena/user-pick 入参（用户主观选择 → 双轨 Elo 更新）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    match_id: str
    pick: str  # agent_id | "draw" | "none"


class ArenaPickResult(BaseModel):
    """user-pick 回包：双轨 Elo 快照。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    match_id: str
    status: Literal["picked", "abandoned"] = "picked"
    user_pick: str = ""
    winner: Optional[str] = None  # agent_id | "draw" | null
    elo_delta: Dict[str, float] = Field(default_factory=dict)
    subjective_ratings: Dict[str, float] = Field(default_factory=dict)
    objective_ratings: Dict[str, float] = Field(default_factory=dict)


# ===================== 小红心点赞 =====================
# 契约见 docs/api/contracts.md；users/ownerId 为后端聚合预留字段。


class LikeRecord(BaseModel):
    """点赞记录（本地 count + 个人态；users 为后端聚合预留）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    count: int = 0
    liked_by_me: bool = False
    users: List[str] = Field(default_factory=list)  # [预留] 后端聚合 user_ids
    updated_at: str = ""


class FavoriteVoteRequest(BaseModel):
    """POST /api/favorites/vote 入参（BossFavorite 深度认可投票）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    job_type: str = "code"
    stage: Literal["interview", "performance", "arena"] = "arena"
    source_id: Optional[str] = None  # interviewId/matchId，幂等键
    voted_by: str = "default"  # [预留] 本地默认 'default'


class FavoriteVoteResult(BaseModel):
    """投票回包。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    job_type: str
    count: int = 0
    voted: bool = True


class FavoriteRankingEntry(BaseModel):
    """工种维度单条青睐榜条目。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    agent_id: str
    agent_name: str = ""
    count: int = 0
    voters: List[str] = Field(default_factory=list)  # [预留] 后端聚合 user_ids


class FavoriteRanking(BaseModel):
    """GET /api/favorites 回包（按 count 降序）。"""
    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=AliasGenerator(
            validation_alias=to_camel,
            serialization_alias=to_camel,
        ),
    )
    job_type: str
    ranking: List[FavoriteRankingEntry] = Field(default_factory=list)
