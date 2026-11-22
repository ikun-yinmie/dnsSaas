#!/usr/bin/env bash
# dnsSaas 控制台 —— 双击打开图形面板,也支持命令行:
#   ./控制台.sh start|stop|status|panel|log
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$DIR/config.yaml"
LOG="$DIR/dnsSaas.log"
PIDFILE="$DIR/dnsSaas.pid"
PORT=9877
TITLE="dnsSaas 控制台"

# 找 node:优先 PATH,其次常见安装位置
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -x "$HOME/.local/nodejs/bin/node" ]; then
  NODE="$HOME/.local/nodejs/bin/node"
else
  NODE=""
fi

daemon_pid() {
  # 优先 pid 文件,其次按命令行匹配
  if [ -f "$PIDFILE" ]; then
    local p
    p=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      echo "$p"; return 0
    fi
  fi
  pgrep -f "src/index\.js --config $CONFIG" 2>/dev/null | head -1
}

is_running() { [ -n "$(daemon_pid)" ]; }

human_uptime() {
  local p="$1" et
  et=$(ps -o etime= -p "$p" 2>/dev/null | tr -d ' ')
  [ -n "$et" ] && echo "$et" || echo "?"
}

fmt_state() {
  # 通过 Web API 拉取运行状态并格式化(守护进程运行时才有)
  "$NODE" -e '
    const http = require("http");
    const port = process.argv[1];
    const req = http.get("http://127.0.0.1:" + port + "/api/state", { timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const s = JSON.parse(d);
          const mins = Math.max(0, Math.floor((Date.now() - s.startedAt) / 60000));
          console.log("● 守护进程运行中   已运行 " + mins + " 分钟");
          console.log("");
          for (const p of s.providers || []) {
            const v = p.verify || {};
            const st = v.ok === true ? "正常" : v.ok === false ? "异常: " + (v.lastError || "") : "未验证";
            console.log("  服务商  " + p.name + "  [" + st + "]");
          }
          console.log("");
          for (const dm of s.domains || []) {
            const r = dm.lastCheckResult || {};
            let st;
            if (r.ok === true) st = "✓ 可用 " + (r.ms != null ? r.ms + "ms" : "");
            else if (r.ok === false) st = "✗ 失败 " + String(r.error || "").slice(0, 50);
            else st = "… 待检";
            const pv = (dm.primary.currentValues || []).join(",");
            const bv = dm.backup ? (dm.backup.currentValues || []).join(",") : "";
            console.log("  [" + dm.id + "] " + st + "   主[" + pv + "]" + (dm.backup ? "  备[" + bv + "]" : ""));
          }
          console.log("");
          const b = ((s.ips && s.ips.best) || []).map((x) => x.ip + " (" + x.ms + "ms)").join(",  ");
          console.log("  优选IP: " + (b || "暂无"));
        } catch (e) {
          console.log("状态解析失败: " + e.message);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); console.log("✗ API 响应超时"); });
    req.on("error", () => console.log("✗ API 未响应(进程可能刚启动)"));
  ' "$PORT" 2>/dev/null
}

status_text() {
  if ! is_running; then
    echo "○ 守护进程:已停止"
    echo ""
    echo "配置文件: $CONFIG"
    echo "网页面板: http://127.0.0.1:$PORT (启动后可打开)"
    return
  fi
  local p
  p=$(daemon_pid)
  echo "守护进程 PID: $p   已运行: $(human_uptime "$p")"
  echo "─────────────────────────────"
  fmt_state
  echo "─────────────────────────────"
  echo "网页面板: http://127.0.0.1:$PORT"
}

do_start() {
  if is_running; then
    echo "已在运行(PID $(daemon_pid))"
    return 0
  fi
  if [ -z "$NODE" ]; then
    echo "✗ 未找到 node,请先安装 Node.js" >&2; return 1
  fi
  if [ ! -d "$DIR/node_modules" ]; then
    echo "✗ 缺少依赖,请先执行: cd \"$DIR\" && npm install" >&2; return 1
  fi
  if [ ! -f "$CONFIG" ]; then
    echo "! 配置不存在,自动从 config.example.yaml 生成" >&2
    cp "$DIR/config.example.yaml" "$CONFIG" 2>/dev/null || { echo "✗ 生成配置失败" >&2; return 1; }
  fi
  # 注意:子壳里用 exec 让 node 顶替子壳进程,这样 $! 记录的就是 node 本体的 PID
  ( cd "$DIR" && exec nohup "$NODE" src/index.js --config "$CONFIG" >> "$LOG" 2>&1 ) &
  echo $! > "$PIDFILE"
  sleep 2
  if is_running; then
    echo "✓ 已启动(PID $(daemon_pid))   面板: http://127.0.0.1:$PORT"
    return 0
  fi
  echo "✗ 启动失败,最近日志:" >&2
  tail -5 "$LOG" >&2 2>/dev/null
  return 1
}

