#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Shared environment for building/running the Omnesis Android app from the CLI
# (no Android Studio on the critical path). Source it before any gradle/adb/emulator
# command:  source android/scripts/android-env.sh
#
# It locates a JDK 17 and the Android SDK, then puts their tools on PATH.

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" ]; then
    # Homebrew keg-only OpenJDK 17 (not symlinked into /Library/Java).
    export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  elif /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
  fi
fi

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:/opt/homebrew/bin:$PATH"
