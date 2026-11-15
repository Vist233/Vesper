"""物理输入：只在"控件没有语义动作"时才用（画布、自绘控件）。"""
import subprocess
import time


def sh(argv, timeout=30):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def click_at(x, y, button=1):
    sh(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y))])
    time.sleep(0.05)
    rc, out = sh(["xdotool", "click", str(button)])
    return rc == 0, out


def drag(x1, y1, x2, y2, duration_ms=600, steps=14):
    sh(["xdotool", "mousemove", "--sync", str(int(x1)), str(int(y1))])
    sh(["xdotool", "mousedown", "1"])
    n = max(4, steps)
    for i in range(1, n + 1):
        sh(["xdotool", "mousemove", "--sync",
            str(int(x1 + (x2 - x1) * i / n)), str(int(y1 + (y2 - y1) * i / n))])
        time.sleep(max(0.008, duration_ms / 1000.0 / n))
    rc, out = sh(["xdotool", "mouseup", "1"])
    return rc == 0, out


def key(combo):
    rc, out = sh(["xdotool", "key", "--clearmodifiers", combo])
    return rc == 0, out


def type_text(text):
    rc, out = sh(["xdotool", "type", "--clearmodifiers", "--delay", "40", text])
    return rc == 0, out


def pointer():
    rc, out = sh(["xdotool", "getmouselocation", "--shell"])
    d = dict(line.split("=") for line in out.strip().splitlines() if "=" in line)
    return int(d.get("X", -1)), int(d.get("Y", -1))
