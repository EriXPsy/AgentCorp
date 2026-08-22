"""
model-service/app/sandbox/security_scan.py
候选代码的真实静态扫描（`code_security` 维的机器可核验证据来源）。

为什么不能沿用「跑测试」那套：测试通过只证明**功能**成立，与安全无关。
一段 `eval(user_input)` 可以完美通过所有单元测试。因此 code_security 需要
一条独立的证据链 —— 扫描器读代码结构，找的是「有没有危险构造」，
而不是「结果对不对」。

两级实现，优先级从高到低：
1. **bandit**（若环境已安装）：业界通用的 Python 安全扫描器，规则最全。
2. **内置 AST 扫描器**（零依赖，永远可用）：用标准库 ast 做结构匹配，
   覆盖 OWASP 里对 Python 最常见的一组高危构造。规则表显式列出、可复核，
   不做「看起来像」的模糊匹配 —— 静态扫描的价值就在于结论确定且可重放。

刻意不做的事：
- **不用 LLM 判断安全性**。那会让 code_security 退回「模型说了算」，
  正是本模块要消灭的东西。
- **不把「零发现」等同于「安全」**。证据文本写的是「扫描 N 条规则，0 处高危」，
  陈述的是扫描这件事发生过及其结果，而不是安全性的结论。
"""
from __future__ import annotations

import ast
import json
import logging
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..config import settings

logger = logging.getLogger("security_scan")


@dataclass
class SecurityFinding:
    """一条扫描发现（位置 + 规则 + 严重度，均可人工复核）。"""

    rule: str
    severity: str  # 'high' | 'medium' | 'low'
    line: int
    message: str


@dataclass
class SecurityScanResult:
    """一次静态扫描的结果。"""

    #: 'scanned' = 真的扫过；'no_code' = 没有可扫的代码；
    #: 'syntax_error' = 代码无法解析（此时不给安全结论）；'disabled' = 未启用
    outcome: str
    scanner: str = ""
    rules_checked: int = 0
    findings: List[SecurityFinding] = field(default_factory=list)
    reason: str = ""

    @property
    def high(self) -> int:
        return sum(1 for f in self.findings if f.severity == "high")

    @property
    def medium(self) -> int:
        return sum(1 for f in self.findings if f.severity == "medium")

    @property
    def verifiable(self) -> bool:
        """只有真的扫过才算证据。语法错误的代码不给安全结论。"""
        return self.outcome == "scanned"

    def evidence_text(self) -> str:
        if not self.verifiable:
            return ""
        if not self.findings:
            return f"静态扫描（{self.scanner}，{self.rules_checked} 条规则）：0 处高危"
        top = self.findings[0]
        return (
            f"静态扫描（{self.scanner}，{self.rules_checked} 条规则）："
            f"{self.high} 处高危 / {self.medium} 处中危；"
            f"首条 L{top.line} {top.rule}：{top.message}"
        )

    def to_dict(self) -> Dict:
        return {
            "outcome": self.outcome,
            "scanner": self.scanner,
            "rulesChecked": self.rules_checked,
            "high": self.high,
            "medium": self.medium,
            "findings": [
                {"rule": f.rule, "severity": f.severity, "line": f.line, "message": f.message}
                for f in self.findings
            ],
            "reason": self.reason,
            "verifiable": self.verifiable,
            "evidence": self.evidence_text(),
        }


# ======================================================================
# 内置 AST 规则表（零依赖，规则显式可复核）
# ======================================================================
#: 直接调用即高危的内置函数
_DANGEROUS_CALLS: Dict[str, tuple] = {
    "eval": ("high", "eval() 执行任意表达式；输入可控时等价于远程代码执行"),
    "exec": ("high", "exec() 执行任意语句；输入可控时等价于远程代码执行"),
    "compile": ("medium", "compile() 动态编译代码，需确认来源可信"),
    "__import__": ("medium", "动态导入，模块名可控时可加载非预期模块"),
}

