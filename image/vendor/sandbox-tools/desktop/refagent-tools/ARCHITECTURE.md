# refagent-tools：把桌面 Agent 拆成可独立调试的 tool（2026-11-06）

## 0. 一句话

一个桌面 Agent = **看（observe）+ 动（act）+ 验（check）+ 环境（envctl）** 四个独立命令，
每个命令只做一件事、只输出一种 JSON、可以单独跑、单独测、单独换实现。
编排（模型循环）在外面，不在这些 tool 里。

```
            ┌──────────── run.py / 你的编排器 ────────────┐
            │  模型：选 ref、给动作、看结果、决定下一步      │
            └───┬───────────┬───────────┬────────────────┘
                │           │           │
          observe.py    act.py      check.py          ← 三个纯 tool，CLI + JSON
                │           │           │
        ┌───────┴───────────┴───────────┴────────┐
        │ core/: env · a11y · input · refs · lease │
        └───────┬──────────────────────────────────┘
                │
        ┌───────┴──────────────────────────────────┐
        │ 桌面：Xvfb + session bus + AT-SPI + openbox │
        └──────────────────────────────────────────┘
```

## 1. 为什么这样拆（设计原则）

| 原则 | 具体做法 | 得到什么 |
|---|---|---|
| 单一职责 | observe 只读不写；act 只写不判；check 只判不改 | 出错时立刻知道归哪层 |
| 统一契约 | 每个 tool 输出 `{ok, data, error, ms}` | 编排器只写一套解析 |
| 无共享状态 | 跨进程不传对象，传 **snapshot 文件 + ref** | 可以分机/分进程/并行 |
| 语义优先 | act 先 `doAction`，不行才注入指针 | 毫秒级、不抢焦点 |
| 硬校验 | check 只看产物内容，不看模型自述 | 不会被"我保存好了"骗 |
| 可回放 | 每次调用都落到 trace（谁、什么 ref、耗时） | 一条命令复现一帧 |

## 2. 四个 tool 的契约

### observe.py — 看
```bash
observe.py --app Pinta [--all] [--limit 20] [--display :2]
```
```json
{"ok":true,"data":{"snapshot":"s1793980887950","app":"PintaHost","count":284,
 "items":[{"ref":"s0","role":"menu","name":"File","actions":["click"],
           "bounds":{"x":413,"y":167,"w":38,"h":23}}]},"ms":583}
```
- `count=284` = 可交互节点数（全树 493）
- snapshot 写 `/tmp/rts-refs/<sid>.json`，里面存**从应用根到控件的子下标路径**
- 实测：**583 ms / 284 条**（优化前 4912 ms，因为逐节点回溯是 O(n²) D-Bus 调用）

### act.py — 动
```bash
act.py --snapshot s123 --ref s228 click
act.py --snapshot s123 --ref s7  type --text 1280
act.py --xy 400,320 click                # 画布/自绘控件
act.py --snapshot s123 --ref s3 drag --to-xy 620,650
```
```json
{"ok":true,"data":{"via":"semantic","ms":0.41,
 "tries":[{"via":"semantic","ok":true,"ms":0.41}]}}
```
- 语义动作 **0.41 ms**、指针不动；只有失败才回落到指针（`via:"pointer"`）
- `tries` 记录尝试过哪几层、每层耗时 —— 调试时一眼看到"为什么用了坐标"

### check.py — 验
```bash
check.py out/01.png [--simplified]      # PNG：蓝块像素数 + 质心
check.py out/04.pdf                     # PDF：页数 + 红色描边（zlib 解压后找）
check.py out/08.kra                     # Krita：图层数
check.py out/06.pclx                    # Pencil2D：层/帧键
```
实测：
- `01.png` → `蓝 201804 px @(400,320)`（和参考解一致）
- `04.pdf` → `2 页 / 21179 字节 / 红线=有`

### envctl.py — 环境
```bash
envctl.py up --display :7      # Xvfb + dbus + openbox（独立 XDG 目录）
envctl.py windows
envctl.py launch --cmdline "mono /tmp/refhost/pintahost/PintaHost.exe"
envctl.py shot --out /tmp/a.png
envctl.py down --display :7
```

## 3. 一次任务的完整数据流

