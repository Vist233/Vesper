"""产物校验：只回答"这个文件是不是真的做对了"。

每种产物一个函数，返回 {content: ok|fail, why, metrics}。
判分是硬信号，模型说"我做完了"不作数。
"""
import os
import re
import zipfile


def _png_stats(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    cnt = {"blue": 0, "red": 0, "green": 0}
    acc = {"blue": [0, 0], "red": [0, 0], "green": [0, 0]}
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if b > 150 and r < 100 and g < 100:
                cnt["blue"] += 1; acc["blue"][0] += x; acc["blue"][1] += y
            elif r > 150 and g < 100 and b < 100:
                cnt["red"] += 1; acc["red"][0] += x; acc["red"][1] += y
            elif g > 120 and r < 100 and b < 100:
                cnt["green"] += 1; acc["green"][0] += x; acc["green"][1] += y
    out = {"size": [w, h]}
    step = 2
    for k, n in cnt.items():
        out[k] = {"n": n * (step * step),
                  "cx": round(acc[k][0] / n, 1) if n else None,
                  "cy": round(acc[k][1] / n, 1) if n else None}
    return out


def check_png(path, simplified=False, min_blue=20000):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return {"content": "fail", "why": "文件不存在或 0 字节", "metrics": {}}
    s = _png_stats(path)
    ok = s["blue"]["n"] >= min_blue and s["blue"]["cx"] is not None and s["blue"]["cy"] is not None
    if not simplified:
        ok = ok and s["red"]["n"] == 0 and s["green"]["n"] == 0
    return {"content": "ok" if ok else "fail",
            "why": f"蓝 {s['blue']['n']} px @({s['blue']['cx']},{s['blue']['cy']})"
                   f" 红 {s['red']['n']} 绿 {s['green']['n']}",
            "metrics": s}


def _inflate_all(path):
    import zlib
    raw = open(path, "rb").read()
    blobs = [raw]
    for m in re.finditer(rb"stream\r?\n", raw):
        start = m.end()
        end = raw.find(b"endstream", start)
        if end < 0:
            continue
        try:
            blobs.append(zlib.decompress(raw[start:end]))
        except Exception:
            continue
    return blobs


def check_pdf(path, want_pages=2):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return {"content": "fail", "why": "文件不存在或 0 字节", "metrics": {}}
    blobs = _inflate_all(path)
    pages = sum(len(re.findall(rb"/Type\s*/Page(?![s])", b)) for b in blobs)
    if not pages:
        for b in blobs:
            m = re.search(rb"/Type\s*/Pages[^>]{0,200}?/Count\s+(\d+)", b, re.S)
            if m:
                pages = int(m.group(1))
                break
    red = any(re.search(rb"1\.?0*\s+0\.?0*\s+0\.?0*\s+(RG|rg)", b) for b in blobs)
    ok = pages >= want_pages and red
    size = os.path.getsize(path)
    return {"content": "ok" if ok else "fail",
            "why": f"{pages} 页 / {size} 字节 / 红线={'有' if red else '无'}",
            "metrics": {"pages": pages, "bytes": size}}


def _zip(path):
    with zipfile.ZipFile(path) as z:
        return z.namelist()


def check_kra(path, min_layers=2):
    """Krita .kra：<doc>/layers/<name>，排除 .defaultpixel/.icc/.pixelselection"""
    layers = set()
    for n in _zip(path):
        m = re.search(r"/layers/([^/]+)$", n)
        if not m:
            continue
        nm = m.group(1)
        if nm.endswith((".defaultpixel", ".icc", ".pixelselection")):
            continue
        layers.add(nm)
    return {"content": "ok" if len(layers) >= min_layers else "fail",
            "why": f"{len(layers)} 个图层 {sorted(layers)[:4]}",
            "metrics": {"layers": sorted(layers)}}


def check_pclx(path, min_layers=3):
    """Pencil2D .pclx 是扁平 zip：data/<layer>.<frame>.vec|png"""
    layers = set()
    for n in _zip(path):
        m = re.match(r"^data/(\d{3})\.\d{3}\.(vec|png)$", n)
        if m:
            layers.add(m.group(1))
    return {"content": "ok" if len(layers) >= min_layers else "fail",
            "why": f"{len(layers)} 个层/帧键 {sorted(layers)}",
            "metrics": {"layers": sorted(layers)}}


def check_png_white(path, expect_size=None):
    """基准图：整幅白底 + 指定尺寸。用于"CLI 生成底图"这类步骤的验证。"""
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    nonwhite = 0
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            if px[x, y] != (255, 255, 255):
                nonwhite += 1
    ok = nonwhite == 0 and (not expect_size or list(expect_size) == [w, h])
    return {"content": "ok" if ok else "fail",
            "why": f"{w}x{h} 非白像素采样 {nonwhite}",
            "metrics": {"size": [w, h], "nonwhite_samples": nonwhite}}


KINDS = {
    ".png": lambda p, **kw: check_png(p, **kw),
    ".pdf": lambda p, **kw: check_pdf(p),
    ".kra": lambda p, **kw: check_kra(p),
    ".pclx": lambda p, **kw: check_pclx(p),
}


def check(path, kind=None, **kw):
    ext = (kind or os.path.splitext(path)[1]).lower()
    if ext not in KINDS:
        return {"content": "unknown", "why": f"没有 {ext} 的判分规则", "metrics": {}}
    return KINDS[ext](path, **kw)
