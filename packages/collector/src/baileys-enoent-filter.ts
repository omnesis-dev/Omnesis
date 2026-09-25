// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Narrow predicate that recognises the known-benign Baileys
 * `useMultiFileAuthState` ENOENT race. Used by `main.ts` to suppress
 * exactly that race in the collector's `unhandledRejection` /
 * `uncaughtException` handlers — every other error escalates so the
 * supervisor can restart the process.
 *
 * The race shape: Baileys's `saveCreds` debounce fires after the
 * WhatsApp socket has been torn down and the auth directory has
 * been `rmSync`'d, so the async `fs.writeFile` lands on a missing
 * path. The rest of the cleanup (registerProvider replacement,
 * dispose ordering, the 2s flush wait in WhatsApp.disconnect)
 * closes the timing windows; this filter is belt-and-braces for the
 * one path that still slips through.
 *
 * Match shape: ENOENT with a path that includes one of the Baileys
 * per-key filename prefixes
 * (`creds`, `app-state-sync-`, `sender-key-`, `session-`, `pre-key-`).
 * Matching the filename rather than the parent path is deliberate —
 * the auth dir varies per source instance, and a too-broad parent-
 * path match would silently swallow unrelated ENOENT errors (e.g.
 * inside a SQLite WAL recovery path).
 */
const BAILEYS_AUTH_FILENAME_RE = /\b(creds|app-state-sync-|sender-key-|session-|pre-key-)/;

export function isBaileysAuthEnoent(err: unknown): boolean {
  const e = err as { code?: string; path?: unknown } | null;
  if (!e || e.code !== "ENOENT") return false;
  const p = typeof e.path === "string" ? e.path : "";
  return BAILEYS_AUTH_FILENAME_RE.test(p);
}
