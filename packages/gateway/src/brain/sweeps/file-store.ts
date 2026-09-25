// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The user sweep directory — `<configDir>/sweeps/*.md`.
 *
 * Reads are cached on file mtime+size, because the enqueuer resolves the sweep
 * set on every rhythm tick and re-parsing a handful of small files each time
 * would be pointless work. Cheaper than a filesystem watcher and with no
 * lifecycle to get wrong: a hand-edited file is picked up on the next tick,
 * which is the same "no restart needed" the config store gives.
 *
 * Ids are filename stems and are validated against `SWEEP_ID_PATTERN` on every
 * path in and out, so nothing here can be steered outside the directory by an
 * id containing a separator or a traversal segment.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidSweepId,
  MAX_STEERING_PROMPT_CHARS,
  parseSweepFile,
  serializeSweepFile,
} from "./file-format.js";
import type { SweepFileContent } from "./file-format.js";

/**
 * Refuse to read a file larger than this. The resolver runs on the gateway's
 * main thread on every rhythm tick with synchronous fs, so the size check has
 * to happen before the read rather than inside the parser — generous headroom
 * over the prose cap, small enough that no single file can stall the loop.
 */
const MAX_SWEEP_FILE_BYTES = MAX_STEERING_PROMPT_CHARS * 8;

/**
 * Cap on how many sweeps a directory may define. Each one is a scheduled agent
 * run over the whole corpus, and they drain strictly serialized — far past
 * this the lane stops being a schedule and becomes a queue that never empties.
 * The overflow is reported, like every other bad input here, rather than
 * silently dropped.
 */
const MAX_SWEEP_FILES = 64;

/** One file on disk, parsed or rejected. */
export interface SweepFileEntry {
  id: string;
  file: string;
  content: SweepFileContent | null;
  /** Set when the file could not be parsed; `content` is then null. */
  error: string | null;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: SweepFileEntry;
}

export class SweepFileStore {
  private readonly dir: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(configDir: string) {
    this.dir = join(configDir, "sweeps");
  }

  /** The directory sweep files live in — surfaced so the operator can go there. */
  get directory(): string {
    return this.dir;
  }

  /** Absolute path of one sweep file. Throws on an id that is not a safe stem. */
  pathFor(id: string): string {
    if (!isValidSweepId(id)) throw new Error(`Invalid sweep id: ${id}`);
    return join(this.dir, `${id}.md`);
  }

  /**
   * Every `.md` in the directory, id-sorted. A missing directory is the normal
   * state on a fresh install, not an error. A file whose stem is not a valid
   * id is reported rather than skipped — silently ignoring `My Sweep.md` would
   * leave the author staring at a sweep that never runs.
   */
  list(): SweepFileEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".md"));
    } catch {
      this.cache.clear();
      return [];
    }
    const entries: SweepFileEntry[] = [];
    const live = new Set<string>();
    const sorted = names.sort();
    for (const [index, name] of sorted.entries()) {
      const file = join(this.dir, name);
      const id = name.slice(0, -3);
      live.add(file);
      if (index >= MAX_SWEEP_FILES) {
        entries.push({
          id,
          file,
          content: null,
          error: `more than ${MAX_SWEEP_FILES} sweep files in this directory — this one is not loaded`,
        });
        continue;
      }
      if (!isValidSweepId(id)) {
        entries.push({
          id,
          file,
          content: null,
          error:
            "file name is not a usable sweep id — use lower-case letters, digits and hyphens (e.g. commitments-made.md)",
        });
        continue;
      }
      entries.push(this.readCached(id, file));
    }
    for (const key of [...this.cache.keys()]) if (!live.has(key)) this.cache.delete(key);
    return entries;
  }

  /** One file, or null when it does not exist. */
  get(id: string): SweepFileEntry | null {
    const file = this.pathFor(id);
    try {
      statSync(file);
    } catch {
      return null;
    }
    return this.readCached(id, file);
  }

  /** Write (or overwrite) a sweep file. Creates the directory on first write. */
  write(id: string, content: SweepFileContent): void {
    const file = this.pathFor(id);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, serializeSweepFile(content), { encoding: "utf8", mode: 0o600 });
    this.cache.delete(file);
  }

  /** Delete a sweep file. Returns false when there was nothing to delete. */
  remove(id: string): boolean {
    const file = this.pathFor(id);
    try {
      statSync(file);
    } catch {
      return false;
    }
    rmSync(file, { force: true });
    this.cache.delete(file);
    return true;
  }

  private readCached(id: string, file: string): SweepFileEntry {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      this.cache.delete(file);
      return { id, file, content: null, error: "file disappeared while being read" };
    }
    if (stat.size > MAX_SWEEP_FILE_BYTES) {
      return {
        id,
        file,
        content: null,
        error: `file is ${stat.size} bytes; a sweep file may not exceed ${MAX_SWEEP_FILE_BYTES}`,
      };
    }
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;

    let parsed: SweepFileEntry;
    try {
      const result = parseSweepFile(readFileSync(file, "utf8"));
      parsed = result.ok
        ? { id, file, content: result.content, error: null }
        : { id, file, content: null, error: result.message };
    } catch (err) {
      parsed = {
        id,
        file,
        content: null,
        error: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    return parsed;
  }
}