do_stop() {
  if ! is_running; then
    echo "未在运行"; rm -f "$PIDFILE"; return 0
  fi
  local p
  p=$(daemon_pid)
  kill -TERM "$p" 2>/dev/null
  for _ in $(seq 1 10); do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$p" 2>/dev/null; then
    kill -9 "$p" 2>/dev/null
    sleep 0.5
  fi
  # 兜底:按命令行特征清理可能的孤儿进程
  for extra in $(pgrep -f "src/index\.js --config $CONFIG" 2>/dev/null); do
    [ "$extra" != "$p" ] && kill -TERM "$extra" 2>/dev/null
  done
  rm -f "$PIDFILE"
  if kill -0 "$p" 2>/dev/null; then
    echo "✗ 停止失败(PID $p)"; return 1
  fi
  echo "✓ 已停止"
}

do_panel() { xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1 & }

do_log() {
  tail -n 400 "$LOG" 2>/dev/null > /tmp/dnsSaas.log.view
  if command -v zenity >/dev/null 2>&1; then
    zenity --text-info --title="$TITLE · 运行日志(最近400行)" \
      --filename=/tmp/dnsSaas.log.view --width 900 --height 600 2>/dev/null
  else
    tail -n 100 "$LOG"
  fi
}

# ---------- 命令行模式 ----------
cmd="${1:-}"
case "$cmd" in
  start) do_start; exit $? ;;
  stop)  do_stop;  exit $? ;;
  status) status_text; exit 0 ;;
  panel) do_panel; exit 0 ;;
  log)   do_log;   exit 0 ;;
  "" ) : ;;  # 无参数 → GUI 模式
  *) echo "用法: $0 {start|stop|status|panel|log}"; exit 1 ;;
esac

# ---------- GUI 模式(zenity)----------
if ! command -v zenity >/dev/null 2>&1; then
  echo "未安装 zenity,请用命令行模式: $0 {start|stop|status|panel|log}"
  status_text
  exit 0
fi

while true; do
  TXT="$(status_text)"
  running="$(is_running && echo yes || echo no)"
  SEL=$(zenity --list \
    --title="$TITLE" \
    --text="$TXT" \
    --column="操作" --column="说明" \
    --hide-header --height 470 --width 620 \
    "启动守护进程"  "$( [ "$running" = yes ] && echo '已在运行(重复选择无副作用)' || echo '后台启动 dnsSaas 守护进程' )" \
    "停止守护进程"  "结束 dnsSaas 守护进程" \
    "刷新状态"      "重新读取运行状态" \
    "打开网页面板"  "浏览器打开 http://127.0.0.1:$PORT" \
    "查看运行日志"  "最近 400 行日志" \
    "退出控制台"    "关闭本窗口(不影响守护进程)" \
    2>/dev/null)
  case "$SEL" in
    "启动守护进程")
      if OUT=$(do_start 2>&1); then
        zenity --info --title="$TITLE" --text="$OUT" --width 380 2>/dev/null
      else
        zenity --error --title="$TITLE" --text="$OUT" --width 460 2>/dev/null
      fi
      ;;
    "停止守护进程")
      if zenity --question --title="$TITLE" --text="确定停止 dnsSaas 守护进程吗?\n停止期间域名将不再检测与同步。" --width 380 2>/dev/null; then
        OUT=$(do_stop 2>&1)
        zenity --info --title="$TITLE" --text="$OUT" --width 320 2>/dev/null
      fi
      ;;
    "刷新状态") continue ;;
    "打开网页面板") do_panel ;;
    "查看运行日志") do_log ;;
    "退出控制台"|"") break ;;
  esac
done
