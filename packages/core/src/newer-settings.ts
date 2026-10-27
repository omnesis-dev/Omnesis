// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Settings kept across a downgrade.
 *
 * A release loads `omnesis.json` leniently: keys its schema does not know are
 * stripped, and its config store writes the file back without them on the
 * next change — adding a source, assigning a model. Upgrading again would
 * then bring those settings back at their defaults, switching on what the
 * operator had switched off.
 *
 * So before the updater hands the config to a build that may be older — a
 * downgrade, or the rollback of a failed upgrade — it saves a copy beside it,
 * stamped with the newest release whose settings the copy may hold
 * ({@link saveNewerSettings}). The gateway's config store restores it when it
 * boots ({@link restoreNewerSettings}): what the copy holds and the config
 * lacks goes back, and nothing the config holds is replaced, so a setting
 * changed on the older release stands. Settings the booting release does not
 * know either are kept for a newer one when the copy was made by one, and the
 * copy is otherwise retired, so it is applied once.
 *
 * A key the older release knew can only be missing because the operator
 * removed it there. That is indistinguishable from a key it dropped, so it is
 * restored too.
 */

import { readFileSync, rmSync } from "node:fs";
import { toJsonPointer, validateConfig } from "@omnesis/config";
import { atomicWriteFileSync } from "./atomic-write.js";
import { compareProductVersions, parseProductVersion } from "./client-version.js";

type JsonObject = Record<string, unknown>;

/** The copy saved beside `omnesis.json`, as written to disk. */
interface NewerSettings {
  /** The newest release whose settings `config` may hold. */
  release: string;
  config: JsonObject;
}

/** What booting with a saved copy did. Keys are named, values never. */
export type NewerSettingsRestore =
  /** No copy, or a config the store itself refuses to boot on. */
  | { kind: "none" }
  /** The copy could not be read or is not one this module wrote; left in place. */
  | { kind: "unusable"; reason: string }
  /** JSON Pointers of the subtrees put back, and whether a copy remains for a newer release. */
  | { kind: "restored"; restored: string[]; kept: boolean };

/** Where the copy of the config at `configPath` is saved. */
export function newerSettingsPath(configPath: string): string {
  return `${configPath}.newer-settings`;
}

/**
 * Save the config at `configPath` beside it, before a build that may be older
 * takes it over. `releases` are the releases whose settings it may hold; the
 * copy is stamped with the newest. A copy already there, left by a downgrade
 * not yet upgraded back from, is folded in: what it holds and the config
 * lacks is kept, and its stamp when newer. Returns false when there is no
 * config to save; throws when the config cannot be read or is not an object.
 */
export function saveNewerSettings(configPath: string, releases: readonly string[]): boolean {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (text.trim() === "") return false;
  const config: unknown = JSON.parse(text);
  if (!isPlainObject(config)) throw new Error(`${configPath} does not hold a JSON object`);
  const previous = readNewerSettings(newerSettingsPath(configPath));
  const saved = previous instanceof Error || previous === null ? null : previous;
  for (const { path, value } of missingFrom(config, saved?.config ?? {})) {
    setAt(config, path, value);
  }
  const release = newestRelease([...releases, ...(saved ? [saved.release] : [])]);
  if (release === null) throw new Error(`No release version among ${releases.join(", ")}`);
  writePrivateJson(newerSettingsPath(configPath), { release, config });
  return true;
}

/**
 * Put back what the copy beside `configPath` holds and the config lacks, as
 * far as the `running` release's schema accepts it, then retire the copy —
 * or, when it was made by a newer release than `running`, keep in it only
 * what `running` does not know. Called before the config is loaded, so the
 * load reads the result.
 */
