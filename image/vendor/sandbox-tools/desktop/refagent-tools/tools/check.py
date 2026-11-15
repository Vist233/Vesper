#!/usr/bin/python3
"""check —— 验：产物是否真的做对了。判分不依赖模型自述。

  check.py out/01.png
  check.py out/01.png --simplified        # 只要求蓝矩形
  check.py out/04.pdf
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import envelope, verify  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--kind", default="")
    ap.add_argument("--simplified", action="store_true")
    ap.add_argument("--min-layers", type=int, default=0)
    ap.add_argument("--rule", default="", choices=["", "white"], help="white=基准白底图")
    ap.add_argument("--expect-size", default="", help="如 1280x720")
    a = ap.parse_args()
    kw = {}
    if a.simplified:
        kw["simplified"] = True
    if a.min_layers:
        kw["min_layers"] = a.min_layers
    if a.rule == "white":
        size = [int(v) for v in a.expect_size.split("x")] if a.expect_size else None
        res = verify.check_png_white(a.path, size)
    else:
        res = verify.check(a.path, kind=a.kind or None, **kw)
    res["path"] = a.path
    res["bytes"] = os.path.getsize(a.path) if os.path.exists(a.path) else 0
    return res


if __name__ == "__main__":
    sys.exit(envelope.run(main))
