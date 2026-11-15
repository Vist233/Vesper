#!/usr/bin/python3
"""observe —— 看：把窗口的可交互控件列成 ref 表。

  observe.py --app Pinta               # 交互元素（默认）
  observe.py --app Pinta --all         # 全树
  observe.py --app Pinta --limit 40    # 只看前 40 条
输出 JSON；sid 用于后续 act --snapshot。
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import a11y, env, envelope, refs  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="", help="应用名片段（Pinta / mono-sgen …）")
    ap.add_argument("--all", action="store_true", help="包含不可交互节点")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-nodes", type=int, default=4000)
    ap.add_argument("--display")
    a = ap.parse_args()

    e = env.resolve(a.display)
    env.apply(e)
    if not env.a11y_bus_present(e):
        raise envelope.ToolError("NO_A11Y_BUS",
                                 "无障碍总线不存在（先 envctl up 或设置 RTS_DBUS_FILE）")

    app = a11y.find_app(a.app)
    if app is None:
        raise envelope.ToolError("APP_NOT_FOUND",
                                 f"没有匹配 '{a.app}' 的应用；先跑 envctl launch")
    nodes, truncated = a11y.walk(app, interactive_only=not a.all,
                                 max_nodes=a.max_nodes)
    items = []
    for seq, node, depth, path in nodes:
        items.append({"ref": "s%d" % seq, "node": node, "depth": depth, "path": path,
                      "role": a11y.role(node), "name": a11y.name(node),
                      "actions": a11y.actions(node)[:4],
                      "bounds": a11y.extents(node)})
    sid, rec = refs.save(items, window=app.name, app=app.name)
    rows = [{"ref": it["ref"], "role": it["role"], "name": it["name"][:60],
             "actions": it["actions"], "bounds": it["bounds"]}
            for it in rec["items"]]
    total = len(rec["items"])
    limited = bool(a.limit) and a.limit < total
    if a.limit:
        rows = rows[:a.limit]
    return {"snapshot": sid, "app": app.name, "count": total,
            "returned": len(rows), "truncated": truncated or limited,
            "items": rows}


if __name__ == "__main__":
    sys.exit(envelope.run(main))
