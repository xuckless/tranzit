#!/usr/bin/env bash
# Tranzit local demo — one script for the whole stack and the app.
#
#   ./demo.sh up [--stats]        start Postgres, the Go services, OTP and rt-feed
#   ./demo.sh app [android|ios]   build (first time) and launch the app in demo mode
#   ./demo.sh drive [android|ios] play a GPS track into the emulator/simulator
#   ./demo.sh status              what is running, and where the live data comes from
#   ./demo.sh logs [service]      follow logs
#   ./demo.sh record [minutes]    record the live GTFS-RT feeds for the offline fallback
#   ./demo.sh rebuild-graph       rebuild the OpenTripPlanner graph (new GTFS)
#   ./demo.sh down                stop everything (data is kept)
#   ./demo.sh reset               stop and delete the demo database (the OTP graph is kept)
#
# Optional settings go in demo/.env (see demo/.env.example).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEMO="$ROOT/demo"
APP="$ROOT/apps/mobile"
STATS_PID="$DEMO/.stats.pid"
DEMO_USER_ID="${DEMO_USER_ID:-00000000-0000-4000-8000-000000000001}"
export DEMO_USER_ID

c_bold=$'\e[1m'; c_dim=$'\e[2m'; c_grn=$'\e[32m'; c_red=$'\e[31m'; c_yel=$'\e[33m'; c_off=$'\e[0m'
say()  { printf '%s==>%s %s\n' "$c_bold" "$c_off" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yel" "$c_off" "$*"; }
die()  { printf '%serror:%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

compose() { docker compose -f "$DEMO/compose.yml" --project-directory "$DEMO" "$@"; }
need()    { command -v "$1" >/dev/null 2>&1 || die "$1 is required ($2)"; }

psql_user() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U tranzit -d tranzit_user "$@"; }
psql_gtfs() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U tranzit -d tranzit -tA "$@"; }

wait_http() { # url label timeout_s
  local url=$1 label=$2 t=${3:-120} i=0
  until curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; do
    i=$((i + 3)); [ "$i" -ge "$t" ] && { warn "$label not answering at $url yet (check: ./demo.sh logs)"; return 1; }
    sleep 3
  done
  ok "$label  ${c_dim}$url${c_off}"
}

cmd_up() {
  local stats=0
  for a in "$@"; do [ "$a" = "--stats" ] && stats=1; done
  need docker "https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  mkdir -p "$DEMO/recordings"

  say "Building and starting the stack (first run builds 6 images and the OTP graph)"
  compose up -d --build

  say "Waiting for Postgres"
  until compose exec -T postgres pg_isready -U tranzit -d tranzit_user >/dev/null 2>&1; do sleep 2; done
  ok "Postgres  ${c_dim}localhost:${PG_PORT:-5433}${c_off}"

  say "Seeding the demo user (refreshes this week's planner events)"
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U tranzit -d tranzit_user \
    -v demo_user="$DEMO_USER_ID" -f /schema/seed.sql >/dev/null
  ok "demo user $DEMO_USER_ID"

  say "Waiting for rt-service to load stops and routes"
  local i=0
  until [ "$(psql_gtfs -c "select count(*) from calgary_transit_stops" 2>/dev/null || echo 0)" -gt 0 ] 2>/dev/null; do
    i=$((i + 5)); [ "$i" -ge 300 ] && die "rt-service never loaded stops — ./demo.sh logs rt-service"
    sleep 5
  done
  ok "stops loaded"
  if [ "$(psql_gtfs -c "select count(*) from gtfs_trips" 2>/dev/null || echo 0)" -eq 0 ] 2>/dev/null; then
    say "Loading the static GTFS schedule (one time, a few minutes)"
    compose run --rm --no-deps rt-service ./tranzit-rt-service --load-gtfs-only
  fi
  ok "GTFS schedule loaded"

  say "Waiting for the services"
  wait_http http://localhost:8080/health "db-middleware" 120 || true
  wait_http http://localhost:3100/ "route-service" 120 || true
  wait_http http://localhost:8090/health "route-save" 120 || true
  wait_http http://localhost:8780/health "rt-feed" 60 || true
  if ! docker run --rm -v tranzit-demo_otp-data:/d alpine test -f /d/graph.obj 2>/dev/null; then
    warn "OTP is building its graph (first run, ~10 min). Follow it with: ./demo.sh logs otp"
  fi
  wait_http http://localhost:8888/otp/ "OpenTripPlanner" 900 || true

  if [ "$stats" = 1 ]; then start_stats; fi
  echo
  say "Stack is up. Next: ${c_bold}./demo.sh app android${c_off} (or ios)"
  cmd_status_feeds
}