```
envctl up            → 得到一个隔离桌面（DISPLAY/dbus/XDG 三件套）
envctl launch Pinta  → 应用起来
observe  → sid + 284 refs
模型：看 items，选 ref、决定动作
act      → 执行（语义优先），返回 via/ms
observe  → 再看一次（验证 UI 变了没）
...
check    → 产物内容对不对（硬信号）
```

每一步都是一次独立进程调用，**可以单独重放**：把 act 那条命令拿去再跑一次，就能复现那一帧。

## 4. 运行环境：Docker + 多桌面 + 多 Agent

### 4.1 形态
```
Docker 容器（同一个系统、同一套依赖）
 ├─ 桌面 A：Xvfb :1 + dbus-A + at-spi-A + openbox-A
 ├─ 桌面 B：Xvfb :2 + dbus-B + at-spi-B + openbox-B
 └─ 桌面 C：Xvfb :3 + ...
```
每个桌面的三个环境变量（`DISPLAY` / `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR`）
完全独立，所以 **同一容器里可以并存 N 个桌面**，互不可见。这就是"Agent 各开各的桌面、
共享同一个系统"的实现方式——隔离的只是显示与总线，文件系统/依赖/模型端点都是同一份。

### 4.2 两个 Agent 访问同一个桌面（本次要支持的场景）
共享时冲突只有三类，对应三种对策：

| 冲突 | 现象 | 对策（已实现） |
|---|---|---|
| ref 串号 | A 的 `s228` 在 B 眼里是别的控件 | ref 与 snapshot 绑定，snapshot 文件带 app 名 + 路径，跨进程可校验（`STALE_REF`） |
| 指针打架 | 两个 agent 同时 mousemove，动作落到错误的控件 | **窗口租约**：`core/lease.py` 用 flock，指针类动作必须先拿租约，进程退出自动释放 |
| 焦点互抢 | 一个 agent 打字打到另一个的窗口 | 语义动作不抢焦点；必须打字时先 `focus` 该 ref，且同样在租约内 |

关键点：**语义动作天然可并发**（不改指针、不改焦点），只有"坐标类"动作需要串行。
所以共享桌面的最优用法是：**外框/对话框各走语义动作，画布类动作排队拿租约**。

### 4.3 容器内怎么跑
```bash
docker run -d --name desk1 ubuntu:24.04 sleep infinity
docker exec desk1 bash -lc 'apt-get install -y xvfb openbox at-spi2-core libgail-common python3-pyatspi'
docker exec desk1 /work/tools/envctl.py up --display :1
docker exec desk1 /work/tools/observe.py --app Pinta     # Agent A
docker exec desk1 /work/tools/observe.py --app Pinta     # Agent B（同一桌面）
```

## 5. 和旧代码的对应关系（迁移路径）

| 旧 | 新 | 变化 |
|---|---|---|
| `refagent-host/pyatspi-driver/backend.py`（739 行，含窗口/截图/a11y/输入/拖拽/保存全塞一起） | `core/a11y.py` + `core/input.py` + `core/env.py` | 按"读/写/环境"切开，每个 100–150 行 |
| `pinta_profile.py`（应用专有逻辑） | 待抽成 `profiles/pinta.py`（只放菜单名、调色板规则、保存流程） | 应用知识不进 core |
| `run_case.py`（编排 + 判分 + 报告混在一起） | `run.py`（只编排） + `check.py`（只判分） | 判分可单独跑 |
| `check_artifact.py`（case 名硬编码） | `core/verify.py`（按扩展名分派） | 新格式只需加一个函数 |

**已实测的收益**：observe 单次 583 ms（优化前 4912 ms，8.4×）；
语义点击 0.41 ms（指针点击 115 ms）；`check` 可以脱离跑测单独验证任何历史产物。

## 6. 还没做的（下一步，按价值排）

1. `run.py`：把现有 orchestrator 接上来（模型循环 + trace），只依赖上面四个 tool。
2. `profiles/pinta.py`：把应用知识（菜单结构、调色板坐标、保存流程）从 core 里彻底赶出去。
3. `trace.py`：每次 tool 调用落一行 JSONL（sid/ref/via/ms），一条命令能重放整轮。
4. 共享桌面的**并发压测**：两个 agent 同时跑 Pinta 两个任务，验证租约是否真的防住指针打架。
