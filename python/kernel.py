"""Persistent mathematical Python, supervised and confined by the Harness host.

The audit hook and code checks reduce accidental access; they supplement the
host process sandbox and are not a security boundary for hostile Python.
"""
from __future__ import annotations

import ast
import builtins
import contextlib
import io
import json
import os
import reprlib
from pathlib import Path
import sys
import sysconfig
import traceback

import mpmath
import sympy as sp


ALLOWED_IMPORTS = frozenset({
    "sympy", "mpmath", "math", "cmath", "fractions", "decimal",
    "itertools", "functools", "collections", "statistics", "random",
})
BLOCKED_ATTRIBUTES = frozenset({
    "os", "sys", "builtins", "subprocess", "socket", "ctypes", "importlib",
    "environ", "getenv", "modules", "stdin", "stdout", "stderr",
    "open", "read_text", "read_bytes", "write_text", "write_bytes",
})
SAFE_BUILTINS = (
    "abs all any ascii bin bool bytearray bytes callable chr complex dict divmod "
    "enumerate filter float format frozenset hash hex int isinstance issubclass "
    "iter len list map max min next oct ord pow print range repr reversed round "
    "set slice sorted str sum tuple type zip object super property staticmethod classmethod "
    "ArithmeticError AssertionError BaseException Exception IndexError KeyError "
    "LookupError NameError NotImplementedError OverflowError RuntimeError "
    "StopIteration SyntaxError SystemExit TypeError ValueError ZeroDivisionError"
).split()


class OutputBuffer(io.TextIOBase):
    """Capture at most the configured number of characters without growing further."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.parts: list[str] = []
        self.length = 0
        self.truncated = False

    def write(self, text: str) -> int:
        remaining = self.limit - self.length
        retained = text[:remaining]
        if retained:
            self.parts.append(retained)
        self.length += len(retained)
        self.truncated |= len(text) > remaining
        return len(text)

    def flush(self) -> None:
        pass

    def value(self) -> str:
        return "".join(self.parts)


class ResultRepr(reprlib.Repr):
    """Limit collection traversal and result text; the host bounds custom repr execution."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit
        self.nodes = limit
        self.truncated = False
        self.maxstring = self.maxlong = self.maxother = limit
        self.maxlist = self.maxtuple = self.maxdict = self.maxset = limit
        self.maxfrozenset = self.maxdeque = self.maxarray = limit

    def repr1(self, value, level: int) -> str:
        self.nodes -= 1
        if self.nodes < 0:
            self.truncated = True
            return "..."
        if type(value) in {list, tuple, dict, set, frozenset}:
            self.truncated |= len(value) > self.limit or bool(value) and level <= 0
        return self.bound(super().repr1(value, level))

    def bound(self, text: str) -> str:
        self.truncated |= len(text) > self.limit
        return text[:self.limit]

    def repr_str(self, value: str, level: int) -> str:
        self.truncated |= len(value) > self.limit
        return self.bound(repr(value[:self.limit]))

    def repr_int(self, value: int, level: int) -> str:
        return self.bound(repr(value))

    def repr_instance(self, value, level: int) -> str:
        return self.bound(repr(value))


def allowed_import(name: str, globals=None, locals=None, fromlist=(), level=0):
    """Expose computational imports to executed code, preserving Python import syntax."""
    if level or name.split(".", 1)[0] not in ALLOWED_IMPORTS:
        raise PermissionError(f"Import {name!r} is unavailable; use SymPy and the supported computation libraries")
    return builtins.__import__(name, globals, locals, fromlist, level)


