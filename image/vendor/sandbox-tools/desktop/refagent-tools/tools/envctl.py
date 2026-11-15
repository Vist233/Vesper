#!/usr/bin/python3
"""envctl —— 环境：起/停一个隔离桌面、列窗口、截图、启动应用。

一个桌面 = Xvfb + session bus + at-spi + openbox，全部用独立目录，
所以同一台机器上可以并存多个桌面，互不干扰（这也是共享/隔离的边界）。

  envctl.py up --display :7
  envctl.py windows
  envctl.py launch --cmd "mono /tmp/refhost/pintahost/PintaHost.exe"
  envctl.py shot --out /tmp/a.png
  envctl.py down --display :7
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import env, envelope  # noqa: E402


def _sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def up(disp):
    n = disp.lstrip(":")
    xdg = f"/tmp/rts-xdg-{n}"
    addr = f"/tmp/rts-dbus-{n}.addr"
    os.makedirs(xdg, exist_ok=True)
    os.chmod(xdg, 0o700)
    # 探测 TCP 的 127.0.0.1:n 在没有服务时会挂 130s+（WSL 下 connect 超时很长），
    # 用本地 unix socket + 3 秒超时，才够快。
    alive = (_sh(f"timeout 3 xdpyinfo -display :{n} >/dev/null 2>&1").returncode == 0
             or os.path.exists(f"/tmp/.X11-unix/X{n}"))
    if not alive:
        _sh(f"setsid Xvfb {disp} -screen 0 1920x1080x24 -listen tcp -ac -nolisten unix "
            f">/tmp/rts-xvfb-{n}.log 2>&1 &")
        time.sleep(1.5)
    if not os.path.exists(addr):
        # dbus-daemon 会继承调用者的 DISPLAY/XDG，而 at-spi 的总线地址由 launcher 按
        # "XDG_RUNTIME_DIR + 当前 DISPLAY" 生成 —— 不隔离这两项，新桌面会拿到旧桌面的
        # at-spi 总线（a11y 树指向别人），所以必须显式喂进去。
        _sh(f"env -u AT_SPI_BUS_ADDRESS DISPLAY=127.0.0.1:{n} XDG_RUNTIME_DIR={xdg} "
            f"dbus-daemon --session --fork --print-address=1 "
            f"--address=unix:abstract=/tmp/rts-{n} > {addr} 2>/dev/null")
        time.sleep(0.5)
    bus = open(addr).read().strip() if os.path.exists(addr) else None
    e = {"display": f"127.0.0.1:{n}", "xdg": xdg, "dbus": bus}
    env.apply(e)
    _sh(f"setsid openbox >/tmp/rts-ob-{n}.log 2>&1 &")
    time.sleep(1.2)
    return {"env": env.describe(e), "addr_file": addr}


def windows():
    if not shutil.which("wmctrl"):
        raise envelope.ToolError("WMCTRL_MISSING", "没装 wmctrl，无法列窗口")
    p = _sh("wmctrl -l")
    rows = []
    for line in (p.stdout or "").splitlines():
        parts = line.split(None, 3)
        if len(parts) >= 3:
            rows.append({"id": parts[0], "title": parts[3] if len(parts) > 3 else ""})
    return {"count": len(rows), "windows": rows}


def launch(cmd, wait_s=20):
    _sh(f"setsid {cmd} >/tmp/rts-app.log 2>&1 &")
    for _ in range(int(wait_s)):
        time.sleep(1)
        w = windows()
        if w["count"]:
            return {"launched": True, "windows": w["windows"]}
    return {"launched": False, "log": open("/tmp/rts-app.log").read()[-300:]
            if os.path.exists("/tmp/rts-app.log") else ""}


def shot(out):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    p = _sh(f"import -window root {out} 2>/dev/null || ffmpeg -loglevel error -y "
            f"-f x11grab -video_size 1920x1080 -i $DISPLAY -frames:v 1 {out}")
    ok = os.path.exists(out) and os.path.getsize(out) > 0
    return {"ok": ok, "path": out, "bytes": os.path.getsize(out) if ok else 0,
            "err": (p.stderr or "")[:160]}


def down(disp):
    n = disp.lstrip(":")
    _sh(f"pkill -f 'Xvfb {disp} '")
    _sh(f"pkill -f 'rts-{n}'")
    return {"stopped": disp}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["up", "down", "windows", "launch", "shot", "show"])
    ap.add_argument("--display", default="")
    ap.add_argument("--cmdline", default="")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    if a.cmd in ("up", "down"):
        disp = a.display or ":2"
        if a.cmd == "down":
            return down(disp)
        e = up(disp)
        return e

    env.apply(env.resolve(a.display))
    if a.cmd == "windows":
        return windows()
    if a.cmd == "launch":
        if not a.cmdline:
            raise envelope.ToolError("NO_CMD", "launch 需要 --cmdline")
        return launch(a.cmdline)
    if a.cmd == "shot":
        if not a.out:
            raise envelope.ToolError("NO_OUT", "shot 需要 --out")
        return shot(a.out)
    return env.describe(env.resolve(a.display))


if __name__ == "__main__":
    sys.exit(envelope.run(main))
