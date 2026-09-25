// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { watch, existsSync, statSync } from "node:fs";
import { dirname, basename } from "node:path";
import { createLogger, toErrorMessage } from "@omnesis/core";
import { DEFAULT_WATCH_DEBOUNCE_MS, DEFAULT_FILE_POLL_INTERVAL_MS } from "./tunables.js";
import type { FSWatcher } from "node:fs";

const log = createLogger("collector:sync");

export interface FileWatcherTarget {
  id: string;
  watchPaths?: string[] | undefined;
  /** Subset of watchPaths known to be directories even while absent. */
  watchDirectoryPaths?: string[] | undefined;
  /** Filename suffixes accepted by recursive directory watches. Omit to accept all. */
  watchFileExtensions?: string[] | undefined;
  /** How long the watched files must stay unchanged before a change syncs. See the source contract. */
  watchQuietMs?: number | undefined;
  /** Called once per source when fileWatchActive flips to true. */
  onActive?: () => void;
}

function safeWatchError(error: unknown, path: string): string {
  return toErrorMessage(error).split(path).join(basename(path));
}

/**
 * Owns filesystem watchers + mtime-poll fallbacks + the per-source
 * change debounce. Extracted from SyncEngine so the engine doesn't have
 * to model fs.watch quirks (recursive watchers, parent-dir watchers for
 * specific files, mtime polling for SQLite WAL writes via mmap).
 *
 * One instance per SyncEngine. The engine owns when to start/stop
 * watchers (per-source lifecycle) and what to do on a debounced change
 * — the manager just translates fs events into a debounced callback.
 */
