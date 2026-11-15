#!/usr/bin/env bash
# deskcommon.sh —— deskview 套件的共用函数（被 descrec / deskguard / selftest source）
# 只做三件事：找 ffmpeg/ffprobe、找能连上 daemon 的 docker、在"本机 X"或"容器内 X"执行命令。
# 不写死任何人的路径，也不用 jq。

DESK_KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESK_CACHE_DIR="${DESK_CACHE_DIR:-/tmp}"

dc_die() { echo "ERROR: $*" >&2; exit 2; }

# 找 ffmpeg：显式变量 > $FFMPEG > PATH > 常见静态包位置
dc_find_ffmpeg() {
  local c
  for c in "${DESK_FFMPEG:-}" "${FFMPEG:-}" "$(command -v ffmpeg 2>/dev/null)" \
           /usr/local/bin/ffmpeg /usr/bin/ffmpeg /opt/ffmpeg/bin/ffmpeg; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  for c in /opt/ffmpeg-*/bin/ffmpeg "$HOME"/.local/bin/ffmpeg; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

dc_find_ffprobe() {
  local ff fb
  ff="$(dc_find_ffmpeg)" || return 1
  fb="$(dirname "$ff")/ffprobe"
  if [ -x "$fb" ]; then echo "$fb"; return 0; fi
  local c
  for c in "${FFPROBE:-}" "$(command -v ffprobe 2>/dev/null)" /usr/local/bin/ffprobe /usr/bin/ffprobe; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

# 找 docker 客户端：很多 WSL 机器上 /usr/bin/docker 连不上 daemon，只有 docker.exe 能用，
# 所以必须真跑一条 ps 来验证，并把结果缓存 60 秒（每次探测要 1~2 秒）。
dc_find_docker() {
  if [ -n "${DESK_DOCKER:-}" ] && [ -x "${DESK_DOCKER}" ]; then
    echo "$DESK_DOCKER"; return 0
  fi
  local cache="$DESK_CACHE_DIR/desk-docker.path" p
  if [ -f "$cache" ] && [ $(( $(date +%s) - $(stat -c %Y "$cache" 2>/dev/null || echo 0) )) -lt 60 ]; then
    p="$(cat "$cache" 2>/dev/null)"
    [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return 0; }
  fi
  local cands=("${DOCKER:-}" "$(command -v docker 2>/dev/null)" /usr/bin/docker \
               "$(command -v docker.exe 2>/dev/null)" \
               "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe")
  local c
  for c in "${cands[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    if timeout 25 "$c" ps --format '{{.Names}}' >/dev/null 2>&1; then
      echo "$c" >"$cache" 2>/dev/null; echo "$c"; return 0
    fi
  done
  for c in /mnt/c/Users/*/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe; do
    [ -x "$c" ] || continue
    if timeout 25 "$c" ps --format '{{.Names}}' >/dev/null 2>&1; then
      echo "$c" >"$cache" 2>/dev/null; echo "$c"; return 0
    fi
  done
  return 1
}

# dc_xrun <container|""> <display> <shell cmd>
# container 为空 -> 本机跑；否则 docker exec 进容器跑（自动带 DISPLAY）
dc_xrun() {
  local c="$1" disp="$2" cmd="$3"
  if [ -z "$c" ]; then
    # 注意必须套 timeout：DISPLAY 不存在时 xdpyinfo 会卡在 TCP 连接上（本机实测 8s+ 不返回）
    timeout "${DC_TIMEOUT:-15}" /bin/sh -c "DISPLAY=$disp $cmd"
  else
    local d
    d="$(dc_find_docker)" || { echo "找不到可用 docker 客户端" >&2; return 127; }
    timeout "${DC_TIMEOUT:-40}" "$d" exec "$c" /bin/sh -c "DISPLAY=$disp $cmd"
  fi
}

# dc_display_size <container|""> <display> -> 1920x1080
dc_display_size() {
  dc_xrun "$1" "$2" "xdpyinfo 2>/dev/null | sed -n 's/.*dimensions: *\\([0-9]*x[0-9]*\\).*/\\1/p'" \
    | tr -d '\r' | head -1
}

dc_http_code() { # <url> [user:pass]
  if [ -n "${2:-}" ]; then
    curl -s -o /dev/null -m 6 -u "$2" -w '%{http_code}' "$1" 2>/dev/null
  else
    curl -s -o /dev/null -m 6 -w '%{http_code}' "$1" 2>/dev/null
  fi
}

dc_kb() { # bytes -> "412 KB"
  awk -v b="${1:-0}" 'BEGIN{ if (b>=1048576) printf "%.1f MB", b/1048576; else printf "%.0f KB", b/1024 }'
}

# 日志：带时间戳追加，超过 MAX_KB 轮转，保留 KEEP 份
dc_log() { # <file> <max_kb> <keep> <msg>
  local f="$1" max="$2" keep="$3"; shift 3
  mkdir -p "$(dirname "$f")" 2>/dev/null
  if [ -f "$f" ] && [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt $(( max * 1024 )) ]; then
    local i="$keep"
    while [ "$i" -gt 1 ]; do
      [ -f "$f.$((i-1))" ] && mv -f "$f.$((i-1))" "$f.$i"
      i=$((i-1))
    done
    mv -f "$f" "$f.1"
  fi
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$f"
}
