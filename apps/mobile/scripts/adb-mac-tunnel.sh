#!/usr/bin/env bash
# Connect to the Android emulator running on your MacBook over the local network.
#
# Prerequisites on the Mac:
#   1. Android emulator is running (open Android Studio → Device Manager → play button)
#   2. SSH server is enabled (System Settings → Sharing → Remote Login ON)
#   3. You know your Mac's local IP (run `ipconfig getifaddr en0` on the Mac)
#
# Usage:
#   bash scripts/adb-mac-tunnel.sh <mac-user>@<mac-ip>
#   bash scripts/adb-mac-tunnel.sh xuckl@192.168.1.42
#
# What it does:
#   - Kills the local ADB server (it binds to 5037 and would conflict)
#   - Opens an SSH tunnel forwarding Mac's ADB server port (5037) to localhost:5037
#   - Runs `adb devices` so you can confirm the emulator appears
#   - Keeps the tunnel open; press Ctrl+C to close

set -euo pipefail

MAC_HOST="${1:?Usage: $0 <user@mac-ip>}"

echo "==> Stopping local ADB server (frees port 5037 for the tunnel)"
adb kill-server 2>/dev/null || true

echo "==> Opening SSH tunnel: localhost:5037 → ${MAC_HOST}:5037"
echo "    (keep this terminal open; Ctrl+C to disconnect)"
echo ""

# Background the tunnel, remember its PID so we can kill it on Ctrl+C
ssh -N -L 5037:localhost:5037 "$MAC_HOST" &
TUNNEL_PID=$!

cleanup() {
  echo ""
  echo "==> Closing tunnel and restarting local ADB server"
  kill "$TUNNEL_PID" 2>/dev/null || true
  adb kill-server 2>/dev/null || true
  adb start-server
}
trap cleanup EXIT INT TERM

# Give the tunnel a moment to establish
sleep 2

echo "==> Connected. Devices visible through Mac's ADB server:"
adb devices

echo ""
echo "    The emulator is now usable from this machine."
echo "    Run: bunx expo run:android"
echo "    or:  bun run android"
echo ""
echo "    Press Ctrl+C to disconnect the tunnel."
wait "$TUNNEL_PID"