start_stats() {
  need npm "Node.js 20+"
  say "Starting the ops dashboard"
  (cd "$ROOT/apps/stats" && [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null)
  (cd "$ROOT/apps/stats" && TRANZIT_DEMO=1 nohup npm run dev >"$DEMO/stats.log" 2>&1 & echo $! >"$STATS_PID")
  wait_http http://localhost:3000/ "stats dashboard" 120 || true
}

stop_stats() {
  if [ -f "$STATS_PID" ]; then
    kill "$(cat "$STATS_PID")" 2>/dev/null || true
    pkill -f "apps/stats/node_modules/.bin/nuxt" 2>/dev/null || true
    rm -f "$STATS_PID"
  fi
}

cmd_status_feeds() {
  local s
  s=$(curl -fsS --max-time 3 http://localhost:8780/status 2>/dev/null) || { warn "rt-feed not reachable"; return; }
  printf '  live data: %s\n' "$(echo "$s" | tr -d '\n' | sed -E 's/.*"vehicles":\{[^}]*"source":"([a-z]*)".*/vehicles=\1/')"
}

cmd_status() {
  compose ps --format 'table {{.Name}}\t{{.State}}\t{{.Ports}}'
  cmd_status_feeds
}

cmd_down() {
  stop_stats
  say "Stopping the demo stack (volumes kept)"
  compose down
}

cmd_reset() {
  stop_stats
  say "Stopping and deleting the demo database (OTP graph kept)"
  compose down
  docker volume rm tranzit-demo_pgdata 2>/dev/null || true
  ok "reset — run ./demo.sh up"
}

cmd_record() {
  local minutes=${1:-30}
  say "Recording the live feeds for $minutes min into demo/recordings (every 30 s)"
  RECORD=1 compose up -d --no-deps rt-feed
  sleep $((minutes * 60))
  compose up -d --no-deps rt-feed
  ok "$(find "$DEMO/recordings" -name '*.pb.gz' | wc -l | tr -d ' ') snapshots saved"
}

cmd_rebuild_graph() {
  say "Rebuilding the OTP graph"
  REBUILD_GRAPH=1 compose up -d --no-deps --force-recreate otp
  warn "follow progress with ./demo.sh logs otp; it serves again when the build finishes"
}

app_env() {
  export EXPO_PUBLIC_DEMO_MODE=true
  export EXPO_PUBLIC_ROUTE_SERVICE_URL="${EXPO_PUBLIC_ROUTE_SERVICE_URL:-http://localhost:3100}"
  export EXPO_PUBLIC_ROUTE_SAVE_URL="${EXPO_PUBLIC_ROUTE_SAVE_URL:-http://localhost:8090}"
  export EXPO_PUBLIC_MIDDLEWARE_URL="${EXPO_PUBLIC_MIDDLEWARE_URL:-http://localhost:8080}"
  [ -f "$DEMO/.env" ] && { set -a; . "$DEMO/.env"; set +a; }
  return 0
}

app_deps() {
  if [ ! -d "$APP/node_modules" ]; then
    say "Installing app dependencies"
    if command -v bun >/dev/null 2>&1; then (cd "$APP" && bun install); else (cd "$APP" && npm install); fi
  fi
}

# React Native 0.81's Gradle runs on JDK 17–21, not newer. If JAVA_HOME isn't
# set and the default java is outside that range, look for a 17/21 JDK.
pick_jdk() {
  [ -n "${JAVA_HOME:-}" ] && return 0
  local major
  major=$(java -version 2>&1 | sed -nE '1s/.*version "([0-9]+).*/\1/p')
  if [ -n "$major" ] && [ "$major" -ge 17 ] && [ "$major" -le 21 ]; then return 0; fi
  local c
  for c in "$HOME"/.sdkman/candidates/java/21* "$HOME"/.sdkman/candidates/java/17* \
           /usr/lib/jvm/java-21* /usr/lib/jvm/java-17* \
           /Library/Java/JavaVirtualMachines/*{21,17}*/Contents/Home \
           "$HOME"/android-studio/jbr /opt/android-studio/jbr \
           "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [ -x "$c/bin/java" ]; then export JAVA_HOME="$c"; ok "using JDK $c"; return 0; fi
  done
  warn "Java ${major:-?} found; the Android build needs JDK 17 or 21 — set JAVA_HOME if it fails"
}

cmd_app() {
  local platform=${1:-android}
  app_env; app_deps
  curl -fsS -o /dev/null --max-time 3 http://localhost:8080/health || warn "the stack isn't up — run ./demo.sh up first"
  case "$platform" in
    android)
      need adb "Android SDK platform-tools"
      pick_jdk
      if ! adb get-state >/dev/null 2>&1; then
        local avd
        avd=$(emulator -list-avds 2>/dev/null | head -1 || true)
        [ -n "$avd" ] || die "no Android device or emulator. Create one in Android Studio (Device Manager)."
        say "Booting emulator $avd"
        nohup emulator -avd "$avd" -no-audio >/dev/null 2>&1 &
        adb wait-for-device
        until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done
      fi
      # The app talks to localhost; forward the service ports into the device.
      for p in 8080 3100 8090 8081; do adb reverse tcp:$p tcp:$p >/dev/null; done
      adb emu geo fix -114.0719 51.0447 >/dev/null 2>&1 || true   # downtown Calgary
      ok "ports forwarded, location set to downtown Calgary"
      say "Building and launching (first build takes several minutes)"
      cd "$APP" && exec npx expo run:android
      ;;
    ios)
      [ "$(uname)" = Darwin ] || die "the iOS Simulator needs macOS"
      need xcrun "Xcode"
      xcrun simctl location booted set 51.0447,-114.0719 >/dev/null 2>&1 || true
      say "Building and launching (first build takes several minutes)"
      cd "$APP" && exec npx expo run:ios
      ;;
    *) die "usage: ./demo.sh app [android|ios]" ;;
  esac
}