#: 模块.函数 形式的高危调用
_DANGEROUS_ATTR_CALLS: Dict[str, tuple] = {
    "os.system": ("high", "os.system() 走 shell，命令拼接即命令注入"),
    "os.popen": ("high", "os.popen() 走 shell，命令拼接即命令注入"),
    "pickle.load": ("high", "pickle 反序列化不可信数据可执行任意代码"),
    "pickle.loads": ("high", "pickle 反序列化不可信数据可执行任意代码"),
    "yaml.load": ("high", "yaml.load 未指定 SafeLoader 时可构造任意对象"),
    "marshal.loads": ("high", "marshal 反序列化不可信数据不安全"),
    "shutil.rmtree": ("medium", "递归删除，路径可控时可造成越权删除"),
    "tempfile.mktemp": ("medium", "mktemp 存在竞态，应改用 mkstemp"),
}

#: subprocess 家族：只有 shell=True 才判高危
_SUBPROCESS_FUNCS = {"run", "call", "check_call", "check_output", "Popen"}

#: 疑似硬编码凭据的变量名
_SECRET_NAMES = ("password", "passwd", "secret", "token", "api_key", "apikey", "access_key")

#: 规则总数（写进证据文本，让「扫了多少」这件事本身可核对）
#: +5 = subprocess-shell-true / tls-verify-disabled / path-join-unnormalized
#:       / hardcoded-secret / silent-except
#: +7 = direct-socket / weak-hash:md5 / weak-hash:sha1 / file-write-variable-path
#:       / ffi-usage / assert-on-tuple / bare-except-continued
#: 计数口径与 dict 一致：按「独立 rule 名」逐个计（故 weak-hash 的 md5/sha1 各算一条）。
RULE_COUNT = (
    len(_DANGEROUS_CALLS)
    + len(_DANGEROUS_ATTR_CALLS)
    + 5  # subprocess / tls / pathjoin / secret / silent
    + 7  # socket / weak-hash-md5 / weak-hash-sha1 / file-write / ffi / assert-tuple / bare-except
)


