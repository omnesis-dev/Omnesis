// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWindowsPrivateFileSync,
  secureWindowsPrivatePathSync,
  writeWindowsPrivateFileAtomicSync,
} from "@omnesis/platform/windows-private-file";
import { parseDotEnv } from "./dotenv-reader.js";

function ensurePrivateConfigDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") secureWindowsPrivatePathSync(configDir, "directory");
  else chmodSync(configDir, 0o700);
}

/**
 * Idempotently set `KEY=value` pairs in `<configDir>/.env`, in place.
 *
 * Unlike the installer's bash `append_env` (which only ever appends and leaves
 * a pre-existing key untouched), this UPSERTS: a key already present in the
 * file is rewritten in place to the new value; a key not present is appended.
 * Re-running with the same inputs is a no-op, so `omnesis tls provision`
 * never accumulates duplicate or conflicting `OMNESIS_TLS_*` lines across
 * repeated runs.
 *
 * The file is created (with the config dir) if absent, and any write leaves it
 * private (POSIX mode 0600 or a protected Windows ACL). It may hold secrets,
 * so a run that changes something also
 * tightens a file that was looser, and replaces a symlink with a regular file.
 * A run that changes nothing writes nothing and leaves the file as it stands.
 * Only the named keys are touched; every other line (comments, blanks,
 * unrelated keys, surrounding quotes) is preserved verbatim.
 *
 * Returns the list of keys whose value actually changed (added or updated),
 * so callers can report what they did and stay quiet on a no-op re-run.
 */
export function upsertDotEnv(
  configDir: string,
  updates: Record<string, string>,
): { path: string; changed: string[] } {
  const path = join(configDir, ".env");

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = ""; // no file yet — we create it below
  }

  const remaining = new Map(Object.entries(updates));
  const changed: string[] = [];

  const lines = raw.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return line;

    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) return line;

    const key = withoutExport.slice(0, eq).trim();
    if (!remaining.has(key)) return line;

    const newValue = remaining.get(key) as string;
    remaining.delete(key);
    const currentValue = parseDotEnv(line)[key];
    if (currentValue !== newValue) changed.push(key);
    // Rewrite the line in place, dropping any `export ` prefix and quotes —
    // the parser strips both, and our values never need quoting.
    return `${key}=${newValue}`;
  });

  // Append any keys that weren't already present.
  const appended: string[] = [];
  for (const [key, value] of remaining) {
    appended.push(`${key}=${value}`);
    changed.push(key);
  }

  let body = rewritten.join("\n");
  if (appended.length > 0) {
    // Keep exactly one trailing newline before our appended block.
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += appended.join("\n") + "\n";
  }

  if (changed.length > 0) {
    ensurePrivateConfigDir(configDir);
    // Written beside the file and renamed over it, because a truncating write
    // interrupted halfway leaves a .env that no longer carries the secret
    // store or the passphrase path the gateway reads at boot. A rename is
    // atomic within one filesystem. The temporary name is random rather than
    // derived from the pid: a config directory bind-mounted into two
    // containers is written by two processes that can both be pid 1.
    if (process.platform === "win32") {
      writeWindowsPrivateFileAtomicSync(path, Buffer.from(body));
    } else {
      const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(temp, body, { mode: 0o600 });
      try {
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    }
  }

  return { path, changed };
}

/**
 * The commented template scaffolded into a fresh config dir. Lists only the
 * bootstrap/path/secret vars that genuinely belong in `.env`; operational
 * tunables (intervals, concurrency, batch sizes) live in `omnesis.json` via
 * `omnesis config set`, not here.
 */
const DOTENV_TEMPLATE = `# Omnesis environment file — loaded on startup from $OMNESIS_CONFIG_DIR/.env
#
# Format:   KEY=value   (one per line; '#' starts a comment; blank lines ignored)
# Precedence: a var exported in your shell (or a Docker 'environment:' entry)
#             always overrides the value here. This file only fills the gaps.
# Note: OMNESIS_CONFIG_DIR cannot be set here — it is what locates this file.
# Note: operational tunables (sync/index intervals, concurrency, batch sizes)
#       belong in omnesis.json via 'omnesis config set', NOT in this file.
#
# Uncomment and edit the vars you need, then restart the gateway/collector.

# ── Split-machine setup (collector / CLI on a different host) ──────────────
# OMNESIS_GATEWAY_URL=https://gateway.local:7600
# OMNESIS_TOKEN=

# ── Gateway network ───────────────────────────────────────────────────────
# OMNESIS_GATEWAY_PORT=7600
# OMNESIS_BIND=0.0.0.0

# ── Storage paths (default to files under the config dir) ──────────────────
# OMNESIS_DB_PATH=
# OMNESIS_INDEX_DB_PATH=
# OMNESIS_ANALYTICS_DB_PATH=

# ── TLS (gateway auto-generates a self-signed cert if these are unset) ─────
# OMNESIS_TLS_CERT=
# OMNESIS_TLS_KEY=
# OMNESIS_INSECURE_TLS=0

# ── Logging ───────────────────────────────────────────────────────────────
# OMNESIS_LOG_LEVEL=info
# OMNESIS_LOG_FILE=

# ── Reverse-proxy ─────────────────────────────────────────────────────────
# OMNESIS_TRUST_PROXY=0

# ── Experimental features ─────────────────────────────────────────────────
# Reveal Omnesis Lab for individual Brain, Tasks and Watches opt-ins, and
# experimental sources and other gated surfaces. Unset/0 = off, 1 = on.
# OMNESIS_EXPERIMENTAL=1
`;

/**
 * Write a commented `.env` template into `configDir` on first boot, if one
 * does not already exist. Created private (it may hold `OMNESIS_TOKEN`)
 * and never overwrites an existing file — the exclusive `wx` flag makes the
 * "don't clobber" guarantee atomic. Mirrors how the bootstrap token is
 * scaffolded on first boot.
 */
export function scaffoldDotEnv(configDir: string): boolean {
  const path = join(configDir, ".env");
  try {
    ensurePrivateConfigDir(configDir);
    if (process.platform === "win32")
      createWindowsPrivateFileSync(path, Buffer.from(DOTENV_TEMPLATE));
    else writeFileSync(path, DOTENV_TEMPLATE, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false; // already exists (EEXIST) or unwritable → leave it be
  }
}
