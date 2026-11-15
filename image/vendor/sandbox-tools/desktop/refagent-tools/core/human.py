"""拟人鼠标：贝塞尔曲线 + 抖动 + 过冲回拉。

目的：让"坐标类"动作看起来像人手，而不是瞬移/匀速直线；
但**落点仍然是精确的**（最后一步回到目标点再点击）。

用法：
    move_to(x, y)            # 只移动
    human_click(x, y)        # 移动 + 点击
    human_drag(x1,y1,x2,y2)  # 按下 -> 曲线移动 -> 松开
"""
import math
import random
import time

from . import input as xin

# 可调参数（也支持环境变量覆盖，方便 A/B）
import os

JITTER_PX = float(os.environ.get("HUMAN_JITTER", "1.6"))        # 每步抖动幅度
STEP_MS_MIN = int(os.environ.get("HUMAN_STEP_MS_MIN", "4"))     # 单步最短耗时
STEP_MS_MAX = int(os.environ.get("HUMAN_STEP_MS_MAX", "13"))    # 单步最长耗时
CURVE_BEND = float(os.environ.get("HUMAN_CURVE_BEND", "0.22"))  # 控制点偏移比例
OVERSHOOT = float(os.environ.get("HUMAN_OVERSHOOT", "0.35"))    # 过冲概率
PAUSE_MS = int(os.environ.get("HUMAN_PAUSE_MS", "40"))          # 点击前停顿时长


def _bezier(p0, p1, p2, p3, t):
    mt = 1 - t
    return (mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
            mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1])


def _ease_in_out(t):
    # 先加速后减速，像人手起步/刹车
    return 3 * t ** 2 - 2 * t ** 3


def _rand_params():
    """每次动作随机化参数：人手不会两次一模一样。"""
    return {
        "jitter": random.uniform(0.7, 2.6) * (JITTER_PX / 1.6),
        "bend": random.uniform(0.10, 0.34),
        "overshoot": random.uniform(0.25, 0.65),
        "step_min": STEP_MS_MIN,
        "step_max": STEP_MS_MAX,
        "pause": random.randint(PAUSE_MS, PAUSE_MS * 2),
    }


def plan_path(start, end, steps=None, params=None):
    """返回要走的点列表（不含起点），末点精确等于 end。"""
    (x0, y0), (x1, y1) = start, end
    p = params or _rand_params()
    dist = math.hypot(x1 - x0, y1 - y0)
    if steps is None:
        steps = max(10, min(30, int(dist / 30) + 10))
    # 垂直方向偏移，形成弧线
    nx, ny = -(y1 - y0), (x1 - x0)
    norm = math.hypot(nx, ny) or 1
    bend = dist * p["bend"] * random.choice([-1, 1])
    c1 = (x0 + (x1 - x0) * 0.33 + nx / norm * bend, y0 + (y1 - y0) * 0.33 + ny / norm * bend)
    c2 = (x0 + (x1 - x0) * 0.66 + nx / norm * bend * 0.6, y0 + (y1 - y0) * 0.66 + ny / norm * bend * 0.6)
    pts = []
    for i in range(1, steps + 1):
        t = _ease_in_out(i / steps)
        px, py = _bezier((x0, y0), c1, c2, (x1, y1), t)
        if i < steps:
            px += random.gauss(0, p["jitter"])
            py += random.gauss(0, p["jitter"])
        pts.append((px, py))
    # 过冲：先冲过目标几像素，再回拉
    if random.random() < p["overshoot"] and dist > 60:
        over = min(8.0, dist * 0.03)
        ang = math.atan2(y1 - y0, x1 - x0)
        pts.append((x1 + math.cos(ang) * over, y1 + math.sin(ang) * over))
        pts.append((x1, y1))
    return pts


def move_to(x, y, verify_settle=True):
    sx, sy = xin.pointer()
    p = _rand_params()
    pts = plan_path((sx, sy), (float(x), float(y)), params=p)
    for px, py in pts:
        xin.sh(["xdotool", "mousemove", "--sync", str(int(round(px))), str(int(round(py)))])
        time.sleep(random.randint(p["step_min"], p["step_max"]) / 1000.0)
    if verify_settle:
        time.sleep(p["pause"] / 1000.0)
        return xin.pointer()
    return int(round(x)), int(round(y))


def human_click(x, y, button=1):
    got = move_to(x, y)
    time.sleep(random.randint(PAUSE_MS, PAUSE_MS * 2) / 1000.0)
    rc, out = xin.sh(["xdotool", "click", str(button)])
    return rc == 0, {"landed": got, "target": (x, y), "out": out[:100]}


def human_drag(x1, y1, x2, y2, hold_ms=120):
    move_to(x1, y1)
    xin.sh(["xdotool", "mousedown", "1"])
    time.sleep(hold_ms / 1000.0)
    p = _rand_params()
    pts = plan_path((float(x1), float(y1)), (float(x2), float(y2)), params=p)
    for px, py in pts:
        xin.sh(["xdotool", "mousemove", "--sync", str(int(round(px))), str(int(round(py)))])
        time.sleep(random.randint(p["step_min"], p["step_max"]) / 1000.0)
    time.sleep(random.randint(80, 160) / 1000.0)
    rc, out = xin.sh(["xdotool", "mouseup", "1"])
    return rc == 0, {"from": (x1, y1), "to": (x2, y2), "out": out[:100]}
