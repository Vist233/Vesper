#!/usr/bin/python3
"""act —— 动：对 ref 或坐标执行一个动作。语义优先，坐标兜底。

  act.py --snapshot s123 --ref s12 click
  act.py --snapshot s123 --ref s7  type --text 1280
  act.py --snapshot s123 --ref s9  set  --text 720
  act.py --snapshot s123 --ref s3  drag --to-xy 620,650
  act.py --snapshot s123 --ref s5  key  --combo ctrl+a
  act.py --xy 400,320 click              # 画布类自绘控件
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import a11y, env, envelope, human, input as xin, lease, refs  # noqa: E402


def _target(a):
    if a.xy:
        x, y = [int(v) for v in a.xy.split(",")]
        return None, (x, y)
    node, err = refs.node_for(a.snapshot, a.ref)
    if err:
        raise envelope.ToolError(err, f"{a.ref} 在 {a.snapshot} 里不可用")
    return node, None


def _center(node):
    b = a11y.extents(node)
    if not b or b["w"] <= 1 or b["h"] <= 1 or b["x"] < -100000:
        raise envelope.ToolError("NO_BOUNDS",
                                 "控件没有有效屏幕矩形（可能是未展开的菜单项）")
    return b["x"] + b["w"] // 2, b["y"] + b["h"] // 2


def _pointer(op, *args):
    """优先走常驻 pointerd（省掉每次进程启动），服务不在就本地执行。"""
    try:
        import json as _j
        import os as _o
        import urllib.request as _u
        port = _o.environ.get("POINTERD_PORT", "8795")
        if op == "click":
            req = {"op": "click", "x": float(args[0]), "y": float(args[1])}
        else:
            req = {"op": "drag", "x1": float(args[0]), "y1": float(args[1]),
                   "x2": float(args[2]), "y2": float(args[3])}
        r = _u.Request(f"http://127.0.0.1:{port}/do", data=_j.dumps(req).encode(),
                       headers={"Content-Type": "application/json"}, method="POST")
        with _u.urlopen(r, timeout=120) as x:
            d = _j.loads(x.read())
        if d.get("ok"):
            if op == "click":
                return True, {"landed": d.get("landed"), "ms": d.get("ms"), "via": "pointerd"}
            return True, {"via": "pointerd", "ms": d.get("ms")}
    except Exception:
        pass
    if op == "click":
        return human.human_click(args[0], args[1])
    return human.human_drag(*args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["click", "type", "set", "drag", "key", "focus"])
    ap.add_argument("--snapshot", default="")
    ap.add_argument("--ref", default="")
    ap.add_argument("--xy", default="")
    ap.add_argument("--to-xy", default="")
    ap.add_argument("--text", default="")
    ap.add_argument("--combo", default="")
    ap.add_argument("--lease-key", default="", help="共享桌面时的窗口租约键")
    ap.add_argument("--no-lease", action="store_true")
    ap.add_argument("--no-human", dest="human", action="store_false",
                    help="关闭拟人轨迹（默认开启：贝塞尔+抖动+过冲，落点仍精确）")
    ap.set_defaults(human=True)
    ap.add_argument("--display")
    a = ap.parse_args()

    env.apply(env.resolve(a.display))
    node, point = _target(a)

    # 语义能做的先做语义；不碰指针，不需要租约
    tries = []
    if a.action == "click" and node is not None:
        ok, ms = a11y.do_action(node)
        tries.append({"via": "semantic", "ok": ok, "ms": round(ms, 2)})
        if ok:
            return {"via": "semantic", "ms": round(ms, 2), "tries": tries}
    if a.action in ("type", "set") and node is not None:
        if a.action == "set" and a11y.set_text(node, a.text):
            return {"via": "semantic-setText", "text": a.text}
        ok, out = xin.type_text(a.text)
        return {"via": "xtest-type", "ok": ok, "out": out[:120]}

    # 需要指针的动作：拿租约
    h = None
    if not a.no_lease:
        h = lease.acquire(a.lease_key or (a.snapshot or a.xy or "default"))
    try:
        if a.action == "click":
            if point is None:
                point = _center(node)
            if a.human:
                ok, info = _pointer("click", point[0], point[1])
                tries.append({"via": "pointer-human", "ok": ok, "point": list(point)})
                return {"via": "pointer-human", "point": list(point), "ok": ok,
                        "landed": list(info.get("landed") or []), "tries": tries}
            ok, out = xin.click_at(*point)
            tries.append({"via": "pointer", "ok": ok, "point": list(point)})
            return {"via": "pointer", "point": list(point), "ok": ok,
                    "out": out[:120], "tries": tries}
        if a.action == "drag":
            if point is None:
                point = _center(node)
            tx, ty = [int(v) for v in a.to_xy.split(",")]
            ok, out = (_pointer("drag", point[0], point[1], tx, ty) if a.human
                       else xin.drag(point[0], point[1], tx, ty))
            return {"via": "pointer-drag", "from": list(point), "to": [tx, ty],
                    "ok": ok, "out": out[:120]}
        if a.action == "key":
            ok, out = xin.key(a.combo)
            return {"via": "xtest-key", "combo": a.combo, "ok": ok, "out": out[:120]}
        if a.action == "focus":
            if node is None:
                raise envelope.ToolError("REF_REQUIRED", "focus 需要 ref")
            node.queryComponent().grabFocus()
            return {"via": "a11y-focus"}
        raise envelope.ToolError("BAD_ACTION", a.action)
    finally:
        lease.release(h)


if __name__ == "__main__":
    sys.exit(envelope.run(main))