def check_code(tree: ast.Module) -> None:
    """Reject direct access to interpreter internals and unsupported imports."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr in BLOCKED_ATTRIBUTES):
            raise PermissionError(f"Attribute {node.attr!r} is unavailable in the compute session")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise PermissionError("Interpreter internals are unavailable in the compute session")
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level or node.module is None:
                raise PermissionError("Relative imports are unavailable in the compute session")
            names = [node.module]
            if any(alias.name.startswith("_") for alias in node.names):
                raise PermissionError("Private imports are unavailable in the compute session")
        else:
            continue
        for name in names:
            if name.split(".", 1)[0] not in ALLOWED_IMPORTS:
                raise PermissionError(f"Import {name!r} is unavailable; use SymPy and the supported computation libraries")


def install_audit_policy() -> None:
    """Allow runtime reads while denying file writes, networking, and child processes."""
    paths = sysconfig.get_paths()
    runtime_roots = {
        Path(value).resolve()
        for key, value in paths.items()
        if key in {"stdlib", "platstdlib", "purelib", "platlib"}
    }
    own_packages = {Path(paths[key]).resolve() for key in ("purelib", "platlib")}
    base_paths = sysconfig.get_paths(vars={"base": sys.base_prefix, "platbase": sys.base_prefix})
    external_packages = {Path(base_paths[key]).resolve() for key in ("purelib", "platlib")} - own_packages
    runtime_roots.update({Path(sys.base_prefix, "DLLs").resolve(), Path(sys.prefix, "DLLs").resolve()})
    runtime_files = {Path(__file__).resolve()}
    runtime_files.update(Path(entry).resolve() for entry in sys.path if entry.endswith(".zip"))

    def permit_read(candidate) -> None:
        if not isinstance(candidate, (str, bytes, os.PathLike)):
            raise PermissionError("File descriptor access is unavailable in the compute session")
        resolved = Path(os.fsdecode(candidate)).resolve()
        if any(resolved == root or root in resolved.parents for root in external_packages):
            raise PermissionError("The compute session cannot read system site packages")
        if resolved not in runtime_files and not any(resolved == root or root in resolved.parents for root in runtime_roots):
            raise PermissionError("The compute session can read only its Python runtime and installed libraries")

    def audit(event: str, args: tuple) -> None:
        if event == "open":
            filename, mode, flags = args
            if (mode and any(flag in mode for flag in "wax+")) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                raise PermissionError("File writes are unavailable in the compute session")
            permit_read(filename)
        elif event in {"os.listdir", "os.scandir"}:
            permit_read(args[0])
        elif event.startswith(("socket.", "subprocess.", "ctypes.", "winreg.", "http.client.", "urllib.")) or event in {
            "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty",
            "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.link", "os.symlink",
            "os.truncate", "os.chmod", "os.chown", "os.utime", "os.chdir", "os.putenv", "os.unsetenv",
        }:
            raise PermissionError(f"Operation {event!r} is unavailable in the compute session")
        elif event == "import" and args[0].split(".", 1)[0] in {"ctypes", "_ctypes", "socket", "_socket", "subprocess", "_posixsubprocess", "multiprocessing"}:
            raise PermissionError("Native process and network modules are unavailable in the compute session")

    sys.addaudithook(audit)


def execute(code: str, namespace: dict, limit: int) -> dict:
    """Execute one request without discarding variables after an ordinary Python error."""
    stdout = OutputBuffer(limit)
    stderr = OutputBuffer(limit)
    result = ""
    formatter = ResultRepr(limit)
    error = None
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            tree = ast.parse(code, filename="<alphasolve>", mode="exec")
            check_code(tree)
            expression = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, "<alphasolve>", "exec"), namespace)
            if expression is not None:
                value = eval(compile(ast.Expression(expression.value), "<alphasolve>", "eval"), namespace)
                if value is not None:
                    result = formatter.repr(value)
        except BaseException as exc:
            error = "".join(traceback.format_exception_only(type(exc), exc))
    values = {"stdout": stdout.value(), "stderr": stderr.value(), "result": result, "error": error}
    truncated = stdout.truncated or stderr.truncated or formatter.truncated
    remaining = limit
    # Report failures even when a preceding print consumed the output budget.
    for field in ("error", "stdout", "stderr", "result"):
        value = values[field]
        if value is not None:
            truncated |= len(value) > remaining
            values[field] = value[:remaining]
            remaining -= len(values[field])
    return {**values, "truncated": truncated}


def main() -> None:
    """Serve the host's serial JSONL requests until its input closes."""
    if sys.version_info < (3, 10):
        raise RuntimeError("AlphaSolve compute requires Python 3.10 or newer")
    if sp.__version__ != "1.14.0" or mpmath.__version__ != "1.3.0":
        raise RuntimeError("Run setup:python to install SymPy 1.14.0 and mpmath 1.3.0")
    limit = int(sys.argv[1])
    if limit < 1:
        raise ValueError("maxOutputChars must be positive")
    namespace = {"__builtins__": {name: getattr(builtins, name) for name in SAFE_BUILTINS}, "__name__": "alphasolve_compute", "sp": sp}
    namespace["__builtins__"]["__import__"] = allowed_import
    namespace["__builtins__"]["__build_class__"] = builtins.__build_class__
    install_audit_policy()
    print(json.dumps({"type": "ready", "sympyVersion": sp.__version__}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        if not isinstance(request, dict) or type(request.get("id")) is not int or not isinstance(request.get("code"), str):
            raise ValueError("Expected a request with integer id and string code")
        response = execute(request["code"], namespace, limit)
        print(json.dumps({"type": "result", "id": request["id"], **response}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
