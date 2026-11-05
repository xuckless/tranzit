#!/usr/bin/env bash
# Serve the pre-built Calgary OTP2 graph on :8080 (loads graph.obj + router-config.json).
set -euo pipefail
cd "$(dirname "$0")"

OTP_VERSION="${OTP_VERSION:-2.6.0}"
OTP_JAR="otp-${OTP_VERSION}-shaded.jar"

if [ ! -f graph.obj ]; then
  echo "graph.obj missing — run ./build.sh first." >&2
  exit 1
fi

exec java -Xmx4G -jar "$OTP_JAR" --load .
