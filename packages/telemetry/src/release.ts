// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, statSync } from "node:fs";

/** An unavailable or stale release catalog must not claim to name the latest stable release. */
export function readLatestStable(path: string, now = Date.now()): string {
  try {
    if (now - statSync(path).mtimeMs > 48 * 60 * 60_000) return "";
    const value = readFileSync(path, "utf8").trim();
    return /^\d+\.\d+\.\d+$/.test(value) ? value : "";
  } catch {
    return "";
  }
}
