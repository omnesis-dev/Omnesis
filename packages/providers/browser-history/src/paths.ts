// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { BrowserId, BrowserEngine, BrowserInfo } from "./types.js";

interface BrowserPathsContext {
  platform: NodeJS.Platform;
  home: string;
  localAppData?: string;
  exists: (path: string) => boolean;
  readText?: (path: string) => string;
}

function defaultContext(): BrowserPathsContext {
  return {
    platform: process.platform,
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
  };
}

interface BrowserDef {
  id: BrowserId;
  name: string;
  engine: BrowserEngine;
  /** Relative to ~/Library/Application Support/ on macOS */
  darwinSubdir: string;
  /** Relative to ~/.config/ on Linux (null = macOS-only) */
  linuxSubdir: string | null;
  /** Relative to LocalAppData on Windows (null = not supported there). */
  windowsSubdir: string | null;
}

const BROWSER_DEFS: BrowserDef[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    engine: "chromium",
    darwinSubdir: "Google/Chrome",
    linuxSubdir: "google-chrome",
    windowsSubdir: "Google/Chrome/User Data",
  },
  {
    id: "arc",
    name: "Arc",
    engine: "chromium",
    darwinSubdir: "Arc/User Data",
    linuxSubdir: null,
    // Arc is packaged: its LocalAppData is redirected into its package cache.
    windowsSubdir: "Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data",
  },
  {
    id: "brave",
    name: "Brave",
    engine: "chromium",
    darwinSubdir: "BraveSoftware/Brave-Browser",
    linuxSubdir: "BraveSoftware/Brave-Browser",
    windowsSubdir: "BraveSoftware/Brave-Browser/User Data",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    engine: "chromium",
    darwinSubdir: "Microsoft Edge",
    linuxSubdir: "microsoft-edge",
    windowsSubdir: "Microsoft/Edge/User Data",
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    engine: "chromium",
    darwinSubdir: "Vivaldi",
    linuxSubdir: "vivaldi",
    windowsSubdir: "Vivaldi/User Data",
  },
  {
    id: "safari",
    name: "Safari",
    engine: "safari",
    darwinSubdir: "../Safari",
    linuxSubdir: null,
    windowsSubdir: null,
  },
  // TODO: Add Firefox browser definition when Firefox support is implemented (#17)
];

function getBaseDir(def: BrowserDef, context: BrowserPathsContext): string | null {
  const { home } = context;
  if (context.platform === "darwin") {
    if (def.id === "safari") {
      return posix.join(home, "Library", "Safari");
    }
    return posix.join(home, "Library", "Application Support", def.darwinSubdir);
  }
  if (context.platform === "linux" && def.linuxSubdir) {
    return posix.join(home, ".config", def.linuxSubdir);
  }
  if (context.platform === "win32" && def.windowsSubdir) {
    const localAppData = context.localAppData || win32.join(home, "AppData", "Local");
    return win32.join(localAppData, def.windowsSubdir);
  }
  return null;
}

/** A Windows package directory alone does not establish a Chromium history store. */
function hasArcHistory(baseDir: string, context: BrowserPathsContext): boolean {
  const localState = win32.join(baseDir, "Local State");
  if (!context.exists(localState)) return false;
  if (context.exists(win32.join(baseDir, "Default", "History"))) return true;
  if (!context.readText) return false;
  try {
    const state: unknown = JSON.parse(context.readText(localState));
    if (!state || typeof state !== "object" || !("profile" in state)) return false;
    const profile = state.profile;
    if (!profile || typeof profile !== "object" || !("info_cache" in profile)) return false;
    const cache = profile.info_cache;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) return false;
    return Object.keys(cache).some(
      (directory) =>
        directory !== "." &&
        directory !== ".." &&
        directory.length > 0 &&
        !/[\\/]/u.test(directory) &&
        context.exists(win32.join(baseDir, directory, "History")),
    );
  } catch {
    return false;
  }
}

function isBrowserInstalled(def: BrowserDef, context: BrowserPathsContext): boolean {
  const baseDir = getBaseDir(def, context);
  const { join } = context.platform === "win32" ? win32 : posix;
  if (!baseDir) return false;

  if (def.engine === "safari") {
    return context.exists(join(baseDir, "History.db"));
  }
  if (context.platform === "win32" && def.id === "arc") return hasArcHistory(baseDir, context);
  // Chromium — check for at least one profile with a History file
  return (
    context.exists(join(baseDir, "Default", "History")) ||
    context.exists(join(baseDir, "Local State"))
  );
}

/** Detect all installed browsers on this machine */
export function detectInstalledBrowsers(context = defaultContext()): BrowserInfo[] {
  return BROWSER_DEFS.filter((def) => isBrowserInstalled(def, context)).map((def) => ({
    id: def.id,
    name: def.name,
    baseDir: getBaseDir(def, context)!,
    engine: def.engine,
  }));
}

/** Get info for a specific browser by ID. Returns null if not installed. */
export function getBrowserInfo(id: string, context = defaultContext()): BrowserInfo | null {
  const def = BROWSER_DEFS.find((d) => d.id === id);
  if (!def) return null;
  const baseDir = getBaseDir(def, context);
  if (!baseDir || !isBrowserInstalled(def, context)) return null;
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