export class FileWatcherManager {
  private watchers = new Map<string, FSWatcher[]>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-source quiet period, for sources that asked for longer than the default debounce. */
  private quietMs = new Map<string, number>();

  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly onChange: (sourceId: string) => void,
    opts?: { debounceMs?: number; pollIntervalMs?: number },
  ) {
    this.debounceMs = opts?.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_FILE_POLL_INTERVAL_MS;
  }

  /**
   * True if a watcher is already wired for this source. Used by callers
   * to avoid double-setup when source-loop bootstrap and per-source
   * register both run.
   */
  hasWatcher(sourceId: string): boolean {
    return this.watchers.has(sourceId);
  }

  /**
   * Set up watchers for a source. Returns true if any watcher was wired
   * (so the caller can flip `fileWatchActive` on the status).
   */
  setupForSource(target: FileWatcherTarget): boolean {
    const watchPaths = target.watchPaths;
    if (!watchPaths || watchPaths.length === 0) return false;
    if (this.watchers.has(target.id)) return false; // already watching
    if (target.watchQuietMs !== undefined) this.quietMs.set(target.id, target.watchQuietMs);

    const watchers: FSWatcher[] = [];

    // Separate directory paths (recursive watch) from file paths (parent-dir watch)
    const dirPaths: string[] = [];
    const dirToFiles = new Map<string, Set<string>>();
    const initiallyAbsentFiles = new Set<string>();
    const pendingDirectories = new Set<string>();
    const declaredDirectories = new Set(target.watchDirectoryPaths ?? []);

    for (const watchPath of watchPaths) {
      if (!existsSync(watchPath)) {
        if (declaredDirectories.has(watchPath)) {
          pendingDirectories.add(watchPath);
          log.debug(
            `Watch directory does not exist yet, polling for creation: ${basename(watchPath)} (source: ${target.id})`,
          );
          continue;
        }

        const dir = dirname(watchPath);
        if (existsSync(dir)) {
          const file = basename(watchPath);
          if (!dirToFiles.has(dir)) dirToFiles.set(dir, new Set());
          dirToFiles.get(dir)!.add(file);
          initiallyAbsentFiles.add(watchPath);
          log.debug(
            `Watch file does not exist yet, watching parent: ${basename(watchPath)} (source: ${target.id})`,
          );
        } else {
          log.debug(
            `Watch path does not exist, skipping: ${basename(watchPath)} (source: ${target.id})`,
          );
        }
        continue;
      }

      try {
        if (statSync(watchPath).isDirectory()) {
          dirPaths.push(watchPath);
        } else {
          const dir = dirname(watchPath);
          const file = basename(watchPath);
          if (!dirToFiles.has(dir)) dirToFiles.set(dir, new Set());
          dirToFiles.get(dir)!.add(file);
        }
      } catch {
        const dir = dirname(watchPath);
        const file = basename(watchPath);
        if (!dirToFiles.has(dir)) dirToFiles.set(dir, new Set());
        dirToFiles.get(dir)!.add(file);
      }
    }

    // Set up recursive watchers for directory paths (e.g. Obsidian vault root)
    for (const dir of dirPaths) {
      try {
        const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const extensions = target.watchFileExtensions;
          if (!extensions?.length || extensions.some((extension) => filename.endsWith(extension))) {
            this.onFileChange(target.id);
          }
        });

        watcher.on("error", (err) => {
          log.warn(
            `Recursive file watcher error for ${target.id} at ${basename(dir)}: ${safeWatchError(err, dir)}`,
          );
        });

        watchers.push(watcher);
      } catch (err) {
        pendingDirectories.add(dir);
        log.warn(
          `Failed to set up recursive file watcher for ${target.id} at ${basename(dir)}: ${safeWatchError(err, dir)}`,
        );
      }
    }

    // Set up parent-dir watchers for specific file paths (e.g. NoteStore.sqlite).
    // Also set up mtime polling as a fallback — fs.watch on macOS does not
    // reliably fire events when another process (e.g. cloudnoted, Things)
    // writes to SQLite WAL files via memory-mapped I/O.
    const polledFiles: string[] = [];
    for (const [dir, fileNames] of dirToFiles) {
      try {
        const watcher = watch(dir, (_eventType, filename) => {
          if (filename && fileNames.has(filename)) {
            this.onFileChange(target.id);
          }
        });

        watcher.on("error", (err) => {
          log.warn(
            `File watcher error for ${target.id} at ${basename(dir)}: ${safeWatchError(err, dir)}`,
          );
        });

        watchers.push(watcher);
      } catch (err) {
        log.warn(
          `Failed to set up file watcher for ${target.id} at ${basename(dir)}: ${safeWatchError(err, dir)}`,
        );
      }

      for (const fileName of fileNames) {
        polledFiles.push(`${dir}/${fileName}`);
      }
    }

    // Start mtime polling for file paths and directory roots that do not
    // exist yet. A pending directory promotes itself to a recursive watch.
    if (
      (polledFiles.length > 0 || pendingDirectories.size > 0) &&
      !this.pollTimers.has(target.id)
    ) {
      const lastMtimes = new Map<string, number>();
      for (const filePath of polledFiles) {
        if (initiallyAbsentFiles.has(filePath)) {
          lastMtimes.set(filePath, 0);
          continue;
        }
        try {
          lastMtimes.set(filePath, statSync(filePath).mtimeMs);
        } catch {
          lastMtimes.set(filePath, 0);
        }
      }

      const pollTimer = setInterval(() => {
        if (this.debounceTimers.has(target.id)) return;

        for (const pendingDirectory of pendingDirectories) {
          try {
            if (!statSync(pendingDirectory).isDirectory()) continue;

            // Build the replacement while the parent/poll fallback remains
            // live. Only close the old handles after recursive setup succeeds.
            const previousWatchers = this.watchers.get(target.id) ?? [];
            const previousPollTimer = this.pollTimers.get(target.id);
            this.watchers.delete(target.id);
            this.pollTimers.delete(target.id);
            if (this.setupForSource(target)) {
              for (const watcher of previousWatchers) watcher.close();
              if (previousPollTimer) clearInterval(previousPollTimer);
              this.onFileChange(target.id);
              return;
            }

            // Recursive setup failed. Remove any partial replacement and
            // restore the still-open fallback handles for another attempt.
            this.stopForSource(target.id);
            this.watchers.set(target.id, previousWatchers);
            if (previousPollTimer) this.pollTimers.set(target.id, previousPollTimer);
          } catch {
            // Directory does not exist yet — keep polling.
          }
        }

        for (const filePath of polledFiles) {
          try {
            const currentMtime = statSync(filePath).mtimeMs;
            const lastMtime = lastMtimes.get(filePath) ?? 0;
            if (currentMtime > lastMtime) {
              lastMtimes.set(filePath, currentMtime);
              this.onFileChange(target.id);
              break;
            }
          } catch {
            // File may not exist yet — ignore
          }
        }
      }, this.pollIntervalMs);

      this.pollTimers.set(target.id, pollTimer);
    }

    if (watchers.length > 0 || this.pollTimers.has(target.id)) {
      this.watchers.set(target.id, watchers);
      const activePaths = watchPaths.filter((p) => existsSync(p));
      log.info(`File watching enabled for ${target.id} (${activePaths.length} paths)`);
      log.debug(
        `Watch paths for ${target.id}: ${activePaths.map((path) => basename(path)).join(", ")}`,
      );
      target.onActive?.();
      return true;
    }
    return false;
  }

  /**
   * Tear down per-source watchers, the poll timer, and any pending
   * debounce timer. Used by `disableSource` and `unregisterSource`.
   */
  stopForSource(sourceId: string): void {
    const watchers = this.watchers.get(sourceId);
    if (watchers) {
      for (const w of watchers) w.close();
      this.watchers.delete(sourceId);
    }

    const pollTimer = this.pollTimers.get(sourceId);
    if (pollTimer) {
      clearInterval(pollTimer);
      this.pollTimers.delete(sourceId);
    }

    const debounce = this.debounceTimers.get(sourceId);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(sourceId);
    }
    this.quietMs.delete(sourceId);
  }

  /** Tear down every watcher + timer. Used by `stopSyncLoop`. */
  stopAll(): void {
    for (const [, watchers] of this.watchers) {
      for (const watcher of watchers) {
        watcher.close();
      }
    }
    this.watchers.clear();

    for (const [, timer] of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.quietMs.clear();
  }

  private onFileChange(sourceId: string): void {
    const existing = this.debounceTimers.get(sourceId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(
      () => {
        this.debounceTimers.delete(sourceId);
        log.info(`File change detected, triggering sync for ${sourceId}`);
        this.onChange(sourceId);
      },
      Math.max(this.debounceMs, this.quietMs.get(sourceId) ?? 0),
    );

    this.debounceTimers.set(sourceId, timer);
  }
}