export function restoreNewerSettings(configPath: string, running: string): NewerSettingsRestore {
  const copyPath = newerSettingsPath(configPath);
  const saved = readNewerSettings(copyPath);
  if (saved === null) return { kind: "none" };
  if (saved instanceof Error) return { kind: "unusable", reason: saved.message };

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "none" };
    text = "";
  }
  // No config at all was not written by an older release, which only ever
  // drops keys from one it rewrites: it was removed, and stays that way.
  if (text.trim() === "") {
    rmSync(copyPath, { force: true });
    return { kind: "restored", restored: [], kept: false };
  }
  let current: unknown;
  try {
    current = JSON.parse(text);
  } catch {
    return { kind: "none" };
  }
  const baseline = isPlainObject(current)
    ? validateConfig(current, { stripUnknownKeys: true })
    : null;
  // The store refuses this config itself; the copy waits for one it can read.
  if (!isPlainObject(current) || !baseline?.ok) return { kind: "none" };

  // What this release does not know, in the config or the copy, stays in the
  // copy: this release's next write drops it from the config.
  const kept: JsonObject = {};
  for (const pointer of baseline.strippedKeys) {
    const path = pathOf(pointer);
    setAt(kept, path, structuredClone(getAt(current, path)));
  }
  let merged = structuredClone(current);
  const restored: string[] = [];
  for (const { path, value } of missingFrom(current, saved.config)) {
    const candidate = structuredClone(merged);
    setAt(candidate, path, structuredClone(value));
    const result = validateConfig(candidate, { stripUnknownKeys: true });
    const unknown = result.ok ? result.strippedKeys.map(pathOf) : [];
    if (!result.ok || unknown.some((at) => startsWith(path, at))) {
      setAt(kept, path, value);
      continue;
    }
    for (const at of unknown.filter((at) => startsWith(at, path))) {
      setAt(kept, at, getAt(candidate, at));
      deleteAt(candidate, at);
    }
    merged = candidate;
    restored.push(toJsonPointer(path));
  }

  if (restored.length > 0) writePrivateJson(configPath, merged);
  const keep =
    Object.keys(kept).length > 0 && (compareProductVersions(saved.release, running) ?? 0) > 0;
  if (keep) writePrivateJson(copyPath, { release: saved.release, config: kept });
  else rmSync(copyPath, { force: true });
  return { kind: "restored", restored, kept: keep };
}

/** The copy at `path`; null when there is none, an Error when it cannot be used. */
function readNewerSettings(path: string): NewerSettings | Error | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return err instanceof Error ? err : new Error(String(err));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (
    !isPlainObject(value) ||
    typeof value.release !== "string" ||
    parseProductVersion(value.release) === null ||
    !isPlainObject(value.config)
  ) {
    return new Error("not a release and the config it saved");
  }
  return { release: value.release, config: value.config };
}

function writePrivateJson(path: string, value: unknown): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function newestRelease(releases: readonly string[]): string | null {
  let newest: string | null = null;
  for (const release of releases.map((value) => value.replace(/^v/, ""))) {
    if (parseProductVersion(release) === null) continue;
    if (newest === null || (compareProductVersions(release, newest) ?? 0) > 0) newest = release;
  }
  return newest;
}

/**
 * Every subtree of `from` that `into` lacks, at its shallowest missing key.
 * Two objects are compared key by key; anything else present on both sides —
 * a value, an array, two different kinds — is `into`'s.
 */
function missingFrom(
  into: JsonObject,
  from: JsonObject,
  prefix: readonly string[] = [],
): Array<{ path: string[]; value: unknown }> {
  const missing: Array<{ path: string[]; value: unknown }> = [];
  for (const [key, value] of Object.entries(from)) {
    if (key === "__proto__") continue;
    const path = [...prefix, key];
    const present = into[key];
    if (!Object.hasOwn(into, key)) missing.push({ path, value });
    else if (isPlainObject(present) && isPlainObject(value)) {
      missing.push(...missingFrom(present, value, path));
    }
  }
  return missing;
}

function getAt(root: JsonObject, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) node = isPlainObject(node) ? node[key] : undefined;
  return node;
}

function setAt(root: JsonObject, path: readonly string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const child = node[key];
    if (!isPlainObject(child)) node[key] = {};
    node = node[key] as JsonObject;
  }
  node[path[path.length - 1]!] = value;
}

function deleteAt(root: JsonObject, path: readonly string[]): void {
  const parent = getAt(root, path.slice(0, -1));
  if (isPlainObject(parent)) delete parent[path[path.length - 1]!];
}

/** RFC 6901 JSON Pointer → keys. */
function pathOf(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => path[index] === key);
}

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
