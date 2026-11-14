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
 * Intentionally a tiny zero-dependency parser rather than the `dotenv`
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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LoadDotEnvOptions {
  /** Config directory holding `.env`. Defaults to the resolved config dir. */
  dir?: string;
  /** Environment object to mutate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Optional trusted reader; only ENOENT is treated as absent when supplied. */
  readFile?: (path: string) => string;
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
    raw = opts.readFile ? opts.readFile(path) : readFileSync(path, "utf8");
  } catch (error) {
    if (opts.readFile && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