cmd_drive() {
  local platform=${1:-android} track=${2:-$DEMO/gps/kensington-to-downtown.csv} speed=${SPEED:-1}
  [ -f "$track" ] || die "no track at $track"
  say "Playing $(basename "$track") into the $platform device (Ctrl+C to stop; SPEED=4 for 4x)"
  local prev=""
  while IFS=, read -r t lat lng; do
    [[ "$t" =~ ^[0-9.]+$ ]] || continue
    if [ -n "$prev" ]; then sleep "$(awk -v a="$t" -v b="$prev" -v s="$speed" 'BEGIN{d=(a-b)/s; if(d<0)d=0; print d}')"; fi
    prev=$t
    case "$platform" in
      android) adb emu geo fix "$lng" "$lat" >/dev/null ;;
      ios)     xcrun simctl location booted set "$lat,$lng" >/dev/null ;;
      *) die "usage: ./demo.sh drive [android|ios] [track.csv]" ;;
    esac
    printf '\r  %s%6ss%s  %s, %s   ' "$c_dim" "$t" "$c_off" "$lat" "$lng"
  done <"$track"
  echo; ok "track finished"
}

cmd=${1:-help}; shift || true
case "$cmd" in
  up) cmd_up "$@" ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  app) cmd_app "$@" ;;
  drive) cmd_drive "$@" ;;
  status) cmd_status ;;
  logs) compose logs -f --tail 100 "$@" ;;
  record) cmd_record "$@" ;;
  rebuild-graph) cmd_rebuild_graph ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
