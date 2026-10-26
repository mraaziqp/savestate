#!/bin/sh
# SaveState on a QNAP NAS (Entware): keeps the Google Drive library mounted,
# the SaveState server running and, once switched on, the Cloudflare tunnel.
#
#   savestate.sh start | stop | restart | status
#   touch $BASE/tunnel.on     serve savestate.co.za from here (rm to stop)
#   touch $BASE/tunnel.auto   serve it from here only while the PC is down:
#                             the PC (PC_URL, default http://192.168.31.217:3000)
#                             failing ~2 minutes running hands the site to the
#                             NAS; the PC answering again for ~1 minute hands
#                             it back. Same tunnel and routes as the PC, one
#                             connector at a time.
#
# Started at boot by /opt/etc/init.d/S99savestate (Entware runs those).
BASE=/share/CACHEDEV1_DATA/SaveState
LOG=$BASE/logs
PIDS=$BASE/run
export PATH=/opt/bin:/opt/sbin:/usr/bin:/bin:/usr/sbin:/sbin
mkdir -p "$LOG" "$PIDS"

trim() { # keep logs from filling the disk
  for f in "$LOG"/*.log; do
    [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 20000000 ] && tail -n 2000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
}

mount_library() {
  if grep -q " $BASE/library " /proc/mounts && ls "$BASE/library" >/dev/null 2>&1; then return 0; fi
  fusermount3 -uz "$BASE/library" 2>/dev/null
  mkdir -p "$BASE/library" "$BASE/cache/rclone"
  rclone mount gdrive:NexusArchive "$BASE/library" --config "$BASE/rclone/rclone.conf" --read-only \
    --vfs-cache-mode full --cache-dir "$BASE/cache/rclone" --vfs-cache-max-size 150G --vfs-cache-max-age 720h \
    --dir-cache-time 24h --poll-interval 1m --vfs-fast-fingerprint \
    --vfs-read-chunk-size 8M --vfs-read-chunk-size-limit 256M --vfs-read-ahead 32M --buffer-size 8M --use-mmap \
    --log-file "$LOG/rclone.log" --log-level NOTICE --daemon </dev/null >/dev/null 2>&1
}

supervise() {
  echo $$ > "$PIDS/supervisor.pid"
  PC_URL="${PC_URL:-http://192.168.31.217:3000}"
  pc_bad=0; pc_ok=0; failover=0
  while :; do
    mount_library
    # The server: restarted if it stops.
    if ! kill -0 "$(cat "$PIDS/server.pid" 2>/dev/null)" 2>/dev/null; then
      (cd "$BASE/app" && exec node --max-old-space-size=192 dist/server.mjs >> "$LOG/server.log" 2>&1 </dev/null) &
      echo $! > "$PIDS/server.pid"
      echo "$(date '+%F %T') server started (pid $!)" >> "$LOG/supervisor.log"
    fi
    # The tunnel: while tunnel.on exists, or (tunnel.auto) while the PC is down.
    TPID=$(cat "$PIDS/tunnel.pid" 2>/dev/null)
    if [ -f "$BASE/tunnel.auto" ] && [ ! -f "$BASE/tunnel.on" ]; then
      if curl -s -m 5 -o /dev/null -f "$PC_URL/api/health"; then pc_ok=$((pc_ok + 1)); pc_bad=0; else pc_bad=$((pc_bad + 1)); pc_ok=0; fi
      if [ "$failover" = 0 ] && [ "$pc_bad" -ge 6 ]; then
        failover=1; echo "$(date '+%F %T') PC not answering: the NAS serves the site" >> "$LOG/supervisor.log"
      elif [ "$failover" = 1 ] && [ "$pc_ok" -ge 3 ]; then
        failover=0; echo "$(date '+%F %T') PC is back: handing the site back" >> "$LOG/supervisor.log"
      fi
    else
      failover=0
    fi
    echo "$failover" > "$PIDS/failover"
    if [ -f "$BASE/tunnel.on" ] || [ "$failover" = 1 ]; then
      if ! kill -0 "$TPID" 2>/dev/null; then
        "$BASE/bin/cloudflared" tunnel --config "$BASE/cloudflared/config.yml" run >> "$LOG/tunnel.log" 2>&1 </dev/null &
        echo $! > "$PIDS/tunnel.pid"
        echo "$(date '+%F %T') tunnel started (pid $!)" >> "$LOG/supervisor.log"
      fi
    elif kill -0 "$TPID" 2>/dev/null; then
      kill "$TPID"; echo "$(date '+%F %T') tunnel stopped" >> "$LOG/supervisor.log"
    fi
    trim
    sleep 20
  done
}

case "$1" in
  start)
    if kill -0 "$(cat "$PIDS/supervisor.pid" 2>/dev/null)" 2>/dev/null; then echo "already running"; exit 0; fi
    ("$0" supervise </dev/null >/dev/null 2>&1 &)
    echo "started" ;;
  supervise) supervise ;;
  stop)
    for f in supervisor tunnel server; do kill "$(cat "$PIDS/$f.pid" 2>/dev/null)" 2>/dev/null; rm -f "$PIDS/$f.pid"; done
    echo "stopped (the library stays mounted)" ;;
  restart) "$0" stop; sleep 3; "$0" start ;;
  status)
    for f in supervisor server tunnel; do
      if kill -0 "$(cat "$PIDS/$f.pid" 2>/dev/null)" 2>/dev/null; then echo "$f: running"; else echo "$f: not running"; fi
    done
    grep -q " $BASE/library " /proc/mounts && echo "library: mounted" || echo "library: not mounted"
    if [ -f "$BASE/tunnel.on" ]; then echo "tunnel: switched on"
    elif [ -f "$BASE/tunnel.auto" ]; then
      [ "$(cat "$PIDS/failover" 2>/dev/null)" = 1 ] && echo "tunnel: automatic (serving now: the PC is down)" || echo "tunnel: automatic (standing by: the PC serves)"
    else echo "tunnel: switched off"; fi ;;
  *) echo "usage: $0 start|stop|restart|status" ;;
esac
