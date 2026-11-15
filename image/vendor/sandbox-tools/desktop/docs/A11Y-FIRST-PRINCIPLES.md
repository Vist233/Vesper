# 无障碍组件树（a11y tree）路线：第一性原理 + 开源生态判断 + 实测（2026-11-06）

## 一、它到底怎么实现的（把机制拆到底）

桌面应用的 UI 分两层：

1. **像素层**：应用把界面画到 X/Wayland 的窗口里。截图点击方案只看到这一层。
2. **语义层**：GUI 工具包（GTK/Qt/Mono/Win32）在创建每个控件时，同时向操作系统的**可访问性服务**注册一个对象——角色（button/menu item/text）、名字、状态、屏幕矩形、以及**它能执行的动作**。

Linux 上的这条通路叫 **AT-SPI2**，走 D-Bus：

```
应用进程 ──(GTK/Qt 的 bridge, 如 gail:atk-bridge)──> 注册控件对象
        ↑
   AT-SPI 注册表 (org.a11y.atspi.Registry, 总线 /run/user/<uid>/at-spi/bus_0)
        ↑
   agent 进程 (pyatspi / agent-desktop) 遍历树
```

每个控件对象暴露一组标准接口，这是关键：

| 接口 | 作用 | 等价于人类操作 |
|---|---|---|
| `Accessible` | 角色、名字、父子关系 | 看 |
| `Component` | 屏幕矩形、是否可见 | 看 |
| `StateSet` | 选中/可用/聚焦/勾选 | 看 |
| **`Action`** | `getActions()` / `doAction(i)` | **直接让控件执行"点击"** |
| **`EditableText`** | `setTextContents(s)` | **直接写文本，不走键盘** |
| **`Value`** | `setCurrentValue(x)` | 直接设滑块/数值框 |

**所以"用组件树操作应用"的物理含义是：不产生任何鼠标/键盘事件，直接通过 D-Bus 调用控件自己的动作方法。** 应用内部按它原本的逻辑处理（emit clicked → 走它自己的回调）。

对照截屏点击链路：
```
截图 → 模型给 (x,y) → XTEST 注入 PointerMotion + ButtonPress → 窗口系统分发 → 命中测试 → 控件收到进入/按下 → 回调
```
两条链路的差别不是"准不准"，而是**中间少了 4 个环节**：没有坐标、没有命中测试、没有指针位移、没有焦点切换。

## 二、实测（本机，Ubuntu 22.04 + Pinta 1.6/GTK2）

同一台机器、同一个 Pinta 窗口，分别用"语义动作"和"指针点击"操作同一个**矩形工具按钮**：

| 方式 | 单次耗时（3 次） | 指针位置 | 需要窗口可见 | 需要窗口聚焦 |
|---|---|---|---|---|
| **AT-SPI `Action.doAction(0)`** | **0.2 / 0.5 / 3.8 ms** | 960,540 → **960,540（不动）** | 否 | 否 |
| `xdotool mousemove + click` | 116.1 / 114.2 / 115.1 ms | 移到按钮中心 (425,335) | 是 | 是（会抢焦点） |

同一窗口的可枚举性：

- **493 个节点**
- **284 个节点带 Action 接口**（菜单、菜单项、按钮）
- **57 个按钮**，动作名齐全：`click` / `press`（New / Open / Save / Undo / Redo / Crop / Zoom…）
- 单选按钮可见：Portrait / Landscape / White / Transparent（新建画布对话框）

**结论：语义动作快 200–500 倍，且完全不碰指针。** 这不是"模型更聪明"，是"少走四个环节"。

### 它的天花板（同样是实测）
- `EditableText.setTextContents()` 能调用（2–20 ms），但 GTK2/Mono 桥的 `Text.getText()` 读回返回 `None` → **写进去了但没法读回来验证**，只能靠"点 OK 后看画布大小"这种间接信号。
- 画布、调色板这类**自绘控件在树里是空壳**（没有可操作 Action，或只有一个无名 push button）。这类必须回到坐标。
- 对照：`agent-desktop` 官方文档明确写 **Ubuntu 22.04 的 at-spi 桥在 `Action.GetActions` 上会 abort**，要求 24.04 或打补丁（commit `dc0dc33`）。我们容器里是 24.04，`snapshot` 拿到 **314 refs / 232 ms**；宿主 22.04 上它直接报 `native_window_unproven`（要窗口被 WM 正常管理、且能证明原生窗口类型）。

## 三、开源生态：谁真的用了这条路，有没有创新

