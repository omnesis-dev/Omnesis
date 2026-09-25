// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserId, BrowserEngine, BrowserInfo } from "./types.js";

const HOME = process.env.HOME ?? "~";

interface BrowserDef {
  id: BrowserId;
  name: string;
  engine: BrowserEngine;
  /** Relative to ~/Library/Application Support/ on macOS */
  darwinSubdir: string;
  /** Relative to ~/.config/ on Linux (null = macOS-only) */
  linuxSubdir: string | null;
}

const BROWSER_DEFS: BrowserDef[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    engine: "chromium",
    darwinSubdir: "Google/Chrome",
    linuxSubdir: "google-chrome",
  },
  { id: "arc", name: "Arc", engine: "chromium", darwinSubdir: "Arc/User Data", linuxSubdir: null },
  {
    id: "brave",
    name: "Brave",
    engine: "chromium",
    darwinSubdir: "BraveSoftware/Brave-Browser",
    linuxSubdir: "BraveSoftware/Brave-Browser",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    engine: "chromium",
    darwinSubdir: "Microsoft Edge",
    linuxSubdir: "microsoft-edge",
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    engine: "chromium",
    darwinSubdir: "Vivaldi",
    linuxSubdir: "vivaldi",
  },
  { id: "safari", name: "Safari", engine: "safari", darwinSubdir: "../Safari", linuxSubdir: null },
  // TODO: Add Firefox browser definition when Firefox support is implemented (#158)
];

function getBaseDir(def: BrowserDef): string | null {
  if (process.platform === "darwin") {
    if (def.id === "safari") {
      return join(HOME, "Library", "Safari");
    }
    return join(HOME, "Library", "Application Support", def.darwinSubdir);
  }
  if (process.platform === "linux" && def.linuxSubdir) {
    return join(HOME, ".config", def.linuxSubdir);
  }
  return null;
}

function isBrowserInstalled(def: BrowserDef): boolean {
  const baseDir = getBaseDir(def);
  if (!baseDir) return false;

  if (def.engine === "safari") {
    return existsSync(join(baseDir, "History.db"));
  }
  // Chromium — check for at least one profile with a History file
  return (
    existsSync(join(baseDir, "Default", "History")) || existsSync(join(baseDir, "Local State"))
  );
}

/** Detect all installed browsers on this machine */
export function detectInstalledBrowsers(): BrowserInfo[] {
  return BROWSER_DEFS.filter(isBrowserInstalled).map((def) => ({
    id: def.id,
    name: def.name,
    baseDir: getBaseDir(def)!,
    engine: def.engine,
  }));
}

/** Get info for a specific browser by ID. Returns null if not installed. */
export function getBrowserInfo(id: string): BrowserInfo | null {
  const def = BROWSER_DEFS.find((d) => d.id === id);
  if (!def) return null;
  const baseDir = getBaseDir(def);
  if (!baseDir || !isBrowserInstalled(def)) return null;
  return { id: def.id, name: def.name, baseDir, engine: def.engine };
}

/** URL prefixes for internal browser pages that should be filtered out */
export const INTERNAL_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "chrome-search://",
  "brave://",
  "edge://",
  "vivaldi://",
  "arc://",
  "about:",
  "devtools://",
  "chrome-devtools://",
  "data:",
  "blob:",
  "javascript:",
];