def _attr_path(node: ast.AST) -> str:
    """把 a.b.c 形式的属性访问还原为点分字符串（拿不到就返回空串）。"""
    parts: List[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return ".".join(reversed(parts))
    return ""


class _Visitor(ast.NodeVisitor):
    """遍历 AST 收集发现。规则都是结构匹配，不做字符串模糊搜索。"""

    def __init__(self) -> None:
        self.findings: List[SecurityFinding] = []

    def _add(self, rule: str, severity: str, node: ast.AST, message: str) -> None:
        self.findings.append(
            SecurityFinding(
                rule=rule,
                severity=severity,
                line=getattr(node, "lineno", 0),
                message=message,
            )
        )

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        # 1) 内置危险函数
        if isinstance(node.func, ast.Name) and node.func.id in _DANGEROUS_CALLS:
            severity, msg = _DANGEROUS_CALLS[node.func.id]
            self._add(f"dangerous-call:{node.func.id}", severity, node, msg)

        path = _attr_path(node.func) if isinstance(node.func, ast.Attribute) else ""

        # 2) 模块级危险调用
        if path in _DANGEROUS_ATTR_CALLS:
            severity, msg = _DANGEROUS_ATTR_CALLS[path]
            self._add(f"dangerous-call:{path}", severity, node, msg)

        # 3) subprocess + shell=True
        if path.startswith("subprocess.") and path.split(".")[-1] in _SUBPROCESS_FUNCS:
            for kw in node.keywords:
                if kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                    self._add(
                        "subprocess-shell-true",
                        "high",
                        node,
                        "subprocess 使用 shell=True，参数可控时可命令注入",
                    )

        # 4) requests/urlopen 关闭证书校验
        if path.startswith("requests.") or path.endswith("urlopen"):
            for kw in node.keywords:
                if kw.arg == "verify" and isinstance(kw.value, ast.Constant) and kw.value.value is False:
                    self._add(
                        "tls-verify-disabled", "high", node, "关闭 TLS 证书校验，等于放弃传输层安全"
                    )

        # 5) 路径拼接未做规范化（os.path.join 直接吃变量 → 潜在路径穿越）
        if path == "os.path.join":
            has_var = any(not isinstance(a, ast.Constant) for a in node.args)
            if has_var:
                self._add(
                    "path-join-unnormalized",
                    "medium",
                    node,
                    "os.path.join 拼接变量路径，未见 normpath/realpath 校验时存在路径穿越风险",
                )

        # 8) 弱哈希（md5/sha1）用于安全校验：抗碰撞/原像攻击不足
        if path in ("hashlib.md5", "hashlib.sha1"):
            algo = path.split(".")[-1]
            self._add(
                f"weak-hash:{algo}",
                "medium",
                node,
                f"hashlib.{algo} 属于弱哈希，勿用于密码/完整性等安全校验（应改用 sha256/blake2 等）",
            )

        # 9) 以变量路径写文件：open(var, "w"/"a") 路径不可控时存在路径穿越/越权写
        #    注意 open 是内置函数，调用形态是裸 Name（_attr_path 对其返回空串），
        #    所以要单独判断 func 是否为 Name("open")。
        is_open_call = path == "open" or (
            isinstance(node.func, ast.Name) and node.func.id == "open"
        )
        if is_open_call and len(node.args) >= 2:
            target = node.args[0]
            mode_arg = node.args[1]
            is_write = (
                isinstance(mode_arg, ast.Constant)
                and isinstance(mode_arg.value, str)
                and any(ch in mode_arg.value for ch in ("w", "a"))
            )
            if is_write and not isinstance(target, ast.Constant):
                self._add(
                    "file-write-variable-path",
                    "medium",
                    node,
                    "open(变量路径, 'w'/'a') 写文件，路径未做白名单/normpath 校验时存在越权写风险",
                )

        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        # 6) 硬编码凭据：形如 password = "xxxx"
        for target in node.targets:
            name = target.id.lower() if isinstance(target, ast.Name) else ""
            if not name:
                continue
            if any(k in name for k in _SECRET_NAMES) and isinstance(node.value, ast.Constant):
                value = node.value.value
                if isinstance(value, str) and len(value) >= 6:
                    self._add(
                        "hardcoded-secret",
                        "high",
                        node,
                        f"疑似硬编码凭据：变量 {name} 直接赋了字符串字面量",
                    )
        self.generic_visit(node)

    def visit_Try(self, node: ast.Try) -> None:  # noqa: N802
        # 7) 静默吞异常：except: pass —— 安全事件被吞掉后无法审计
        for handler in node.handlers:
            body = handler.body
            if len(body) == 1 and isinstance(body[0], ast.Pass):
                self._add(
                    "silent-except",
                    "low",
                    handler,
                    "except: pass 静默吞异常，故障与安全事件都会被隐藏",
                )

            # 13) 静默吞异常（续）：except 后直接 continue/return 且无日志，
            #     同样把安全事件咽下去。这里只抓「单语句 + 跳转」的最赤裸形态，
            #     带日志/上报的写法不报（避免误伤）。
            if len(body) == 1 and isinstance(body[0], (ast.Continue, ast.Return)):
                self._add(
                    "bare-except-continued",
                    "low",
                    handler,
                    "except 后直接 continue/return 且无日志，安全事件被静默吞掉",
                )
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        # 10) 裸 socket：网络场景下直接 import socket 多为危险信号
        for alias in node.names:
            if alias.name == "socket":
                self._add(
                    "direct-socket",
                    "medium",
                    node,
                    "直接 import socket 暴露裸套接字，网络场景需确认用途可信",
                )

        # 12) 外部函数接口：ctypes/cffi 可绕过 Python 安全模型
        for alias in node.names:
            if alias.name in ("ctypes", "cffi", "_ctypes"):
                self._add(
                    "ffi-usage",
                    "high",
                    node,
                    f"import {alias.name} 使用外部函数接口，可绕过 Python 安全模型",
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        # 10b) from socket import ... 同样视为裸 socket 使用
        if node.module == "socket":
            self._add(
                "direct-socket",
                "medium",
                node,
                "from socket import ... 使用裸套接字，网络场景需确认用途可信",
            )
        if node.module in ("ctypes", "cffi", "_ctypes"):
            self._add(
                "ffi-usage",
                "high",
                node,
                f"from {node.module} import ... 使用外部函数接口，可绕过 Python 安全模型",
            )
        self.generic_visit(node)

    def visit_Assert(self, node: ast.Assert) -> None:  # noqa: N802
        # 11) assert (a, b)：非空元组恒真，assert 永不触发，是经典 bug
        if isinstance(node.test, ast.Tuple):
            self._add(
                "assert-on-tuple",
                "high",
                node,
                "assert 的条件是非空元组，恒为真，断言永不触发",
            )
        self.generic_visit(node)


def scan_source_ast(source: str) -> SecurityScanResult:
    """内置 AST 扫描（纯函数，零依赖，结论确定可重放）。"""
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return SecurityScanResult(
            outcome="syntax_error",
            scanner="builtin-ast",
            reason=f"代码无法解析（L{exc.lineno}），不给安全结论",
        )
    visitor = _Visitor()
    visitor.visit(tree)
    order = {"high": 0, "medium": 1, "low": 2}
    findings = sorted(visitor.findings, key=lambda f: (order.get(f.severity, 9), f.line))
    return SecurityScanResult(
        outcome="scanned",
        scanner="builtin-ast",
        rules_checked=RULE_COUNT,
        findings=findings,
    )


def _bandit_available() -> bool:
    try:
        import bandit  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def scan_source_bandit(source: str) -> Optional[SecurityScanResult]:
    """
    bandit 扫描（可选增强）。未安装 / 执行失败时返回 None，由调用方回退内置扫描器。
    """
    if not _bandit_available():
        return None
    workdir = tempfile.mkdtemp(prefix="agentcorp-scan-")
    path = os.path.join(workdir, "answer.py")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(source)
        proc = subprocess.run(
            [sys.executable, "-m", "bandit", "-f", "json", "-q", path],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        data = json.loads(proc.stdout or "{}")
        results = data.get("results") or []
        findings = [
            SecurityFinding(
                rule=str(r.get("test_id", "bandit")),
                severity=str(r.get("issue_severity", "LOW")).lower(),
                line=int(r.get("line_number", 0) or 0),
                message=str(r.get("issue_text", ""))[:200],
            )
            for r in results
        ]
        order = {"high": 0, "medium": 1, "low": 2}
        findings.sort(key=lambda f: (order.get(f.severity, 9), f.line))
        metrics = data.get("metrics", {}).get("_totals", {})
        return SecurityScanResult(
            outcome="scanned",
            scanner="bandit",
            rules_checked=int(metrics.get("loc", 0) or 0) and RULE_COUNT or RULE_COUNT,
            findings=findings,
        )
    except Exception as exc:  # noqa: BLE001 —— 扫描器故障不得冒泡
        logger.warning("bandit 扫描失败，回退内置扫描器：%s", exc)
        return None
    finally:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)


def scan_python_answer(answer: str) -> SecurityScanResult:
    """
    对候选答案中的 Python 代码做静态安全扫描。

    与 run_python_answer 共用同一套代码抽取逻辑，保证「扫的」与「跑的」是同一段代码。
    """
    if not settings.sandbox_enabled:
        return SecurityScanResult(
            outcome="disabled",
            reason="沙盒未启用（SANDBOX_ENABLED=true 同时开启执行与扫描）",
        )

    from .runner import extract_python_blocks

    blocks = extract_python_blocks(answer)
    if not blocks:
        return SecurityScanResult(outcome="no_code", reason="答案中未找到可扫描的 Python 代码")

    source = "\n\n".join(blocks)
    return scan_source_bandit(source) or scan_source_ast(source)


def security_evidence_for(task_id: str, result: SecurityScanResult) -> Dict[str, str]:
    """
    映射为 code_security 的 verified_evidence。

    注意「零发现」也是证据：它记录的事实是「用 N 条规则扫过、没扫出高危」，
    而不是「这段代码是安全的」。后者没有任何静态工具能给出，我们也不假装能给。
    """
    if not result.verifiable:
        return {}
    return {"code_security": f"[{task_id}] {result.evidence_text()}"}
