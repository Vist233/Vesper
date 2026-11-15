# desktop-kit —— 服务器上的桌面沙盒：看、管、录、取数

一套把「跑在服务器容器里的桌面」变成**可远程查看、可自愈、可录屏、可取结构化数据**的工具包。
不依赖 noVNC/WebSocket 也能看到实时画面（MJPEG，浏览器原生支持），需要动手操作时再切 noVNC。

```
desktop-kit/
├── bin/
│   ├── deskview        采集 + MJPEG 直播 + /state 状态接口（Python3，零第三方依赖）
│   ├── deskguard       自愈：单实例锁 / 冻结检测 / 日志轮转（Bash）
│   ├── descrec         一条命令录屏（x11grab + 可选缩时）+ 录完自检
│   ├── mediacheck.py   成片自检：时长 / 帧数 / 非空白
│   └── deskcommon.sh   共用函数（找 ffmpeg / 找 docker / 跨容器执行）
├── deploy/
│   ├── systemd/        deskview.service、deskguard.service + .timer、env 样例
│   ├── nginx/          MJPEG + noVNC 反代（含 Basic Auth、proxy_buffering off）
│   ├── deskguard.conf.example
│   └── crontab.example
├── examples/poll_state.sh   轮询 /state 的最小示例
├── selftest.sh         新机器四环节自检（Xvfb → x11vnc → 采集 → HTTP）
├── README.md  DEPLOY.md  TROUBLESHOOT.md  VERIFY.md
```

---

## 0. 30 秒环境检查

```bash
python3 -V                       # ≥3.7，只用标准库
ffmpeg -version | head -1        # 没有就 apt-get install -y ffmpeg
curl --version | head -1
# 容器模式才需要：
docker ps | head -3
```

ffmpeg 不在 PATH 也可以，用 `--ffmpeg /path/to/ffmpeg` 或 `export FFMPEG=/path/to/ffmpeg` 指定。

---

## 1. 三分钟上手 A：已经有 X 显示 / 容器

```bash
cd desktop-kit
chmod +x bin/* selftest.sh examples/*.sh

# ① 容器里的桌面（最常见：沙盒在服务器容器里）
./bin/deskview --container agent-desktop --display :98 --port 6084

#    或者：本机直接跑着 X（Xvfb / 物理机桌面）
./bin/deskview --display :0 --port 6084
```

② 浏览器打开 <http://127.0.0.1:6084/> —— 页面里就是一个 `<img>`，画面上方那条带绿点的是实时状态。

③ 验证（三个都能返回就说明通了）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6084/        # 200
curl -s http://127.0.0.1:6084/state | python3 -m json.tool | head -12 # ok: true
curl -s -o /tmp/s.jpg -w '%{size_download}\n' http://127.0.0.1:6084/snap.jpg  # >2000 字节
```

> 默认只听 `127.0.0.1`。要从别的机器访问，**不要**直接加 `--bind 0.0.0.0` 了事，
> 走 [DEPLOY.md](DEPLOY.md) 里的 SSH 隧道或 nginx 反代（带鉴权）。

---

## 2. 三分钟上手 B：空机器，先看它能不能起来

不需要容器、不需要真桌面，自检脚本会自己起一个 Xvfb：

```bash
sudo apt-get install -y xvfb x11vnc x11-utils ffmpeg curl python3
./selftest.sh --keep
```

输出（实测）：

```
[1/5] 依赖     PASS  ffmpeg=/usr/bin/ffmpeg python3=/usr/bin/python3 curl=/usr/bin/curl ...
[2/5] X 显示   PASS  新起 Xvfb :97 (1280x720)
[3/5] x11vnc     PASS  127.0.0.1:5999 返回 RFB 003.008
[4/5] 采集     PASS  帧 #38（3 秒内 +18），6.0 fps，1280x720，窗口 1 个，帧年龄 0.154s
[5/5] HTTP       PASS  / 200, /state 200, /snap.jpg 200 (13102B JPEG), /metrics 200, /healthz 200
RESULT: PASS  (PASS=5 FAIL=0)
```

然后浏览器打开 <http://127.0.0.1:6199/> 就能看到那个 Xvfb 桌面。
`--keep` 保留现场，`./selftest.sh` 默认跑完自动清理。

---

## 3. 参数

```
deskview --container NAME     容器名（省略=本机 X 显示）
         --display :98        X 显示号（默认 :98）
         --port 6084          HTTP 端口（默认 6084）
         --bind 127.0.0.1     监听地址（默认只听本机）
         --size 1920x1080     采集分辨率，auto=自动探测（默认 auto）
         --fps 6              采集帧率（默认 6）
         --scale 1440         输出宽度，0=原始，默认 1440（只缩不放）
         --quality 5          MJPEG 质量 2(最好)-31(最差)
         --state-dir DIR      latest.jpg / pid 放哪（默认 ~/.local/state/deskview）
         --novnc 6083         给出 noVNC 端口后，页面上会多一个"需要操作"的链接
         --auth user:pass     HTTP Basic 认证
         --token TOK          URL token（?token=TOK 或 X-Desk-Token 头）
         --no-self-heal       关掉内部冻结看门狗（交给 deskguard 统一重启时用）
