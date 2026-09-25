#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { fileURLToPath } from "node:url";

export const MINIMUM_GLIBC = Object.freeze({ major: 2, minor: 35 });

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function assertNativeRuntimeSupported({
  platform = process.platform,
  glibcVersion = process.report?.getReport().header.glibcVersionRuntime,
} = {}) {
  if (platform !== "linux" || glibcVersion == null) return;
  const parsed = parseVersion(glibcVersion);
  if (!parsed) {
    throw new Error(
      `Could not read the host glibc version (${glibcVersion}). Omnesis requires glibc 2.35 or newer on glibc-based Linux outside Docker.`,
    );
  }
  if (
    parsed.major < MINIMUM_GLIBC.major ||
    (parsed.major === MINIMUM_GLIBC.major && parsed.minor < MINIMUM_GLIBC.minor)
  ) {
    throw new Error(
      `glibc ${glibcVersion} is too old. Omnesis requires glibc 2.35 or newer on glibc-based Linux outside Docker; use Docker or upgrade the host OS.`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assertNativeRuntimeSupported();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
