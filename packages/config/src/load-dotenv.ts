// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `.env` file support for Omnesis.
 *
 * Reads `$OMNESIS_CONFIG_DIR/.env` (default `~/.config/omnesis/.env`) and
 * populates `process.env` for keys that are not already set, so operators
 * don't have to export bootstrap vars (`OMNESIS_GATEWAY_URL`, `OMNESIS_TOKEN`,
 * `OMNESIS_TLS_*`, …) in their shell profile.
 *
 * Intentionally a ~tiny zero-dependency parser rather than the `dotenv`
 * package or Node's `--env-file`:
 *   - the file lives at a CONFIG-DIR-relative path that `OMNESIS_CONFIG_DIR`
 *     can move, which `--env-file` can't compute at launch;
 *   - it must be importable *before* any other `@omnesis/*` module so the
 *     load order is correct, so it depends only on node builtins (no zod,
 *     no `@omnesis/core`).
 *
 * Precedence: a key already present in `process.env` (an explicit shell
 * export, a Docker `environment:` entry, …) always wins over the file. The
 * `.env` only fills the gaps. This matches the env-first precedence used
 * everywhere else (token resolution, runtime settings).
 *
 * `OMNESIS_CONFIG_DIR` is the one var that cannot be bootstrapped from the
 * file — it's what *locates* the file — so it must come from the real shell
 * environment.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoadDotEnvOptions {
  /** Config directory holding `.env`. Defaults to the resolved config dir. */
  dir?: string;
  /** Environment object to mutate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface LoadDotEnvResult {
  /** Absolute path of the `.env` file that was read. */
  path: string;
  /** Number of keys actually written into the environment. */
  loaded: number;
  /** The keys actually written into the environment. */
  keys: string[];
}

/** Parse the exact `.env` subset Omnesis loads, with the first duplicate winning. */
export function parseDotEnv(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (key === "" || parsed[key] !== undefined) continue;
    parsed[key] = stripQuotes(withoutExport.slice(eq + 1).trim());
  }
  return parsed;
}

function ensurePrivateConfigDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
}

/** Resolve the config dir the same way `DEFAULT_CONFIG_DIR` does, reading env fresh. */
function resolveConfigDir(env: NodeJS.ProcessEnv): string {
  return env.OMNESIS_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".config", "omnesis");
}

/** Strip a single layer of matching single or double quotes, if present. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Load `<configDir>/.env` into `process.env` (or `opts.env`), without
 * overwriting keys that are already set. Returns `null` if the file is
 * absent or unreadable (fresh installs have none — this is not an error).
 *
 * Format: `KEY=value` lines, `#` comments, blank lines skipped, an optional
 * leading `export `, and a single layer of surrounding quotes stripped from
 * the value. No `${VAR}` interpolation — values are taken literally.
 */
export function loadDotEnv(opts: LoadDotEnvOptions = {}): LoadDotEnvResult | null {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? resolveConfigDir(env);
  const path = join(dir, ".env");

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // no file → nothing to do
  }

  const keys: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(raw))) {
    // Process-env wins: only fill keys that are not already set.
    if (env[key] === undefined) {
      env[key] = value;
      keys.push(key);
    }
  }

  return { path, loaded: keys.length, keys };
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
 * at mode 0600 — it may hold secrets, so a run that changes something also
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
    const currentValue = stripQuotes(withoutExport.slice(eq + 1).trim());
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
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    try {
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
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
# Enable not-yet-battle-tested features (experimental sources, Deep
# Research). A single on/off switch: unset/0 = off, 1 = everything on.
# OMNESIS_EXPERIMENTAL=1
`;

/**
 * Write a commented `.env` template into `configDir` on first boot, if one
 * does not already exist. Created at mode 0600 (it may hold `OMNESIS_TOKEN`)
 * and never overwrites an existing file — the exclusive `wx` flag makes the
 * "don't clobber" guarantee atomic. Mirrors how the bootstrap token is
 * scaffolded on first boot.
 */
export function scaffoldDotEnv(configDir: string): boolean {
  const path = join(configDir, ".env");
  try {
    ensurePrivateConfigDir(configDir);
    writeFileSync(path, DOTENV_TEMPLATE, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false; // already exists (EEXIST) or unwritable → leave it be
  }
}
