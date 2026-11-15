"""统一信封：所有 tool 都只输出一种 JSON。

约定：
  {ok: bool, data: {...}|null, error: {code, message}|null, ms: float}
调试时只看这个结构，不用记每个 tool 的私有格式。
"""
import json
import sys
import time


class ToolError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def run(fn):
    """把 main() 包成 CLI：捕获异常 -> 统一错误码，永远退出 0（除 --strict）。"""
    t0 = time.perf_counter()
    try:
        data = fn()
        out = {"ok": True, "data": data, "error": None}
    except ToolError as e:
        out = {"ok": False, "data": None,
               "error": {"code": e.code, "message": e.message}}
    except Exception as e:  # 任何未预期异常也走同一条出口
        out = {"ok": False, "data": None,
               "error": {"code": e.__class__.__name__, "message": str(e)[:400]}}
    out["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out["ok"] else 1


def dump(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))
