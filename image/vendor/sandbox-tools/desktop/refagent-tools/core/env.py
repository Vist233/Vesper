"""环境：唯一知道"现在在哪个桌面"的地方。

一个 tool 需要的东西只有三样：DISPLAY、session bus、XDG_RUNTIME_DIR。
全部从环境变量读，命令行参数可覆盖，绝不写死。
"""
import os
import re
import subprocess

DEFAULT_DISPLAY = "127.0.0.1:2"
DEFAULT_XDG = "/tmp/xdg-refhost"
DEFAULT_DBUS_FILE = "/tmp/dbus_refhost.addr"


def resolve(display=None, xdg=None, dbus_file=None):
    disp = display or os.environ.get("RTS_DISPLAY") or os.environ.get("DISPLAY") or DEFAULT_DISPLAY
    if not disp.startswith(("127.0.0.1", ":")):
        disp = DEFAULT_DISPLAY
    rt = xdg or os.environ.get("RTS_XDG") or os.environ.get("XDG_RUNTIME_DIR") or DEFAULT_XDG
    f = dbus_file or os.environ.get("RTS_DBUS_FILE") or DEFAULT_DBUS_FILE
    # 地址文件是这套私有桌面的真源：它活着就用它；死了才退回继承来的
    # DBUS_SESSION_BUS_ADDRESS（否则调用方 shell 里的旧地址会把工具悄悄带到别的桌面上）。
    bus = None
    if os.path.exists(f):
        try:
            cand = open(f).read().strip()
        except OSError:
            cand = ""
        if cand and a11y_bus_alive(cand):
            bus = cand
    if not bus:
        bus = os.environ.get("DBUS_SESSION_BUS_ADDRESS") or None
    return {"display": disp, "xdg": rt, "dbus": bus}


def apply(env):
    os.environ["DISPLAY"] = env["display"]
    os.environ["XDG_RUNTIME_DIR"] = env["xdg"]
    os.environ.pop("WAYLAND_DISPLAY", None)
    if env.get("dbus"):
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = env["dbus"]
    os.environ["NO_AT_BRIDGE"] = "0"
    os.environ["GTK_MODULES"] = "gail:atk-bridge"   # gail 必须在前
    # dbind 不会自己去问 session bus 的 org.a11y.Bus——它自己 fork
    # at-spi-bus-launcher，在本机这套私有桌面上频繁连不上，然后直接 abort
    # (SIGTRAP)。所以必须把 a11y 总线地址显式写进 AT_SPI_BUS_ADDRESS。
    addr = a11y_bus_address(env)
    if addr:
        os.environ["AT_SPI_BUS_ADDRESS"] = addr
        env["a11y"] = addr
    return env


def a11y_bus_alive(bus):
    """真去 ping 一下总线：文件存在不等于 bus 活着（launcher 崩了文件还在）。"""
    if not bus:
        return False
    try:
        r = subprocess.run(
            ["gdbus", "call", "--address", bus, "--dest", "org.freedesktop.DBus",
             "--object-path", "/org/freedesktop/DBus",
             "--method", "org.freedesktop.DBus.ListNames"],
            capture_output=True, timeout=5, text=True)
        # 只要 gdbus 拿到了回复（哪怕是错误回复）就说明总线活着
        out = (r.stdout or "") + (r.stderr or "")
        return r.returncode == 0 and ("org.freedesktop" in out or "NameHasOwner" in out
                                      or out.strip() != "")
    except Exception:
        return False


def a11y_bus_present(env):
    """判断无障碍总线在不在且活着。24.04 上 bus 缺失 + 无 DISPLAY 时，pyatspi 会
    dbind 致命化直接 SIGTRAP，连统一信封都发不出来——所以必须先检查。"""
    return a11y_bus_address(env) is not None


def _session_a11y_address(session_bus):
    """问 session bus 上的 org.a11y.Bus 要 a11y 地址；拿不到返回 None。"""
    if not session_bus:
        return None
    try:
        r = subprocess.run(
            ["gdbus", "call", "--address", session_bus, "--dest", "org.a11y.Bus",
             "--object-path", "/org/a11y/bus",
             "--method", "org.a11y.Bus.GetAddress"],
            capture_output=True, timeout=5, text=True)
        if r.returncode != 0:
            return None
        m = re.search(r"'(unix:[^']+)'", r.stdout or "")
        return m.group(1) if m else None
    except Exception:
        return None


def a11y_bus_address(env):
    """返回一个真的能连上的 a11y 总线地址；没有就 None。

    解析顺序（每一步都先 ping）：
      1) 环境里已有的 AT_SPI_BUS_ADDRESS
      2) session bus 上 org.a11y.Bus.GetAddress
      3) $XDG/at-spi/bus_0 或 $XDG/at-spi/bus 套接字
    """
    cand = os.environ.get("AT_SPI_BUS_ADDRESS")
    if cand and a11y_bus_alive(cand):
        return cand
    addr = _session_a11y_address(env.get("dbus"))
    if addr and a11y_bus_alive(addr):
        return addr
    for name in ("bus_0", "bus"):
        p = os.path.join(env.get("xdg") or "", "at-spi", name)
        if p and os.path.exists(p):
            addr = "unix:path=" + p
            if a11y_bus_alive(addr):
                return addr
    return None



def describe(env):
    return {"display": env["display"], "xdg": env["xdg"],
            "dbus": (env.get("dbus") or "")[:64] or None,
            "a11y": (env.get("a11y") or a11y_bus_address(env) or "")[:64] or None}