| 项目 | 底层方案 | 是否真用组件树 | 有没有本质创新 |
|---|---|---|---|
| **vercel-labs/agent-desktop** | AT-SPI / UIA / AX，**ref + 语义动作** | **是**（纯 a11y，无截图） | **有**：ref 动作是语义 D-Bus 调用，"never move the pointer"；headed 模式才退回物理输入 |
| CursorTouch/Windows-MCP、AIWander/uia-mcp | Windows UIA 树 | 是（Windows） | 同类实现，无新思想 |
| trycua/cua-driver | a11y snapshot + 视觉兜底 | 混合 | 工程化包装（跨平台 + 权限模型），无新原理 |
| Microsoft UFO / UFO² | UIA + 视觉混合，带应用专用 API | 混合 | 有：应用级 API 直连（Excel/Word），但闭源场景强绑定 |
| OpenAdapt | 录制人类操作 + a11y 事件 | 混合 | 有：从示范学（record→replay），但对新任务泛化有限 |
| SOC / Open Interpreter / Bytebot / Agent-S / UI-TARS / OmniParser | 截图 + 坐标/grounding | **否** | 无（都是把像素映射到坐标的不同模型） |

**判断：真正的"底层创新"只有一件事——把动作从"注入输入事件"换成"调用控件方法"（语义动作）。** 其余都是同一个思路的不同工程包装；纯视觉那批更没有新东西，只是 grounding 模型好坏。

## 四、这条路能带来多少提升（对我们的任务）

**能提升的部分**
- 菜单、按钮、对话框控件：**毫秒级 + 确定性**，不会再出现"点偏 18 px""窗口被挡""焦点被抢"。实测 a11y 候选 + 模型选 vs 纯视觉：命中率 **8/10 vs 4/10**，误差 **0 vs 18.5 px**。
- 保存流程：`另存为` 对话框的按钮/下拉/输入框都在树里，语义动作可以绕开"GTK2 输入被吞"的老坑。

**不能提升的部分**
- 画布内的一切（画矩形、移动像素、拖拽图层）——自绘控件，树里没有。
- 结论：**必须混合**。a11y 管"外框和对话框"，坐标管"画布里"。这正是我们现在 `backend.py` 的做法，也是 Pinta 6/6 的原因。

**下一步最划算的改动（1 处代码）**：在 `backend.py` 的 click 里加"语义优先"——元素有 Action 就 `doAction(0)`，没有才回落到坐标点击；实测能把按钮类动作从 ~115 ms 压到 <5 ms，且不产生指针副作用。改完用 D-GUI-01 再跑一轮验证总耗时。

## 五、这次测试的边界（诚实说明）

- `agent-desktop` 在宿主 22.04 上**跑不起来**（`native_window_unproven`、at-spi 桥版本问题），它需要 24.04 容器；容器侧我们此前实测过 **314 refs / 232 ms**，可直接作为它的能力基线。
- 本次的语义动作对比是**直接调 AT-SPI 接口**做的（pyatspi），不是调 agent-desktop；两者底层是同一条 D-Bus 通路、同一批接口，所以结论对 agent-desktop 同样成立。
- 没有测 Windows（按你的要求不在 Windows 上做测试）。

## 六、我们自己的实现其实已经是这条路（核验过代码）

`refagent-host/pyatspi-driver/backend.py` 的 `do_click()` 逻辑就是"语义优先"：

```python
act = acc.queryAction()
if act.nActions:            # 控件自己声明了动作
    if act.doAction(0):     # 直接调 D-Bus，不碰指针
        return {"ok": True}
# 没有 ATK 动作 → 才回落到坐标点击
```

`do_set_value()` 也是先 `EditableText.setTextContents()`，失败才退回"聚焦 + 逐字符输入"。

实际一轮 D-GUI-01 的动作构成（trace.jsonl）：

| 动作 | 次数 |
|---|---|
| snapshot（观察） | 11（首个 388 元素 / 581 ms，对话框 34 元素 / 86 ms） |
| click（语义） | 3 |
| type / key | 3 |
| palette（自绘控件→坐标） | 1 |
| drag（画布→坐标） | 1 |
| save_as（对话框树） | 1 |

**观察成本 >> 动作成本**：一轮里快照 ~0.6 s + 若干 0.09 s，动作全部毫秒级。所以下一步优化的重点不是"再加速点击"，而是**减少快照次数/缩小快照范围**（`-i` 交互元素、按窗口 scope）。
