"""无障碍树：遍历、ref 命名、语义动作。

设计要点：
- ref 只在本进程内有效（`s<snapshot>:<seq>`），跨进程用 `--ref` 时必须同一 snapshot。
- 动作永远"语义优先"：控件自己声明 Action 就 doAction，不产生鼠标事件。
"""
import time

import pyatspi

MAX_NODES = 4000


def desktop():
    return pyatspi.Registry.getDesktop(0)


def apps():
    return [{"name": a.name, "pid": _pid(a)} for a in desktop()]


def _pid(node):
    try:
        return node.getApplication().queryApplication().id if False else None
    except Exception:
        return None


def find_app(name_part=""):
    name_part = (name_part or "").lower()
    for a in desktop():
        if not name_part or name_part in (a.name or "").lower():
            return a
    return None


def walk(root, interactive_only=False, max_nodes=MAX_NODES):
    """返回 (nodes, truncated)。nodes 是 (ref_seq, node, depth, path)；
    path 是从 root 到该节点的子下标链，一次遍历算好，避免逐节点回溯（O(n^2) D-Bus）。"""
    out, stack, seen = [], [(root, 0, [])], 0
    while stack:
        node, depth, path = stack.pop()
        if seen >= max_nodes:
            return out, True
        seen += 1
        if (not interactive_only) or (has_action(node) and mapped(node)):
            out.append((len(out), node, depth, path))
        try:
            kids = list(node)
        except Exception:
            kids = []
        for i in range(len(kids) - 1, -1, -1):
            stack.append((kids[i], depth + 1, path + [i]))
    return out, False


def role(node):
    try:
        return node.getRoleName()
    except Exception:
        return "?"


def name(node):
    try:
        return node.name or ""
    except Exception:
        return ""


def has_action(node):
    try:
        return node.queryAction().nActions > 0
    except Exception:
        return False


def actions(node):
    try:
        a = node.queryAction()
        return [a.getName(i) for i in range(a.nActions)]
    except Exception:
        return []


def mapped(node):
    """控件是否真的有屏幕位置。GTK 里未映射/被裁掉的状态栏会返回 INT32_MIN。"""
    b = extents(node)
    if not b:
        return False
    if b["x"] <= -100000 or b["y"] <= -100000:
        return False
    return b["w"] >= 1 and b["h"] >= 1


def extents(node):
    try:
        e = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        return {"x": e.x, "y": e.y, "w": e.width, "h": e.height}
    except Exception:
        return None


def do_action(node, require_mapped=True):
    """语义动作；返回 (ok, 用时ms)。

    require_mapped=True 时，控件必须在屏幕上有真实位置——否则 doAction 会
    返回 True 却没有任何副作用（GTK 未映射控件），这是最危险的"假成功"。
    """
    t0 = time.perf_counter()
    if require_mapped and not mapped(node):
        return False, (time.perf_counter() - t0) * 1000
    try:
        a = node.queryAction()
        if a.nActions and a.doAction(0):
            return True, (time.perf_counter() - t0) * 1000
    except Exception:
        pass
    return False, (time.perf_counter() - t0) * 1000


def set_text(node, text):
    try:
        node.queryEditableText().setTextContents(str(text))
        return True
    except Exception:
        return False


def tree(root, interactive_only=True, max_nodes=MAX_NODES):
    nodes, trunc = walk(root, interactive_only, max_nodes)
    items = []
    for seq, n, depth in nodes:
        items.append({
            "ref": f"s{seq}",
            "role": role(n),
            "name": name(n)[:80],
            "depth": depth,
            "actions": actions(n)[:4],
            "bounds": extents(n),
        })
    return items, trunc