```

**采集分辨率不要超过显示实际分辨率**，`auto` 会自己问 X（`xdpyinfo`）。`--scale` 只缩不放，
所以 1280 宽的桌面配 `--scale 1440` 不会糊。

---

## 4. 六个 HTTP 端点

| 端点 | 用途 | 说明 |
|---|---|---|
| `/` | 人看的页面 | MJPEG 内嵌，单文件 HTML，无外部依赖 |
| `/stream.mjpg` | 实时流 | `multipart/x-mixed-replace`，浏览器/ffplay/VLC 都能直接吃 |
| `/snap.jpg` | 最近一帧 | 抓图、OCR、视觉模型输入都从这里拿 |
| `/state` | 结构化状态 | 窗口列表、分辨率、帧计数、健康状态（见下） |
| `/metrics` | Prometheus 文本 | `deskview_up` / `deskview_fps` / `deskview_frame_age_seconds` … |
| `/healthz` | 健康检查 | 200=正常，503=异常（可直接给 LB / k8s probe） |

`/state` 样例（实测，节选；完整样例见 `examples/state.sample.json`）：

```json
{
  "ok": true,
  "mode": "container",
  "container": "agent-desktop",
  "display": ":98",
  "resolution": { "configured": "1920x1080", "display": "1920x1080", "frame": "1440x810" },
  "capture": { "fps_target": 6, "fps_measured": 6.0, "frames_total": 53, "last_frame_bytes": 46199 },
  "last_frame": { "seq": 53, "age_sec": 0.068,
                  "at": "2026-11-09T14:38:55+0800",
                  "snapshot": "/var/lib/deskview/latest.jpg" },
  "grabber": { "starts": 1, "restarts": 0, "last_error": "" },
  "windows": [
    { "id": "0x1000002", "title": "about:blank - Chromium",
      "class": "chromium (/data/profile) Chromium",
      "x": 0, "y": 0, "w": 1919, "h": 1079, "active": true }
  ],
  "windows_source": "_NET_CLIENT_LIST",
  "health": { "ok": true, "reasons": [] }
}
```

取数示例：

```bash
./examples/poll_state.sh http://127.0.0.1:6084           # 一行摘要
./examples/poll_state.sh http://127.0.0.1:6084 --json    # 完整 JSON
./examples/poll_state.sh http://127.0.0.1:6084 --watch 5 # 每 5 秒一行，可重定向进日志

# 只要"当前窗口标题"
curl -s http://127.0.0.1:6084/state | python3 -c 'import json,sys;[print(w["title"]) for w in json.load(sys.stdin)["windows"]]'

# 存一张当前画面给视觉模型
curl -s http://127.0.0.1:6084/snap.jpg -o /tmp/now.jpg
```

轮询建议：**页面看画面用 `/stream.mjpg`（一条长连接，别轮询）**；业务取数用 `/state`，
1–5 秒一次足够（它内部窗口列表 5 秒刷新一次）；监控用 `/metrics` 15–60 秒一次。

---

## 5. 录屏

```bash
# 录 30 秒
./bin/descrec --display :98 --out demo.mp4 --seconds 30

# 容器内的桌面
./bin/descrec --container agent-desktop --display :98 --out demo.mp4 --seconds 30

# 缩时：录 10 分钟、4 倍速
./bin/descrec --container agent-desktop --display :98 --out tl.mp4 --seconds 600 --timelapse 4

# 只自检已有文件
./bin/descrec --check demo.mp4
```

录完会自动跑自检并打印：

```
PASS 文件       demo.mp4 (1.2 MB)
PASS 视频流      h264 1440x810 10.00 fps
PASS 时长       30.00s（期望 ≥ 27.0s）
PASS 帧数       300 帧（期望 ≥ 210）
PASS 非空白      0/10 抽样帧为纯色，灰度均值 251.5~251.5，标准差 8.9~8.9
WARN 画面变化     1/10 个抽样帧互不相同（全相同=画面静止）
RESULT: PASS  demo.mp4
```

`WARN 画面变化` 不是失败：桌面本来就没动（终端/看板类画面）就会帧帧相同。

---

## 6. 自愈

```bash
cp deploy/deskguard.conf.example /etc/deskguard.conf   # 改 CONTAINER / DISPLAY / VIEW_PORT
./bin/deskguard --config /etc/deskguard.conf --status  # 一行 JSON 看现在健不健康
./bin/deskguard --config /etc/deskguard.conf --dry-run # 只报告会做什么
./bin/deskguard --config /etc/deskguard.conf           # 真正跑一轮（cron/timer 调的就是它）
```

它只做四件事：显示在不在、x11vnc 在不在、deskview HTTP 通不通、画面有没有冻住。
装成定时任务（二选一，**别同时装**）：

```bash
# A. systemd timer
sudo cp bin/deskguard /usr/local/bin/ && sudo cp deploy/systemd/deskguard.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now deskguard.timer
systemctl list-timers deskguard.timer

# B. cron
sudo cp deploy/crontab.example /etc/cron.d/deskguard && sudo chmod 644 /etc/cron.d/deskguard
```

日志自动轮转（默认 2MB × 5 份）：`/var/log/deskguard/deskguard.log`。

---

## 7. 上服务器

单机跑通之后，看 **[DEPLOY.md](DEPLOY.md)**：拓扑图、端口表、SSH 隧道 / nginx 反代 / 防火墙、
Basic Auth 与 token、带宽估算（1440px@6fps ≈ 2.3–3.4 Mbps）、systemd 安装步骤。
出问题先翻 **[TROUBLESHOOT.md](TROUBLESHOOT.md)**（无画面/冻结/端口不通/黑屏/权限，逐条判据+修法）。
本机两次实测的命令与输出在 **[VERIFY.md](VERIFY.md)**。
