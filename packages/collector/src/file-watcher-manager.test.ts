// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 5000,
  whileWaiting?: () => void,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    whileWaiting?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

describe("FileWatcherManager", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("recursively watches the filename suffixes declared by a directory source", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-manager-"));
    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const watchedFile = join(tmpDir, "active.jsonl");
    realFs.writeFileSync(watchedFile, "{}\n");
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 1,
      pollIntervalMs: 10,
    });

    try {
      expect(
        manager.setupForSource({
          id: "jsonl-source",
          watchPaths: [tmpDir],
          watchFileExtensions: [".jsonl"],
        }),
      ).toBe(true);
      // Recursive fs.watch delivery is explicitly best-effort. In particular,
      // macOS can expose the FSEvents subscription shortly after watch()
      // returns under load, so keep producing matching mutations until the
      // integration boundary proves that it is live.
      await waitForCondition(
        () => changed.includes("jsonl-source"),
        5000,
        () => realFs.appendFileSync(watchedFile, "{}\n"),
      );
    } finally {
      manager.stopAll();
    }
  });

  test("promotes an absent directory watch after the directory appears", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-manager-"));
    const sessionsDir = join(tmpDir, "missing-parent", "sessions");
    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 1,
      pollIntervalMs: 10,
    });

    try {
      expect(
        manager.setupForSource({
          id: "late-jsonl-source",
          watchPaths: [sessionsDir],
          watchDirectoryPaths: [sessionsDir],
          watchFileExtensions: [".jsonl"],
        }),
      ).toBe(true);

      realFs.mkdirSync(sessionsDir, { recursive: true });
      await waitForCondition(() => changed.includes("late-jsonl-source"));
      changed.length = 0;

      const sessionFile = join(sessionsDir, "active.jsonl");
      realFs.writeFileSync(sessionFile, "{}\n");
      await waitForCondition(() => changed.includes("late-jsonl-source"));
      changed.length = 0;

      realFs.appendFileSync(sessionFile, "{}\n");
      await waitForCondition(() => changed.includes("late-jsonl-source"));
    } finally {
      manager.stopAll();
    }
  });

  test("keeps the fallback live when the first recursive promotion fails", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-manager-"));
    const sessionsDir = join(tmpDir, "sessions");
    let recursiveAttempts = 0;

    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      watch(...args: unknown[]) {
        const [path, options] = args;
        if (
          String(path) === sessionsDir &&
          options &&
          typeof options === "object" &&
          "recursive" in options &&
          options.recursive === true
        ) {
          recursiveAttempts += 1;
          if (recursiveAttempts === 1) throw new Error("transient recursive-watch failure");
        }
        return Reflect.apply(realFs.watch, realFs, args);
      },
    }));

    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 1,
      pollIntervalMs: 10,
    });

    try {
      expect(
        manager.setupForSource({
          id: "retrying-jsonl-source",
          watchPaths: [sessionsDir],
          watchDirectoryPaths: [sessionsDir],
          watchFileExtensions: [".jsonl"],
        }),
      ).toBe(true);
      realFs.mkdirSync(sessionsDir);
      await waitForCondition(() => recursiveAttempts >= 2);
      expect(manager.hasWatcher("retrying-jsonl-source")).toBe(true);

      changed.length = 0;
      realFs.writeFileSync(join(sessionsDir, "active.jsonl"), "{}\n");
      await waitForCondition(() => changed.includes("retrying-jsonl-source"));
    } finally {
      manager.stopAll();
    }
  });

  test("retries one failed directory when another root promotes successfully", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-manager-"));
    const sessionsDir = join(tmpDir, "sessions");
    const archiveDir = join(tmpDir, "archived_sessions");
    realFs.mkdirSync(sessionsDir);
    let archiveAttempts = 0;

    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      watch(...args: unknown[]) {
        const [path, options] = args;
        if (
          String(path) === archiveDir &&
          options &&
          typeof options === "object" &&
          "recursive" in options &&
          options.recursive === true
        ) {
          archiveAttempts += 1;
          if (archiveAttempts === 1) throw new Error("transient archive-watch failure");
        }
        return Reflect.apply(realFs.watch, realFs, args);
      },
    }));

    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 1,
      pollIntervalMs: 10,
    });

    try {
      expect(
        manager.setupForSource({
          id: "multi-root-source",
          watchPaths: [sessionsDir, archiveDir],
          watchDirectoryPaths: [sessionsDir, archiveDir],
          watchFileExtensions: [".jsonl"],
        }),
      ).toBe(true);
      realFs.mkdirSync(archiveDir);
      await waitForCondition(() => archiveAttempts >= 2);

      changed.length = 0;
      realFs.writeFileSync(join(archiveDir, "archived.jsonl"), "{}\n");
      await waitForCondition(() => changed.includes("multi-root-source"));
    } finally {
      manager.stopAll();
    }
  });

  test("watches an absent exact file even when directory events use an extension filter", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-manager-"));
    const watchFile = join(tmpDir, "late.jsonl");
    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 1,
      pollIntervalMs: 10,
    });

    try {
      expect(
        manager.setupForSource({
          id: "late-file-source",
          watchPaths: [watchFile],
          watchFileExtensions: [".jsonl"],
        }),
      ).toBe(true);
      realFs.writeFileSync(watchFile, "{}\n");
      await waitForCondition(() => changed.includes("late-file-source"));
    } finally {
      manager.stopAll();
    }
  });

  test("polls a file created after missing-path classification but before baseline seeding", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-manager-"));
    const watchFile = join(tmpDir, "chat.db-wal");
    let firstWatchFileExistsCheck = true;

    vi.doMock("node:fs", () => ({
      ...realFs,
      default: realFs,
      existsSync(path: import("node:fs").PathLike): boolean {
        if (String(path) === watchFile && firstWatchFileExistsCheck) {
          firstWatchFileExistsCheck = false;
          realFs.writeFileSync(watchFile, "created during setup");
          return false;
        }
        return realFs.existsSync(path);
      },
    }));

    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 1,
      pollIntervalMs: 10,
    });

    try {
      expect(manager.setupForSource({ id: "watched-source", watchPaths: [watchFile] })).toBe(true);
      await waitForCondition(() => changed.includes("watched-source"));
    } finally {
      manager.stopAll();
    }
  });
});

