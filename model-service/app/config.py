"""
model-service/app/config.py
服务配置（环境变量驱动。
"""
from __future__ import annotations

import os


def _parse_csv_list(raw: str, default: list) -> list:
    """把逗号分隔字符串解析为去空白后的列表。

    空字符串 / 全空白 / 全是空项（脏输入如 ",, ,"）一律回退到 default，
    避免把「没配」和「配了空」混淆成空列表导致安全白名单被清空。
    """
    items = [m.strip() for m in raw.split(",") if m.strip()]
    return items if items else list(default)


def _parse_task_timeouts(raw: str) -> dict:
    """把 "task_id:seconds,task_id:seconds" 解析为 {task_id: int}。

    单条缺冒号、key 为空、value 非整数 —— 一律跳过该条而非抛异常，
    保证脏输入只丢坏条目、不崩掉整个 Settings 构造。
    """
    out: dict = {}
    for item in raw.split(","):
        item = item.strip()
        if not item or ":" not in item:
            continue
        k, _, v = item.partition(":")
        k, v = k.strip(), v.strip()
        if not k:
            continue
        try:
            out[k] = int(v)
        except ValueError:
            # 脏数值（非整数）跳过该条，不崩溃
            continue
    return out


class Settings:
    """运行配置，从环境变量读取（支持 .env / docker env）。"""

    def __init__(self) -> None:
        self.model_path: str = os.getenv("MODEL_PATH", "/models/MiniCPM-o-4.5")
        # auto：按 NPU > CUDA > CPU 自动探测（见 model_loader.resolve_device）。
        # 不默认 npu —— 绝大多数机器上那是个必然失败的默认值，会让首次运行者
        # 误以为是代码问题；显式声明 DEVICE=npu 才走异构加速卡路径。
        self.device: str = os.getenv("DEVICE", "auto")
        # 默认只监听本机回环：本服务无鉴权（judge/upload 直接可用），绑 0.0.0.0
        # 会让同网段任何人白嫖配额甚至触达代码执行路径。确需对外时显式 API_HOST=0.0.0.0。
        self.host: str = os.getenv("API_HOST", "127.0.0.1")
        self.port: int = int(os.getenv("API_PORT", "8000"))
        self.samples_dir: str = os.getenv("SAMPLES_DIR", "/app/samples")
        self.upload_dir: str = os.getenv("UPLOAD_DIR", "/app/uploads")
        # Web 静态托管根目录（昇腾统一环境 Web 形态）：指向构建产物 dist-web 时，
        # 服务端在 / 上托管前端（含 SPA 路由回退）；缺省为空表示不托管。
        self.web_root: str = os.getenv("WEB_ROOT", "")
        # Mock 模式：无 NPU 时由内置 fixture 生成事件流（与前端一致）
        self.mock: bool = os.getenv("MOCK", "false").lower() in ("1", "true", "yes")
        # 复现控制（架构 D7）
        self.temperature: float = float(os.getenv("TEMPERATURE", "0.0"))
        self.seed: int = int(os.getenv("SEED", "42"))
        self.frame_sample: int = int(os.getenv("FRAME_SAMPLE", "8"))

        # ===== LLM-as-judge 推理后端（judge_backend.py）=====
        # http  —— OpenAI 兼容服务（vLLM-Omni / OpenBMB API），无 NPU 也能真实评测
        # local —— 本机 transformers 推理，device 见上方 self.device（cuda/cpu/npu）
        # mock  —— 不提供推理，调用方降级（绝不伪造分数）
        self.judge_backend: str = os.getenv("JUDGE_BACKEND", "mock").lower()
        self.judge_base_url: str = os.getenv("JUDGE_BASE_URL", "")
        self.judge_api_key: str = os.getenv("JUDGE_API_KEY", "")
        self.judge_model: str = os.getenv("JUDGE_MODEL", "MiniCPM-o-4.5")
        self.judge_max_tokens: int = int(os.getenv("JUDGE_MAX_TOKENS", "1536"))
        self.judge_timeout: float = float(os.getenv("JUDGE_TIMEOUT", "120"))

        # ===== ensemble 采样（重复测量要真的有扰动才有意义）=====
        # 单点评分 temperature=0 保证可复现；但 ensemble 的 k 次重复若也用 0，
        # k 次输出逐字相同，pass^k 就退化成 pass^1 的复读，离散度警报永远不会响。
        # 因此 ensemble 路径单独使用一个 >0 的温度做真实重复采样。
        self.judge_ensemble_temperature: float = float(
            os.getenv("JUDGE_ENSEMBLE_TEMPERATURE", "0.5")
        )
        # 跨家族裁判池（逗号分隔）。配置 ≥2 个不同家族的模型后，
        # ensemble 的第 i 次采样会轮转到第 i 个模型 —— 这是对「自我增强偏差」
        # 唯一有效的结构性缓解：让裁判不总是与被评方同源。
        # 缺省回退单一 judge_model（行为与此前一致）。
        self.judge_models: list = [
            m.strip() for m in os.getenv("JUDGE_MODELS", "").split(",") if m.strip()
        ]

        # ===== 代码沙盒（sandbox/runner.py）=====
        # 真实执行候选给出的代码与测试，为 code_runnability 产出机器可核验证据。
        # 默认关闭：它会在本机执行来自候选 agent 的代码，必须由部署者显式授权。
        self.sandbox_enabled: bool = os.getenv("SANDBOX_ENABLED", "false").lower() in (
            "1",
            "true",
            "yes",
        )
        self.sandbox_timeout: float = float(os.getenv("SANDBOX_TIMEOUT", "10"))
        self.sandbox_mem_mb: int = int(os.getenv("SANDBOX_MEM_MB", "512"))

        # ===== 超级全面沙箱加固项（runner.py 经 getattr(settings, name, default) 消费）=====
        # 下列名字是与 runner.py 的契约字段，改名会断消费方；调整默认值需同步 runner。

        # sandbox_network_isolation: bool
        # 用途：是否在子进程阻断网络。开启后由 sitecustomize 桩把 socket 替换为
        #       始终抛错的假实现，阻止候选代码外连（防数据外泄 / C2 回连）。
        # 默认：True。关闭会把沙箱暴露到宿主机网络，仅调试时考虑。
        # 安全含义：默认「零网络」是防泄密与防横向移动的第一道闸。
        self.sandbox_network_isolation: bool = os.getenv(
            "SANDBOX_NETWORK_ISOLATION", "true"
        ).lower() in ("1", "true", "yes")

        # sandbox_max_output_bytes: int
        # 用途：单次执行捕获 stdout/stderr 的字节上限。超限即截断，防候选代码用
        #       死循环 print / 超大字符串把内存和日志管道撑爆（防 print 洪水 DoS）。
        # 默认：2_000_000（约 2MB），足以容纳正常输出又能挡住洪水。
        # 安全含义：资源配额，抑制「输出型」拒绝服务。
        self.sandbox_max_output_bytes: int = int(
            os.getenv("SANDBOX_MAX_OUTPUT_BYTES", "2000000")
        )

        # sandbox_blocked_imports: list[str]
        # 用途：运行时阻断的危险模块列表。即便绕过 AST 静态扫描，import 这些
        #       模块时也会被桩拦截（第二道防线：socket/subprocess 防越狱执行，
        #       ctypes/cffi 防绕过 Python 层直调原生 API，multiprocessing 防 fork
        #       逃逸出资源配额，pickle 防反序列化 RCE）。
        # 默认：socket,subprocess,ctypes,cffi,multiprocessing,pickle（逗号分隔）。
        # 安全含义：缩小可攻击面 —— 与 AST 扫描互补的动态阻断名单。
        self.sandbox_blocked_imports: list = _parse_csv_list(
            os.getenv("SANDBOX_BLOCKED_IMPORTS", ""),
            ["socket", "subprocess", "ctypes", "cffi", "multiprocessing", "pickle"],
        )

        # sandbox_peak_mem: bool
        # 用途：是否采集执行期间的峰值内存（用于资源画像与超限判定）。
        # 默认：True。关闭可省一次采样开销，但失去峰值观测能力。
        # 安全含义：观测性开关；关掉不削弱隔离，只少一个监控信号。
        self.sandbox_peak_mem: bool = os.getenv("SANDBOX_PEAK_MEM", "true").lower() in (
            "1",
            "true",
            "yes",
        )

        # sandbox_per_task_timeout: dict[str, int]
        # 用途：单题超时覆盖表，key 为 task_id，value 为秒数。命中某题时用它
        #       替换全局 sandbox_timeout，允许慢题放宽、快题收紧。
        # 格式："task_id:seconds,task_id:seconds"（逗号分隔，单条冒号分隔）。
        # 默认：{} —— 留空则全部走 sandbox_timeout。脏条目（缺冒号/非整数）
        #       跳过而非崩溃。
        # 安全含义：在「总超时」不变的前提下做细粒度配额，避免一题拖垮整批。
        self.sandbox_per_task_timeout: dict = _parse_task_timeouts(
            os.getenv("SANDBOX_TASK_TIMEOUTS", "")
        )

        # sandbox_windows_job_mem_mb: int
        # 用途：Windows Job Object 的内存硬上限（MB）。Windows 无 ulimit，
        #       需靠 Job Object 强制封顶；该值应 ≤ 进程总配额，给解释器留余量。
        # 默认：与 sandbox_mem_mb 一致（512），保证两条路径配额对齐。
        # 安全含义：把「软观测」升级为「硬封顶」，防止单任务吃光宿主机内存。
        self.sandbox_windows_job_mem_mb: int = int(
            os.getenv("SANDBOX_WIN_JOB_MEM_MB", str(self.sandbox_mem_mb))
        )

        # ===== 候选跑题通道（candidate_runner.py，A2/A3）=====
        # text    —— 直接使用调用方提供的答案文本（A3 演示/人工模式）
        # gateway —— 经 OpenClaw gateway 的 OpenAI 兼容 chat 调度（A2 真实跑题）
        self.candidate_channel: str = os.getenv("CANDIDATE_CHANNEL", "text").lower()
        self.gateway_base_url: str = os.getenv("GATEWAY_BASE_URL", "")
        self.gateway_model: str = os.getenv("GATEWAY_MODEL", "MiniCPM-o-4.5")
        self.gateway_api_key: str = os.getenv("GATEWAY_API_KEY", "")
        self.candidate_timeout: float = float(os.getenv("CANDIDATE_TIMEOUT", "120"))


# 全局单例
settings = Settings()
