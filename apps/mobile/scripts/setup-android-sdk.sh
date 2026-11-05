#!/usr/bin/env bash
# Run this once after installing Java 21 via SDKMAN.
# Usage: bash scripts/setup-android-sdk.sh

set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
CMDLINE_TOOLS_ZIP="/tmp/cmdline-tools.zip"

echo "==> Creating SDK directories"
mkdir -p "$ANDROID_HOME/cmdline-tools"

echo "==> Downloading Android command-line tools"
curl -fL "$CMDLINE_TOOLS_URL" -o "$CMDLINE_TOOLS_ZIP"

echo "==> Extracting"
unzip -q -o "$CMDLINE_TOOLS_ZIP" -d /tmp/cmdline-tools-extract
mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
cp -r /tmp/cmdline-tools-extract/cmdline-tools/. "$ANDROID_HOME/cmdline-tools/latest/"
rm -rf /tmp/cmdline-tools-extract "$CMDLINE_TOOLS_ZIP"

export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "==> Accepting licenses"
yes | sdkmanager --licenses > /dev/null 2>&1 || true

echo "==> Installing SDK packages (compileSdk=36, buildTools=35.0.1)"
sdkmanager \
  "platform-tools" \
  "platforms;android-36" \
  "platforms;android-35" \
  "build-tools;35.0.1" \
  "build-tools;34.0.0"

echo "==> Done. SDK installed at $ANDROID_HOME"
echo ""
echo "Add to your ~/.bashrc or ~/.zshrc:"
echo ""
echo "  export ANDROID_HOME=\"\$HOME/Android/Sdk\""
echo "  export PATH=\"\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$PATH\""
echo ""
echo "For Android builds, set Java 21 (SDKMAN):"
echo "  export JAVA_HOME=\"\$HOME/.sdkman/candidates/java/current\""
