# Linux 界面操控工具包（gui-kit）

让 agent 在 **Linux 桌面**上真正操作应用（点按钮、填表、拖放、截图校验）。核心主张：
**先走 a11y（无障碍树）语义操作，坐标只做兜底**——这是实测下来唯一稳定的路。

## 为什么要 a11y 优先（实测数字）

```
同一动作：
  a11y doAction(0)     0.2 / 0.5 / 3.8 ms
  xdotool 坐标点击     116 / 114 / 115 ms
Pinta 一屏：493 个节点，284 个带 Action，57 个按钮
```

差 30–500 倍。而且坐标点击要求窗口位置、缩放、主题完全一致；语义调用不关心这些。

## 组成

| 路径 | 作用 |
|---|---|
| `refagent-tools/core/a11y.py` | pyatspi 封装：`mapped()` 节点映射、`do_action()`、按角色/名字找控件 |
| `refagent-tools/core/verify.py` | 硬校验：`check_png_white()` 等，用来判断“操作到底成没成”，而不是靠模型说 |
| `refagent-tools/core/human.py` | 拟人化输入（移动曲线、停顿），降低被判定成脚本的概率 |
| `refagent-tools/core/lease.py` | 连接/会话租约，避免多个 agent 抢同一个显示 |
| `refagent-tools/core/refs.py` | `ref-xxx` 句柄：把“第 3 个按钮”变成可复核的引用 |
| `refagent-tools/core/input.py` | 坐标兜底输入（xdotool / XTest） |
| `refagent-tools/tools/observe.py` | 观察：返回精简节点列表（含 count/returned/truncated，控制上下文） |
| `refagent-tools/tools/act.py` | 动作：优先 pointerd，其次 xdotool |
| `refagent-tools/tools/check.py` | 校验工具 |
| `refagent-tools/tools/envctl.py` | 环境控制：拉起显示/窗口/应用 |
| `refagent-host/pyatspi-driver/` | 在**宿主**上跑 pyatspi 的驱动层（benchmark 6/6 的那套：Pinta 画图/填色） |
| `bin/dispatch.py` | 后台任务调度 + 全程录屏 + `status`/`stop` |
| `bin/pointerd.py` | 常驻拟人指针服务（避免每步起进程 150–300ms） |
| `bin/video_check.py` | 成片客观闸门：流/时长/分辨率/音量/10 帧唯一性/`motion_score` |
| `docs/A11Y-FIRST-PRINCIPLES.md` | 为什么这么设计 + 实测数据 |

## 环境要求（Ubuntu 22.04 / Debian 12）

```bash
sudo apt install -y python3-pyatspi at-spi2-core xdotool imagemagick ffmpeg xvfb openbox
pip install --user websocket-client
```

**两个坑：**

1. **不要给应用注入 `DBUS_SESSION_BUS_ADDRESS`**
   GTK 应用会直接崩（`RegisterEvent with invalid signature 'sass'` 之类）。a11y 总线靠
   `AT_SPI_BUS_ADDRESS` + `XDG_RUNTIME_DIR` 走，自己起一个干净环境。

2. **`at-spi2-core` 版本太老会导致 a11y 树残缺**（2.44 在老 jammy 上只有部分应用可见）。
   Qt 应用（Krita / Pencil2D / Shotcut）在多数发行版**没有** `qt-at-spi`，等于没有 a11y 树，
   只能退坐标 + 视觉校验——这点别浪费时间找“通用解法”。

## 最小可用例子

```bash
# 1) 起一个显示
Xvfb :2 -screen 0 1920x1080x24 -ac &
export DISPLAY=:2
export XDG_RUNTIME_DIR=/tmp/xdg-a11y
export AT_SPI_BUS_ADDRESS=unix:path=/tmp/xdg-a11y/at-spi/bus
mkdir -p "$XDG_RUNTIME_DIR"
openbox &

# 2) 看一眼有哪些应用在 a11y 总线上
python3 -c "import pyatspi; print([a.name for a in pyatspi.Registry.getDesktop(0)])"

# 3) 找按钮并点（语义，不依赖坐标）
python3 - <<'PY'
import pyatspi
app = next(a for a in pyatspi.Registry.getDesktop(0) if "Pinta" in (a.name or ""))
def walk(n, out):
    out.append(n)
    for i in range(n.childCount):
        walk(n.getChildAtIndex(i), out)
nodes = []
walk(app, nodes)
btn = next(n for n in nodes if n.getRoleName() == "push button" and "Fill" in (n.name or ""))
btn.doAction(0)
PY
```

## 硬校验（这是这套东西真正的价值）

模型说“我点了”不算数。用**独立信号**判断：

- 产物：文件存在、大小合理、`mtime` 在本次操作窗口内（mtime 容差要收紧到 10s 级，否则会把旧文件当新产物）
- 画面：截图非空白（`YAVG`）、关键区域像素颜色变化
- 视频：`video_check.py` 的 `motion_score ≥ 0.01`（低于这个值就是“幻灯片”，不是动效）

## 安全边界

桌面工具能点到任何窗口。默认在 **Xvfb/容器**里跑，不碰用户本人桌面；
需要真人扫码/授权时，把可操作的 VNC/noVNC 地址给用户，而不是接管他的会话。
