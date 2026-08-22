"""
model-service/app/sandbox/runner.py
受限子进程执行器：把候选答案里的 Python 代码与测试真的跑一遍。

设计原则（每一条都对应一个「否则会骗自己」的失败模式）：

1. **只认退出码与断言，不认自然语言。** 产出的 verified_evidence 里写的是
   「4/4 用例通过」这类可核对的事实，而不是模型的复述。
2. **候选没写测试 = 无法验证，而不是验证不通过。** 两者结论完全不同：
   前者 outcome=no_tests（不解除降权、也不扣分），后者 outcome=failed（真实失败证据）。
   把「没考到」当成「考了但不好」是评测系统最常见的自欺。
3. **零新增依赖，不依赖 pytest。** 用自带 harness 收集 `test_*` 函数并逐个执行，
   因此在只装了 requirements.txt 的评测机上也能跑。
4. **失败必须可复现。** 退出码、stdout/stderr 截断片段、逐个用例结论全部回传。

学术依据与现状对照：
- SWE-bench（arXiv:2310.06770）：以**固定测试夹具（fixed fixtures）**做 pass/fail
  判定——验证的是「仓库既有测试能否通过」，而非候选自写测试。这正是 craft_tasks_sandbox.py
  预留的 code_csv_merge 夹具方向：应让 runner 消费 curated 固定夹具，而非仅跑候选
  自带的 test_*（后者 `assert True` 即可骗过，使机器验证失去意义）。
- Agent-Diff（arXiv:2602.11224）：用「状态差异合约（state-diff）」做确定性验证——
  对执行前后环境状态做 diff 与期望变更比对，产出 crisp pass/fail，替代对轨迹的模糊匹配。
  可作为沙箱从「跑候选测试」升级到「验证客观状态变更」的方向。
- RedCode / CIBER（arXiv:2411.07781）：危险代码执行的安全评测——与 security_scan 的
  静态扫描互补，构成「能不能跑」+ 「危不危险」两条独立证据链。
- 当前缺口：`verifiable`（跑过用例）≠ 可抬权——只有 outcome=="passed" 才解除 Q6
  降权（见 verified_evidence_for），失败为负面证据不抬权。
- 夹具覆盖面（现状，2026-08 实测）：4 道 code 题里仅 `code_csv_merge` 适合固定夹具，
  因其是纯「输入→输出」的数据变换，可确定性断言。其余三道（code_debug_race
  竞态根因、code_api_hardening 加固清单、code_boss_system 崩溃恢复队列）都是
  设计/推理题，本应由 LLM 裁判按 rubric 打分——把它们硬塞进 pass/fail 夹具是用错工具。
  结论：机器可验覆盖面由「题型是否确定性」决定，不由工程接线决定；扩大覆盖面要靠
  「新增确定性题型」而非「给推理题加夹具」。

安全边界（「超级全面沙箱」加固，每一项都经本机实测确认能生效，而非「应该能行」）：
  - 子进程 + `-I`（isolated：忽略用户 site-packages 与 PYTHON* 环境变量）；
  - cwd 为一次性临时目录，执行后整目录删除；
  - 墙钟超时强杀（kill 整个进程组 / Windows 上 TerminateJobObject 整棵进程树）；
  - **网络隔离**：在 harness 顶部内联一段 prologue，把 `socket.socket` 替换为原
    `socket` 类的子类桩（保留类型身份，否则 `class SSLSocket(socket)` 崩溃），任何
    造 socket / connect 企图一律抛 `OSError("sandbox: network disabled")`。
    ⚠️ 注入方式经实测选定：**sitecustomize 在 `-I` 下不加载**（3.11+ 的 `-I` 隐含
    `-P`，cwd 与脚本目录都不在 sys.path），故改为 harness 顶部内联——这是唯一在
    `-I` 下确定执行的注入点。开关 `sandbox_network_isolation`（默认开）。
  - **导入黑名单**：prologue 改写 `builtins.__import__`，阻断 `sandbox_blocked_imports`
    里的模块（subprocess/ctypes/cffi/multiprocessing/pickle 等），与 AST 静态扫描互补。
  - **资源限额**：POSIX 用 `resource.setrlimit`（CPU/AS/FSIZE/NPROC）——**可靠的
    内存硬上限**；Windows 用 Job Object（PROCESS_MEMORY + 活跃进程数 + KILL_ON_JOB_CLOSE）
    ——**尽力而为**（实测本内存受限机器上 Python 分配器先于 Job 限额抛 MemoryError，
    Job 内存 enforcement 未触发；富内存机器上应能封顶）。enforcement 失败一律降级为
    仅墙钟超时保护，绝不抛。
  - **OOM 独立 outcome**：内存超限不再混入 failed/timeout，单列为 `oom`
    （reason="memory limit exceeded"），与超时可区分。
  - **峰值内存采集**：`peak_mem_mb`（POSIX 自报 ru_maxrss / Windows Job 峰值），采不到 None。
  - **输出上限**：单流读取封顶 `sandbox_max_output_bytes`，防 print 洪水撑爆内存，
    超限记 `output_capped`。
  - 环境变量白名单化（不透传 API key 等凭据）。
  **不提供文件系统隔离**：真正的多租户隔离需要容器/命名空间。
  因此默认只在本地评测场景启用，且 SANDBOX_ENABLED 默认关闭，需显式打开。
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..config import settings
from .craft_tasks_sandbox import get_sandbox_spec

logger = logging.getLogger("sandbox")

#: 执行结论。七态——「内存超限(oom)」与「超时(timeout)」「失败(failed)」必须区分：
#: oom 是资源配额命中，timeout 是墙钟到期，failed 是断言/导入错误，三者根因不同。
SandboxOutcome = str  # 'passed' | 'failed' | 'no_tests' | 'no_code' | 'error' | 'disabled' | 'oom'

#: 从 markdown 代码块里抽 Python 源码
_PY_BLOCK_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)

#: harness：收集模块内的 test_* 函数逐个执行，输出机器可解析的结果行。
#: 单独成文件而不是 -c 内联，避免引号转义问题与超长命令行。
#: 注意：导入期异常会打印异常类型名（HARNESS_IMPORT_ERROR <Type>），供 OOM 识别
#: （MemoryError 出现在真实 stdout，才能被父进程的 _is_oom 判定）。
_HARNESS = '''
import importlib.util
import io
import sys
import traceback
import contextlib

SPEC = importlib.util.spec_from_file_location("candidate_answer", "answer.py")
MODULE = importlib.util.module_from_spec(SPEC)
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        SPEC.loader.exec_module(MODULE)
except BaseException as exc:
    print("HARNESS_IMPORT_ERROR " + type(exc).__name__)
    sys.exit(3)

names = sorted(n for n in dir(MODULE) if n.startswith("test_") and callable(getattr(MODULE, n)))
if not names:
    print("HARNESS_NO_TESTS")
    sys.exit(4)

failed = 0
for name in names:
    fn = getattr(MODULE, name)
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            fn()
        print("CASE_PASS " + name)
    except BaseException as exc:
        failed += 1
        detail = "{}: {}".format(type(exc).__name__, exc)
        print("CASE_FAIL " + name + " :: " + detail.replace(chr(10), " ")[:200])

print("HARNESS_DONE total={} failed={}".format(len(names), failed))
sys.exit(0 if failed == 0 else 1)
'''


# ======================================================================
# 网络隔离 + 导入黑名单 prologue（内联到 harness 顶部）
# ======================================================================
# 为什么内联而非 sitecustomize：实测 `python -I`（isolated）下，3.11+ 隐含 `-P`
# （不把 cwd/脚本目录加入 sys.path），cwd 的 sitecustomize 根本不加载——基线
# （不带 -I）在本机也不加载。把隔离代码放 sitecustomize 等于没放。内联到 harness
# 顶部是唯一在 -I 下确定执行的注入点（harness 作为脚本运行，内联代码必执行）。
#
# 占位符 __AC_NET__ / __AC_BLOCKED__ / __AC_PEAK__ 由 _compose_harness 渲染为
# Python 字面量（值来自可信的 settings，非候选代码，repr 注入安全）。
_ISOLATION_PROLOGUE = '''\
# --- AgentCorp 沙箱隔离 prologue（runner.py 注入，非候选代码）---
import builtins as _ac_builtins
import os as _ac_os

def _ac_nonet(*_a, **_k):
    raise OSError("sandbox: network disabled")

# (1) 网络隔离：把 socket.socket 换成「原 socket 类的子类」桩。
#     必须是子类而非普通函数——实测证实：换成普通函数会让 `class SSLSocket(socket)`
#     （ssl.py）因基类不是类型而崩，连 `import urllib` 都失败。子类保留类型身份，
#     isinstance / 继承检查照常，但任何 connect/send 都抛 OSError → 联网确定性失败。
if __AC_NET__:
    try:
        import socket as _ac_socket
        _ac_OrigSocket = _ac_socket.socket
        class _ac_NoNet(_ac_OrigSocket):
            def connect(self, *_a, **_k): raise OSError("sandbox: network disabled")
            def connect_ex(self, *_a, **_k): raise OSError("sandbox: network disabled")
            def send(self, *_a, **_k): raise OSError("sandbox: network disabled")
            def sendall(self, *_a, **_k): raise OSError("sandbox: network disabled")
            def sendto(self, *_a, **_k): raise OSError("sandbox: network disabled")
            def recv(self, *_a, **_k): raise OSError("sandbox: network disabled")
            def recvfrom(self, *_a, **_k): raise OSError("sandbox: network disabled")
        _ac_socket.socket = _ac_NoNet
        _ac_socket.SocketType = _ac_NoNet
        for _ac_n in ("create_connection", "getaddrinfo", "gethostbyname",
                      "gethostbyname_ex", "getfqdn"):
            if hasattr(_ac_socket, _ac_n):
                setattr(_ac_socket, _ac_n, _ac_nonet)
    except ImportError:
        pass

# (2) 导入黑名单：改写 builtins.__import__，阻断危险模块在 import 阶段就失败。
#     与 AST 静态扫描互补——扫不到运行期 import，这里补上动态防线。
_ac_blocked = frozenset(__AC_BLOCKED__)
_ac_real_import = _ac_builtins.__import__
def _ac_guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name.split(".")[0] in _ac_blocked:
        raise ImportError("sandbox: import of %r is blocked" % name.split(".")[0])
    return _ac_real_import(name, globals, locals, fromlist, level)
_ac_builtins.__import__ = _ac_guarded_import

# (3) 峰值内存自报（POSIX）：解释器退出时把 RUSAGE_SELF.ru_maxrss 写入文件，
#     父进程读回得到本-run 精确峰值。为何不用 getrusage(RUSAGE_CHILDREN)：它是
#     跨次累积高水位，长驻服务里单调增长，不能直接当单次峰值。
if __AC_PEAK__ and _ac_os.name == "posix":
    import atexit as _ac_atexit
    import json as _ac_json
    def _ac_report_peak():
        try:
            import resource as _ac_resource
            _kb = _ac_resource.getrusage(_ac_resource.RUSAGE_SELF).ru_maxrss
            with open("_ac_peak.json", "w", encoding="utf-8") as _ac_f:
                _ac_json.dump({"peak_kb": int(_kb)}, _ac_f)
        except Exception:
            pass
    _ac_atexit.register(_ac_report_peak)
'''


def _compose_harness(base_source: str) -> str:
    """把隔离 prologue 渲染并前置到 harness 源码顶部。

    配置值来自可信的 settings（非候选代码），用 repr 注入为 Python 字面量安全。
    blocked_imports 只收合法标识符名，防止脏配置注入任意代码。
    """
    net = bool(getattr(settings, "sandbox_network_isolation", True))
    raw_blocked = list(
        getattr(
            settings,
            "sandbox_blocked_imports",
            ["socket", "subprocess", "ctypes", "cffi", "multiprocessing", "pickle"],
        )
    )
    # 只保留合法顶层模块名：脏配置（数字、带点、空串）一律丢弃，绝不注入。
    blocked = [b for b in raw_blocked if isinstance(b, str) and b.isidentifier()]
    peak = bool(getattr(settings, "sandbox_peak_mem", True))
    prologue = (
        _ISOLATION_PROLOGUE.replace("__AC_NET__", "True" if net else "False")
        .replace("__AC_BLOCKED__", repr(frozenset(blocked)))
        .replace("__AC_PEAK__", "True" if peak else "False")
    )
    return prologue + base_source


@dataclass
class SandboxResult:
    """一次真实执行的结果（全部字段都可被人工复核）。"""

    outcome: SandboxOutcome
    total: int = 0
    passed: int = 0
    failed: int = 0
    duration_ms: float = 0.0
    #: 逐个用例结论：[(用例名, 是否通过, 失败摘要)]
    cases: List[tuple] = field(default_factory=list)
    #: 子进程输出截断片段（便于人工排查，不参与打分）
    output_tail: str = ""
    #: outcome 为 error/disabled/oom 时的原因
    reason: str = ""
    #: 实际执行的源码字节数（0 表示没抽到代码）
    code_bytes: int = 0
    #: 执行期间峰值内存（MB）；采集不到为 None（进程被强杀时 atexit 不触发）。
    peak_mem_mb: Optional[float] = None
    #: 输出是否触及单流字节上限被截断（防 print 洪水 DoS）。
    output_capped: bool = False

    @property
    def verifiable(self) -> bool:
        """本次执行是否产生了可采信的证据（真跑过用例，或被资源限额明确终止）。

        oom 计入：被内存限额终止同样是确定的执行结论（负面证据），只是不抬权。
        """
        return self.outcome in ("passed", "failed", "oom") and self.total > 0

    def evidence_text(self) -> str:
        """机器可核验证据文本（写进 StageScore.verifiedEvidence）。

        只有 passed 产出可抬权证据；failed/oom 产出展示性负面证据，绝不进抬权键。
        """
        if self.outcome == "passed":
            return f"沙盒执行：{self.passed}/{self.total} 用例通过（{self.duration_ms:.0f}ms）"
        if self.outcome == "failed":
            first = next((c for c in self.cases if not c[1]), None)
            tail = f"；首个失败 {first[0]}：{first[2]}" if first else ""
            return (
                f"沙盒执行：{self.passed}/{self.total} 用例通过，"
                f"{self.failed} 个失败（{self.duration_ms:.0f}ms）{tail}"
            )
        if self.outcome == "oom":
            peak = f"，峰值 {self.peak_mem_mb:.0f}MB" if self.peak_mem_mb else ""
            return f"沙盒执行：内存超限终止（{self.duration_ms:.0f}ms{peak}）"
        return ""

    def to_dict(self) -> Dict:
        return {
            "outcome": self.outcome,
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "durationMs": round(self.duration_ms, 1),
            "cases": [
                {"name": name, "passed": ok, "detail": detail} for name, ok, detail in self.cases
            ],
            "outputTail": self.output_tail,
            "reason": self.reason,
            "codeBytes": self.code_bytes,
            "peakMemMb": self.peak_mem_mb,
            "outputCapped": self.output_capped,
            "verifiable": self.verifiable,
            "evidence": self.evidence_text(),
        }


def extract_python_blocks(answer: str) -> List[str]:
    """
    从候选答案里抽出 Python 代码块。

    优先取 ``` 围栏块；一个都没有时，若整段文本本身像代码（含 def/import/assert）
    则整体当作一个块——有些 agent 就是直接吐裸代码，不该因为少了三个反引号就判「无代码」。
    """
    text = answer or ""
    blocks = [b.strip() for b in _PY_BLOCK_RE.findall(text) if b.strip()]
    if blocks:
        return blocks
    stripped = text.strip()
    if not stripped:
        return []
    looks_like_code = bool(
        re.search(r"(^|\n)\s*(def |class |import |from \w+ import |assert )", stripped)
    )
    return [stripped] if looks_like_code else []


def _sandbox_env() -> Dict[str, str]:
    """环境变量白名单：绝不把 JUDGE_API_KEY 之类的凭据带进候选代码的进程。"""
    keep = ("PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "TEMP", "TMP")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # 明确告诉候选代码「这里没有网络凭据」，顺便让依赖 requests 的代码更快失败
    env["NO_PROXY"] = "*"
    return env


def _preexec_limits(cpu_seconds: int, mem_mb: int):
    """POSIX 资源限制（Windows 上返回 None，由 Job Object + 超时兜底）。

    这是**可靠的**内存硬上限来源：RLIMIT_AS 超限时内核向进程发 SIGKILL/SIGSEGV，
    子进程 returncode<0——据此识别 OOM。Windows 无 ulimit，内存限额交给 Job Object
    （尽力而为，见 _create_windows_job 的已知局限）。
    """
    if os.name != "posix":
        return None

    def _apply() -> None:  # pragma: no cover —— 子进程内执行，覆盖率统计不到
        import resource

        os.setsid()  # 独立进程组，超时能整组 kill
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        mem_bytes = mem_mb * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        except (ValueError, OSError):
            pass  # 部分平台（如 macOS）不支持 RLIMIT_AS，退化为仅超时保护
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
        try:
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        except (ValueError, OSError):
            pass

    return _apply


def _decode(data: Optional[bytes]) -> str:
    """把子进程输出解码为文本。utf-8 优先、errors=replace 兜底。

    为什么不用 text=True：Windows 上子进程可能吐出 GBK 字节（如 0xb1），
    以 locale 编码解码会抛 UnicodeDecodeError → proc.stdout 变 None →
    下游 splitlines() 崩溃。字节模式 + replace 保证任何脏输出都收敛为可解析文本。
    """
    if not data:
        return ""
    return data.decode("utf-8", errors="replace")


# ======================================================================
# 子进程执行核心（统一 POSIX / Windows：限额 + 峰值采集 + 输出封顶 + 超时强杀）
# ======================================================================
@dataclass
class _SpawnResult:
    """_spawn_and_wait 的结构化返回：把「跑完的结果」与「怎么收的尾」一次性带回。"""

    returncode: Optional[int]
    stdout: bytes
    stderr: bytes
    peak_mem_mb: Optional[float]
    timed_out: bool
    output_capped: bool


def _drain_into(pipe, cap: int, holder: List[Tuple[bytes, bool]]) -> None:
    """把管道读到上限为止，超出部分丢弃，结果写入 holder[0]=(bytes, capped)。

    为什么不用 communicate() 一次性读：那会把洪水输出整块缓冲进内存（正是要防的
    print 洪水 DoS）。分块读 + 硬上限让单流内存占用封顶在 cap 附近。
    双流各起一线程并发排空，避免单管道写满导致子进程阻塞（死锁）。
    """
    chunks: List[bytes] = []
    total = 0
    capped = False
    try:
        while True:
            chunk = pipe.read(65536)
            if not chunk:
                break
            if total < cap:
                remain = cap - total
                chunks.append(chunk[:remain])
                total += len(chunk)
                if len(chunk) > remain:
                    capped = True
            else:
                capped = True
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass
    holder.append((b"".join(chunks), capped))


def _kill_tree(proc: subprocess.Popen, job) -> None:
    """超时强杀整个进程组（POSIX）/ 整棵进程树（Windows Job）。

    POSIX 上 preexec 已 setsid，进程组 id == pid，killpg 一锅端；
    Windows 上 TerminateJobObject 杀光 Job 内所有进程（含候选 fork 出的子进程）。
    """
    if os.name == "nt":
        if job is not None:
            _terminate_windows_job(job)
        else:
            try:
                proc.kill()
            except Exception:
                pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# ---- Windows Job Object（ctypes 标准库，零三方依赖）----
# 学术/工程依据：Windows 无 ulimit，Job Object 是进程级资源配额的官方机制
# （JOBOBJECT_EXTENDED_LIMIT_INFORMATION，MSDN）。用于对齐 POSIX 的限额能力。
if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _JOB_LIMIT_PROCESS_MEMORY = 0x00000100
    _JOB_LIMIT_ACTIVE_PROCESS = 0x00000008
    _JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JobObjectExtendedLimitInformation = 9
    _PROCESS_ALL_ACCESS = 0x1F0FFF

    class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", _IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    def _create_windows_job(mem_mb: int):
        """创建 Job Object 并设内存/进程数限额。

        已知局限（实测，2026-08，本内存受限 Windows 机器）：PROCESS_MEMORY_LIMIT
        的 enforcement 未稳定触发——Python 分配器常在触及 Job 限额前就抛 MemoryError。
        因此 Windows 内存上限视为**尽力而为**；可靠的内存硬隔离以 POSIX RLIMIT_AS 为准。
        任何失败返回 None（调用方降级为仅超时保护，不抛）。
        """
        try:
            k32 = ctypes.windll.kernel32
            job = k32.CreateJobObjectW(None, None)
            if not job:
                return None
            info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = (
                _JOB_LIMIT_PROCESS_MEMORY
                | _JOB_LIMIT_ACTIVE_PROCESS
                | _JOB_LIMIT_KILL_ON_JOB_CLOSE
            )
            info.ProcessMemoryLimit = int(mem_mb) * 1024 * 1024
            info.BasicLimitInformation.ActiveProcessLimit = 64
            ok = k32.SetInformationJobObject(
                job,
                _JobObjectExtendedLimitInformation,
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
            if not ok:
                k32.CloseHandle(job)
                return None
            return job
        except Exception:
            return None

    def _assign_windows_job(job, pid: int) -> bool:
        """把已启动的子进程 handle 赋给 Job（失败返回 False，降级不抛）。"""
        try:
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(_PROCESS_ALL_ACCESS, False, int(pid))
            if not h:
                return False
            ok = bool(k32.AssignProcessToJobObject(job, h))
            k32.CloseHandle(h)
            return ok
        except Exception:
            return False

    def _windows_peak_mem_mb(job) -> Optional[float]:
        """从 Job Object 读 PeakProcessMemoryUsed（MB）；采不到 None。"""
        try:
            k32 = ctypes.windll.kernel32
            info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            ret = ctypes.c_size_t(0)
            ok = k32.QueryInformationJobObject(
                job,
                _JobObjectExtendedLimitInformation,
                ctypes.byref(info),
                ctypes.sizeof(info),
                ctypes.byref(ret),
            )
            if not ok:
                return None
            peak = int(info.PeakProcessMemoryUsed)
            return round(peak / (1024 * 1024), 2) if peak > 0 else None
        except Exception:
            return None

    def _terminate_windows_job(job) -> bool:
        try:
            return bool(ctypes.windll.kernel32.TerminateJobObject(job, 1))
        except Exception:
            return False

    def _close_handle(h) -> None:
        try:
            ctypes.windll.kernel32.CloseHandle(h)
        except Exception:
            pass

else:
    # POSIX 桩：这些 Windows 专用函数在 POSIX 上不调用，给出空实现避免 NameError。
    def _create_windows_job(mem_mb: int):  # type: ignore[no-redef]
        return None

    def _assign_windows_job(job, pid: int) -> bool:  # type: ignore[no-redef]
        return False

    def _windows_peak_mem_mb(job) -> Optional[float]:  # type: ignore[no-redef]
        return None

    def _terminate_windows_job(job) -> bool:  # type: ignore[no-redef]
        return False

    def _close_handle(h) -> None:  # type: ignore[no-redef]
        return None


def _posix_peak_mem_mb(workdir: str) -> Optional[float]:
    """POSIX 峰值：读 harness 自报的 _ac_peak.json（RUSAGE_SELF.ru_maxrss）。

    Linux 上 ru_maxrss 单位是 KB，macOS 上是字节——按平台换算。文件不存在
    （进程被强杀时 atexit 不触发）返回 None。
    """
    try:
        with open(os.path.join(workdir, "_ac_peak.json"), encoding="utf-8") as fh:
            kb = int(json.load(fh).get("peak_kb", 0))
    except Exception:
        return None
    if kb <= 0:
        return None
    if sys.platform == "darwin":
        return round(kb / (1024 * 1024), 2)  # macOS：ru_maxrss 单位字节
    return round(kb / 1024.0, 2)  # Linux：ru_maxrss 单位 KB


def _fallback_run(
    cmd: List[str], cwd: str, env: Dict[str, str], timeout: float, preexec, cap: int
) -> _SpawnResult:
    """限额/采集链路异常时的降级：仅墙钟超时保护的普通 subprocess.run。

    降级不抛——沙盒自身故障不得冒泡为评测失败。输出事后截断到 cap。
    """
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            preexec_fn=preexec if os.name == "posix" else None,
            check=False,
        )
        out = proc.stdout or b""
        err = proc.stderr or b""
        capped = (len(out) + len(err)) > cap
        return _SpawnResult(proc.returncode, out, err, None, False, capped)
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or b""
        err = exc.stderr or b""
        return _SpawnResult(None, out, err, None, True, (len(out) + len(err)) > cap)
    except Exception:
        return _SpawnResult(None, b"", b"", None, False, False)


def _spawn_and_wait(
    cmd: List[str],
    cwd: str,
    env: Dict[str, str],
    timeout: float,
    memory: int,
    preexec,
) -> _SpawnResult:
    """启动子进程、施加限额、并发排空输出、等待、采集峰值内存。

    - 输出双流各起一线程分块读到 `sandbox_max_output_bytes` 上限，防 print 洪水；
    - Windows 建 Job Object 限额并 Assign；POSIX 用 preexec 的 setrlimit；
    - 超时强杀整组/整树；峰值内存按平台采集（POSIX 自报文件 / Windows Job）。
    任何限额或采集故障降级为 _fallback_run（仅超时保护），绝不抛。
    """
    cap = max(1024, int(getattr(settings, "sandbox_max_output_bytes", 2_000_000)))
    collect_peak = bool(getattr(settings, "sandbox_peak_mem", True))
    job = None
    try:
        if os.name == "nt":
            job = _create_windows_job(memory)
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=preexec if os.name == "posix" else None,
        )
        if os.name == "nt" and job is not None:
            _assign_windows_job(job, proc.pid)

        out_holder: List[Tuple[bytes, bool]] = []
        err_holder: List[Tuple[bytes, bool]] = []
        t_out = threading.Thread(target=_drain_into, args=(proc.stdout, cap, out_holder))
        t_err = threading.Thread(target=_drain_into, args=(proc.stderr, cap, err_holder))
        t_out.daemon = True
        t_err.daemon = True
        t_out.start()
        t_err.start()

        try:
            proc.wait(timeout=timeout)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(proc, job)
            try:
                proc.wait(timeout=5)
            except Exception:
                pass

        t_out.join(timeout=5)
        t_err.join(timeout=5)

        out_bytes = out_holder[0][0] if out_holder else b""
        err_bytes = err_holder[0][0] if err_holder else b""
        capped = (out_holder[0][1] if out_holder else False) or (
            err_holder[0][1] if err_holder else False
        )

        peak: Optional[float] = None
        if collect_peak:
            if os.name == "nt" and job is not None:
                peak = _windows_peak_mem_mb(job)
            elif os.name == "posix":
                peak = _posix_peak_mem_mb(cwd)

        return _SpawnResult(proc.returncode, out_bytes, err_bytes, peak, timed_out, capped)
    except Exception as exc:  # noqa: BLE001 —— 限额/采集故障降级，绝不冒泡
        logger.warning("沙盒子进程限额/采集异常，降级为仅超时保护：%s", exc)
        return _fallback_run(cmd, cwd, env, timeout, preexec, cap)
    finally:
        if job is not None:
            _close_handle(job)


def _is_oom(returncode: Optional[int], marker: str, combined: str) -> bool:
    """判断一次执行是否因内存超限而终止（区别于 timeout / failed）。

    两条互补证据（任一命中即判 oom）：
    1. POSIX：returncode<0（被信号杀死，RLIMIT_AS 典型触发 SIGKILL），且 stderr 含
       MemoryError 或完全无输出——信号强杀常不留 Python  traceback。
    2. 跨平台兜底：进程非零退出、未产出干净 harness 收尾（marker 非 done/no_tests）、
       且输出含 MemoryError——覆盖「Python 分配器先抛 MemoryError 再退出」的情形
       （Windows 实测即此路径：rc=3 经 harness 收敛，stderr 带 MemoryError）。

    为何要求 marker 非 done/no_tests：被 harness 捕获成 CASE_FAIL 的 MemoryError 是
    候选测试的普通失败，不应误判为 OOM；只有「进程没跑完就因内存挂了」才算 oom。
    """
    has_memerr = "MemoryError" in combined
    if returncode is not None and returncode < 0:
        # 被信号强杀（POSIX RLIMIT_AS → SIGKILL 的典型表现）
        return has_memerr or not combined.strip()
    # 跨平台：非零退出 + 无干净收尾 + 携带 MemoryError
    return (
        returncode not in (0, None)
        and marker not in ("done", "no_tests")
        and has_memerr
    )


def _parse_harness_output(stdout: str) -> tuple:
    """解析 harness 输出 → (cases, total, failed, marker)。"""
    cases: List[tuple] = []
    total = 0
    failed = 0
    marker = ""
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("CASE_PASS "):
            cases.append((line[len("CASE_PASS ") :].strip(), True, ""))
        elif line.startswith("CASE_FAIL "):
            body = line[len("CASE_FAIL ") :]
            name, _, detail = body.partition(" :: ")
            cases.append((name.strip(), False, detail.strip()))
        elif line.startswith("HARNESS_DONE"):
            marker = "done"
            m = re.search(r"total=(\d+) failed=(\d+)", line)
            if m:
                total, failed = int(m.group(1)), int(m.group(2))
        elif line.startswith("HARNESS_NO_TESTS"):
            marker = "no_tests"
        elif line.startswith("HARNESS_IMPORT_ERROR"):
            marker = "import_error"
    if total == 0:
        total = len(cases)
        failed = sum(1 for c in cases if not c[1])
    return cases, total, failed, marker


def run_python_answer(
    answer: str,
    *,
    task_id: Optional[str] = None,
    timeout_s: Optional[float] = None,
    mem_mb: Optional[int] = None,
) -> SandboxResult:
    """
    在受限子进程里执行候选答案中的 Python 代码，并运行其中的 test_* 用例。

    返回 SandboxResult；**任何异常都被收敛为 outcome='error'**，
    绝不让沙盒的问题冒泡成评测失败（沙盒挂了是我们的问题，不是候选的问题）。
    """
    if not settings.sandbox_enabled:
        return SandboxResult(
            outcome="disabled",
            reason="沙盒未启用（设置 SANDBOX_ENABLED=true 开启真实执行验证）",
        )

    timeout = float(timeout_s if timeout_s is not None else settings.sandbox_timeout)
    memory = int(mem_mb if mem_mb is not None else settings.sandbox_mem_mb)

    blocks = extract_python_blocks(answer)
    if not blocks:
        return SandboxResult(outcome="no_code", reason="答案中未找到可执行的 Python 代码")

    source = "\n\n".join(blocks)
    code_bytes = len(source.encode("utf-8"))
    workdir = tempfile.mkdtemp(prefix="agentcorp-sandbox-")
    started = 0.0
    try:
        import time

        # ── 固定夹具路径（SWE-bench 范式）：有 curated fixture 就跑固定断言，
        #    不跑候选自写测试——后者 `assert True` 即可骗过，机器验证失去意义。
        #    候选代码必须以 solution.py 呈现（夹具 `from solution import ...`）。
        spec = get_sandbox_spec(task_id) if task_id else None
        if spec is not None and spec.test_harness:
            with open(os.path.join(workdir, "solution.py"), "w", encoding="utf-8") as fh:
                fh.write(source)
            for fname, content in spec.fixture_files.items():
                with open(os.path.join(workdir, fname), "w", encoding="utf-8") as fh:
                    fh.write(content)
            # 夹具 harness 顶部同样注入隔离 prologue（网络/导入黑名单对夹具路径同样生效）。
            fixture_src = _compose_harness(spec.test_harness)
            with open(os.path.join(workdir, "_fixture_harness.py"), "w", encoding="utf-8") as fh:
                fh.write(fixture_src)

            started = time.perf_counter()
            spawn = _spawn_and_wait(
                [sys.executable, "-I", "-B", "_fixture_harness.py"],
                cwd=workdir,
                env=_sandbox_env(),
                timeout=timeout,
                memory=memory,
                preexec=_preexec_limits(int(timeout) + 1, memory),
            )
            duration_ms = (time.perf_counter() - started) * 1000.0

            if spawn.timed_out:
                return SandboxResult(
                    outcome="failed",
                    total=1,
                    passed=0,
                    failed=1,
                    duration_ms=timeout * 1000.0,
                    cases=[("<timeout>", False, f"夹具执行超过 {timeout:.0f}s 未结束")],
                    reason="timeout",
                    peak_mem_mb=spawn.peak_mem_mb,
                    output_capped=spawn.output_capped,
                    code_bytes=code_bytes,
                )

            combined = _decode(spawn.stdout) + "\n" + _decode(spawn.stderr)
            # OOM 识别（夹具 harness 无 CASE 标记，marker 传空串走跨平台兜底分支）。
            if _is_oom(spawn.returncode, "", combined):
                return SandboxResult(
                    outcome="oom",
                    duration_ms=duration_ms,
                    output_tail=combined.strip()[-1200:],
                    reason="memory limit exceeded",
                    peak_mem_mb=spawn.peak_mem_mb,
                    output_capped=spawn.output_capped,
                    code_bytes=code_bytes,
                )
            # 夹具 harness 只在全部断言跑完后打印一行 JSON；若它崩溃（典型是候选
            # 未定义入口函数导致 `from solution import ...` 失败），则无 JSON 输出。
            # 这种「候选未满足夹具契约」是候选的失败，不是沙盒故障 → 记为 failed。
            tail = combined.strip()[-1200:]
            last_line = (
                _decode(spawn.stdout).strip().splitlines()[-1]
                if _decode(spawn.stdout).strip()
                else ""
            )
            try:
                report = json.loads(last_line)
                ftotal = int(report.get("total", 0))
                fpassed = int(report.get("passed", 0))
                ferrors = [str(e) for e in report.get("errors", [])]
            except (json.JSONDecodeError, ValueError, IndexError):
                return SandboxResult(
                    outcome="failed",
                    total=1,
                    passed=0,
                    failed=1,
                    duration_ms=duration_ms,
                    cases=[("<import>", False, "夹具无法导入 solution（缺入口函数或导入期异常）")],
                    output_tail=tail,
                    reason="夹具契约未满足：候选未定义入口函数或导入期异常",
                    peak_mem_mb=spawn.peak_mem_mb,
                    output_capped=spawn.output_capped,
                    code_bytes=code_bytes,
                )
            cases = []
            for err in ferrors:
                name = err.split(":", 1)[0].strip() or "<assert>"
                cases.append((name, False, err[:200]))
            for i in range(fpassed):
                cases.append((f"fixture_pass_{i}", True, ""))
            ffailed = ftotal - fpassed
            return SandboxResult(
                outcome="passed" if ffailed == 0 else "failed",
                total=ftotal,
                passed=fpassed,
                failed=ffailed,
                duration_ms=duration_ms,
                cases=cases,
                output_tail=tail,
                peak_mem_mb=spawn.peak_mem_mb,
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )

        # ── 自测路径（无夹具）：跑候选自带的 test_*（保留向后兼容）──
        with open(os.path.join(workdir, "answer.py"), "w", encoding="utf-8") as fh:
            fh.write(source)
        # harness 顶部注入隔离 prologue。
        with open(os.path.join(workdir, "_harness.py"), "w", encoding="utf-8") as fh:
            fh.write(_compose_harness(_HARNESS))

        started = time.perf_counter()
        spawn = _spawn_and_wait(
            [sys.executable, "-I", "-B", "_harness.py"],
            cwd=workdir,
            env=_sandbox_env(),
            timeout=timeout,
            memory=memory,
            preexec=_preexec_limits(int(timeout) + 1, memory),
        )
        duration_ms = (time.perf_counter() - started) * 1000.0

        if spawn.timed_out:
            return SandboxResult(
                outcome="failed",
                total=1,
                passed=0,
                failed=1,
                duration_ms=timeout * 1000.0,
                cases=[("<timeout>", False, f"执行超过 {timeout:.0f}s 未结束（疑似死循环/阻塞）")],
                reason="timeout",
                peak_mem_mb=spawn.peak_mem_mb,
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )

        out_text = _decode(spawn.stdout)
        err_text = _decode(spawn.stderr)
        combined = f"{out_text}\n{err_text}".strip()
        cases, total, failed, marker = _parse_harness_output(out_text)

        # OOM 识别优先于普通失败分支（内存超限是资源事件，不是断言错误）。
        if _is_oom(spawn.returncode, marker, combined):
            return SandboxResult(
                outcome="oom",
                duration_ms=duration_ms,
                output_tail=combined[-1200:],
                reason="memory limit exceeded",
                peak_mem_mb=spawn.peak_mem_mb,
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )

        if marker == "no_tests":
            return SandboxResult(
                outcome="no_tests",
                duration_ms=duration_ms,
                output_tail=combined[-1200:],
                reason="代码可导入，但未提供 test_* 用例，无法真实验证",
                peak_mem_mb=spawn.peak_mem_mb,
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )
        if marker == "import_error":
            return SandboxResult(
                outcome="failed",
                total=1,
                passed=0,
                failed=1,
                duration_ms=duration_ms,
                cases=[("<import>", False, "代码无法导入（语法错误 / 未定义名称 / 缺依赖）")],
                output_tail=combined[-1200:],
                peak_mem_mb=spawn.peak_mem_mb,
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )
        if total == 0:
            return SandboxResult(
                outcome="error",
                duration_ms=duration_ms,
                output_tail=combined[-1200:],
                reason=f"harness 未产出可解析结果（exit={spawn.returncode}）",
                peak_mem_mb=spawn.peak_mem_mb,
                output_capped=spawn.output_capped,
                code_bytes=code_bytes,
            )

        return SandboxResult(
            outcome="passed" if failed == 0 else "failed",
            total=total,
            passed=total - failed,
            failed=failed,
            duration_ms=duration_ms,
            cases=cases,
            output_tail=combined[-1200:],
            peak_mem_mb=spawn.peak_mem_mb,
            output_capped=spawn.output_capped,
            code_bytes=code_bytes,
        )
    except Exception as exc:  # noqa: BLE001 —— 沙盒自身故障不得冒泡为评测失败
        logger.warning("沙盒执行异常：%s", exc)
        return SandboxResult(outcome="error", reason=f"沙盒执行异常：{exc}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def verified_evidence_for(task_id: str, result: SandboxResult) -> Dict[str, str]:
    """
    把执行结果映射为 requiresReal 维的 verified_evidence。

    ⚠️ 抬权门槛 = outcome == "passed"，而非「跑过就算」（verifiable）。

    语义区分（这是 Q6 闸门不被「自我作证」击穿的关键）：
    - **只有全绿（passed）才抬升降权**：能解除 code_runnability 的 Q6 降权。
    - **失败（failed）是负面事实，不抬权**：`verifiable` 为真只能说明「确实测到了
      可运行性结论」，但结论是「跑不过」。若把失败也当抬权证据，等于让一段 provably
      跑不起来的代码免于降权，而 LLM 评委可能同时给它打高分——双重失真。失败的
      可运行性由 `evidence_text()` 单独承载为展示性负面证据，**绝不进抬权键**。
    - **内存超限（oom）同理不抬权**：资源配额命中同样是「没跑成」的负面事实。
    - no_tests / no_code / error / disabled 一律不产出 —— 缺证据就该继续降权，
      这正是 Q6 闸门存在的意义（「没考到」≠「考过了」）。

    `code_security` 不由本模块产出：跑通测试不等于扫过安全，
    那需要真实的静态扫描接入（路线图），此处宁缺毋滥。
    """
    if result.outcome != "passed":
        return {}
    return {"code_runnability": f"[{task_id}] {result.evidence_text()}"}
