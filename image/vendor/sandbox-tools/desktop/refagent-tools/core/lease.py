"""共享桌面的租约：同一个窗口同一时刻只有一个 agent 能"用指针"。

语义动作（doAction）不碰指针，可以并发；凡是会移动指针/抢焦点的动作必须先拿租约。
租约是文件锁（flock），进程退出自动释放，不需要心跳。
"""
import fcntl
import os

LOCK_DIR = os.environ.get("RTS_LOCK_DIR", "/tmp/rts-locks")


def _path(window_key):
    os.makedirs(LOCK_DIR, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in str(window_key))
    return os.path.join(LOCK_DIR, f"{safe}.lock")


def acquire(window_key, blocking=True):
    """返回文件描述符（保持打开即持有）；拿不到返回 None。"""
    f = open(_path(window_key), "a+")
    flags = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
    try:
        fcntl.flock(f.fileno(), flags)
        f.seek(0)
        f.truncate()
        f.write(str(os.getpid()))
        f.flush()
        return f
    except BlockingIOError:
        f.close()
        return None
    except OSError:
        f.close()
        return None


def release(handle):
    if not handle:
        return
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.seek(0)
        handle.truncate()
        handle.close()
    except OSError:
        pass


def holder(window_key):
    p = _path(window_key)
    if not os.path.exists(p):
        return None
    try:
        return open(p).read().strip() or None
    except OSError:
        return None
