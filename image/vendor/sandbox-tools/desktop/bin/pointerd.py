#!/usr/bin/python3
"""pointerd —— 常驻拟人指针服务。

为什么要常驻：每次 act 都起一个 Python 进程（import + 加载）要 150–300 ms，
而一次点击本身只有几百毫秒，开销比例太高。这里把"拟人轨迹 + 执行"放进常驻进程，
调用方只发一行 JSON。

接口（HTTP，127.0.0.1:8795）：
  POST /do  {"op":"move","x":100,"y":200}
            {"op":"click","x":100,"y":200,"button":1}
            {"op":"drag","x1":..,"y1":..,"x2":..,"y2":..}
            {"op":"pos"}
            {"op":"params","jitter":2.0,"bend":0.25,"overshoot":0.5}
  GET  /health

启动：setsid python3 bin/pointerd.py >> /tmp/pointerd.log 2>&1 &
调用：bin/pointer <op> ...（见 bin/pointer）
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, "/mnt/d/Basic/agent-bench/refagent-tools")
from core import human, input as xin  # noqa: E402

LOCK = threading.Lock()
OVERRIDES = {}


def do(req):
    op = req.get("op")
    t0 = time.perf_counter()
    with LOCK:
        if op == "pos":
            return {"ok": True, "pos": list(xin.pointer()),
                    "ms": round((time.perf_counter() - t0) * 1000, 1)}
        if op == "params":
            for k in ("jitter", "bend", "overshoot", "step_min", "step_max"):
                if k in req:
                    human.__dict__[{"jitter": "JITTER_PX", "bend": "CURVE_BEND",
                                    "overshoot": "OVERSHOOT", "step_min": "STEP_MS_MIN",
                                    "step_max": "STEP_MS_MAX"}[k]] = req[k]
            return {"ok": True, "ms": 0.1}
        if op == "move":
            landed = human.move_to(float(req["x"]), float(req["y"]))
            return {"ok": True, "landed": list(landed),
                    "ms": round((time.perf_counter() - t0) * 1000, 1)}
        if op == "click":
            ok, info = human.human_click(float(req["x"]), float(req["y"]),
                                         int(req.get("button", 1)))
            return {"ok": ok, "landed": list(info.get("landed") or []),
                    "target": [req["x"], req["y"]],
                    "ms": round((time.perf_counter() - t0) * 1000, 1)}
        if op == "drag":
            ok, info = human.human_drag(float(req["x1"]), float(req["y1"]),
                                        float(req["x2"]), float(req["y2"]))
            return {"ok": ok, "from": [req["x1"], req["y1"]], "to": [req["x2"], req["y2"]],
                    "ms": round((time.perf_counter() - t0) * 1000, 1)}
        return {"ok": False, "error": f"unknown op {op}"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send({"ok": True, "pid": os.getpid(), "uptime": round(time.time() - START, 1)})
        self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send({"ok": False, "error": str(e)}, 400)
        try:
            self._send(do(req))
        except Exception as e:
            self._send({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)


START = time.time()

if __name__ == "__main__":
    port = int(os.environ.get("POINTERD_PORT", "8795"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"pointerd listening 127.0.0.1:{port} pid={os.getpid()}", flush=True)
    srv.serve_forever()