describe("FileWatcherManager quiet period", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /** A manager watching one directory, with the fs event under test control. */
  async function watching(watchQuietMs?: number) {
    tmpDir = mkdtempSync(join(tmpdir(), "file-watcher-quiet-"));
    const { FileWatcherManager } = await import("./file-watcher-manager.js");
    const changed: string[] = [];
    const manager = new FileWatcherManager((sourceId) => changed.push(sourceId), {
      debounceMs: 3_000,
      pollIntervalMs: 3_600_000,
    });
    manager.setupForSource({ id: "sessions", watchPaths: [tmpDir], watchQuietMs });
    const change = () =>
      (manager as unknown as { onFileChange(id: string): void }).onFileChange("sessions");
    return { manager, changed, change };
  }

  test("a source that asks for a quiet period is not read while its files keep changing", async () => {
    // A coding agent rewrites its transcript after every step. Reading on the
    // short default debounce re-read a long session on every step.
    vi.useFakeTimers();
    const { manager, changed, change } = await watching(60_000);
    try {
      change();
      vi.advanceTimersByTime(3_000);
      expect(changed).toEqual([]);

      change(); // still working: the quiet period starts again
      vi.advanceTimersByTime(59_000);
      expect(changed).toEqual([]);

      vi.advanceTimersByTime(1_000);
      expect(changed).toEqual(["sessions"]);
    } finally {
      manager.stopAll();
    }
  });

  test("a source that does not ask keeps the short default", async () => {
    vi.useFakeTimers();
    const { manager, changed, change } = await watching();
    try {
      change();
      vi.advanceTimersByTime(3_000);
      expect(changed).toEqual(["sessions"]);
    } finally {
      manager.stopAll();
    }
  });
});
