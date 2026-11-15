"""ref 的跨进程解法：不存对象引用，存"从桌面根到控件的子节点下标路径"。

这样 observe 和 act 可以是两个独立进程：observe 写 snapshot 文件，
act 读文件 -> 按路径重新导航 -> 拿到同一个控件（树没变时 100% 一致，
变了就报 STALE_REF，让调用方重新 observe）。
"""
import json
import os
import time

from . import a11y

REF_DIR = os.environ.get("RTS_REF_DIR", "/tmp/rts-refs")


def path_of(node, root=None):
    """向上走到 desktop 根，记录每层的 child index。"""
    idx = []
    cur = node
    root = root or a11y.desktop()
    while cur is not None and cur is not root:
        parent = None
        try:
            parent = cur.parent
        except Exception:
            parent = None
        if parent is None:
            break
        try:
            kids = list(parent)
            i = next(k for k, c in enumerate(kids) if c == cur)
        except Exception:
            return None
        idx.append(i)
        cur = parent
    idx.reverse()
    return idx


def resolve(path, root=None):
    cur = root or a11y.desktop()
    for i in path:
        try:
            cur = list(cur)[i]
        except Exception:
            return None
    return cur


def save(items, window, app):
    """items: [{ref, node, ...}] -> snapshot 文件，返回 sid。"""
    os.makedirs(REF_DIR, exist_ok=True)
    sid = "s%d" % int(time.time() * 1000)
    out = []
    for it in items:
        p = it.get("path") or path_of(it["node"])
        if p is None:
            continue
        out.append({"ref": it["ref"], "role": it["role"], "name": it["name"],
                    "bounds": it.get("bounds"), "actions": it.get("actions") or [],
                    "path": p})
    rec = {"sid": sid, "window": window, "app": app, "ts": time.time(), "items": out}
    with open(os.path.join(REF_DIR, sid + ".json"), "w") as f:
        json.dump(rec, f, ensure_ascii=False)
    return sid, rec


def load(sid):
    p = os.path.join(REF_DIR, sid + ".json")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def node_for(sid, ref):
    rec = load(sid)
    if not rec:
        return None, "SNAPSHOT_NOT_FOUND"
    root = a11y.find_app(rec.get("app", "")) if rec.get("app") else None
    if root is None:
        return None, "APP_GONE"
    for it in rec["items"]:
        if it["ref"] == ref:
            n = resolve(it["path"], root)
            if n is None:
                return None, "STALE_REF"
            return n, None
    return None, "REF_NOT_FOUND"
