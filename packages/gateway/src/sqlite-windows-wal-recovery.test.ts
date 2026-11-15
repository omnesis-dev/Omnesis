// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { ownedProcessCleanupReceipt, runWindowsJob, type WindowsJobResult } from "@omnesis/core";
import type Database from "better-sqlite3";

const require = createRequire(import.meta.url);

interface FixtureJob {
  controller: AbortController;
  work: Promise<WindowsJobResult>;
  settled: boolean;
  rejected: boolean;
  error: unknown;
}

function startJob(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deadline: number,
): FixtureJob {
  const controller = new AbortController();
  const state = {
    controller,
    settled: false,
    rejected: false,
    error: undefined as unknown,
  };
  const work = Promise.resolve()
    .then(() =>
      runWindowsJob(command, args, {
        env,
        signal: controller.signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      }),
    )
    .then(
      (result) => {
        state.settled = true;
        return result;
      },
      (error: unknown) => {
        state.settled = true;
        state.rejected = true;
        state.error = error;
        throw error;
      },
    );
  void work.catch(() => {});
  return Object.assign(state, { work });
}

async function ready(path: string, job: FixtureJob, deadline: number): Promise<void> {
  while (!existsSync(path)) {
    if (job.settled) {
      if (job.rejected) throw job.error;
      const result = await job.work;
      if (ownedProcessCleanupReceipt(result)) throw result;
      throw new Error(
        `SQLite fixture exited before readiness: ${result.failure ?? result.exitCode}; ${result.stderr}`,
      );
    }
    if (Date.now() >= deadline) throw new Error("SQLite fixture did not become ready");
    await sleep(20);
  }
}

async function closeFixtureJobs(
  jobs: FixtureJob[],
  root: string,
  primaryFailed: boolean,
  primaryFailure: unknown,
): Promise<void> {
  for (const job of jobs) if (!job.settled) job.controller.abort();
  const results = await Promise.allSettled(jobs.map((job) => job.work));
  const uncertain = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason as unknown]
      : ownedProcessCleanupReceipt(result.value)
        ? [result.value]
        : [],
  );
  if (uncertain.length)
    throw Object.assign(
      new AggregateError(
        [...(primaryFailed ? [primaryFailure] : []), ...uncertain],
        "SQLite fixture cleanup is unverified",
        { cause: uncertain[0] },
      ),
      {
        cleanupFailure: uncertain[0],
      },
    );
  rmSync(root, { recursive: true, force: true });
}

// A raw mapping deliberately owns no SQLite DMS lock, as can happen while
// Windows retires a process's views after dropping its locks. Keep it alive
// through recovery: a delay that merely waits for unmapping cannot pass.
const pinSharedMemory = `
$ErrorActionPreference='Stop'
$file=$null; $map=$null; $view=$null
try {
  $file=[IO.File]::Open($env:OMNESIS_SQLITE_SHM,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
  $map=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($file,[Guid]::NewGuid().ToString(),0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite,[IO.HandleInheritability]::None,$true)
  $view=$map.CreateViewAccessor()
  [IO.File]::WriteAllText($env:OMNESIS_SQLITE_READY,'mapped')
  while (-not [IO.File]::Exists($env:OMNESIS_SQLITE_RELEASE)) { [Threading.Thread]::Sleep(20) }
} finally {
  if ($null -ne $view) {$view.Dispose()}
  if ($null -ne $map) {$map.Dispose()}
  if ($null -ne $file) {$file.Dispose()}
}
`;

test.runIf(process.platform === "win32").each([
  { packageName: "better-sqlite3", encrypted: false },
  { packageName: "better-sqlite3-multiple-ciphers", encrypted: false },
  { packageName: "better-sqlite3-multiple-ciphers", encrypted: true },
])(
  "$packageName recovers committed WAL while an unlocked stale shared-memory view remains mapped (encrypted=$encrypted)",
  async ({ packageName, encrypted }) => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error("Windows system directory is unavailable");
    const root = mkdtempSync(join(tmpdir(), "omnesis-sqlite-mapped-wal-"));
    const path = join(root, "fixture.db");
    const writerReady = join(root, "writer-ready");
    const mappingReady = join(root, "mapping-ready");
    const release = join(root, "release");
    const jobs: FixtureJob[] = [];
    let mapping: FixtureJob | undefined;
    const Constructor = require(packageName) as typeof Database;
    const key = encrypted ? randomBytes(32).toString("hex") : undefined;
    const open = () => {
      const db = new Constructor(path, { fileMustExist: true });
      try {
        if (key) {
          db.pragma("cipher='sqlcipher'");
          db.pragma("legacy=4");
          db.pragma(`key='${key}'`);
        }
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    const deadline = Date.now() + 20_000;
    let primaryFailure: unknown;
    let primaryFailed = false;
    try {
      const writer = startJob(
        process.execPath,
        [
          "-e",
          `const Database=require(${JSON.stringify(require.resolve(packageName))});
          const db=new Database(process.argv[1]);
          if(process.env.OMNESIS_SQLITE_KEY){db.pragma("cipher='sqlcipher'");db.pragma('legacy=4');db.pragma("key='"+process.env.OMNESIS_SQLITE_KEY+"'");}
          db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
          db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT);INSERT INTO notes VALUES(1,'invented durable note')");
          require('node:fs').writeFileSync(process.env.OMNESIS_SQLITE_READY,'committed');
          setInterval(()=>{},60000);`,
          path,
        ],
        { ...process.env, OMNESIS_SQLITE_READY: writerReady, OMNESIS_SQLITE_KEY: key },
        deadline,
      );
      jobs.push(writer);
      await ready(writerReady, writer, deadline);
      writer.controller.abort();
      const crashed = await writer.work;
      expect(ownedProcessCleanupReceipt(crashed)).toBeUndefined();
      expect(crashed.failure).toBe("aborted");
      expect(existsSync(`${path}-wal`)).toBe(true);
      // A cleanly retired SHM name can still be mapped by another handle.
      if (!existsSync(`${path}-shm`)) writeFileSync(`${path}-shm`, Buffer.alloc(32_768));

      mapping = startJob(
        join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", pinSharedMemory],
        {
          ...process.env,
          OMNESIS_SQLITE_SHM: `${path}-shm`,
          OMNESIS_SQLITE_READY: mappingReady,
          OMNESIS_SQLITE_RELEASE: release,
        },
        deadline,
      );
      jobs.push(mapping);
      await ready(mappingReady, mapping, deadline);
      const db = open();
      try {
        expect(db.prepare("SELECT id,body FROM notes").all()).toEqual([
          { id: 1, body: "invented durable note" },
        ]);
        db.prepare("INSERT INTO notes VALUES(2,'invented next note')").run();
        expect(db.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 2 });
        expect(mapping.settled, "recovery must succeed before the stale view is released").toBe(
          false,
        );
      } finally {
        db.close();
      }
      writeFileSync(release, "release");
      const unmapped = await mapping.work;
      expect(ownedProcessCleanupReceipt(unmapped)).toBeUndefined();
      expect(unmapped.failure).toBeUndefined();
      expect(unmapped.exitCode).toBe(0);
    } catch (error) {
      primaryFailed = true;
      primaryFailure = error;
      if (
        mapping &&
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SQLITE_IOERR_TRUNCATE"
      ) {
        // A failing baseline must still prove its committed WAL is readable
        // after the deliberately stale mapping is released.
        writeFileSync(release, "release");
        const result = await mapping.work;
        if (ownedProcessCleanupReceipt(result)) throw result;
        expect(result.exitCode).toBe(0);
        const control = open();
        try {
          expect(control.prepare("SELECT id,body FROM notes").all()).toEqual([
            { id: 1, body: "invented durable note" },
          ]);
        } finally {
          control.close();
        }
      }
      throw error;
    } finally {
      await closeFixtureJobs(jobs, root, primaryFailed, primaryFailure);
    }
  },
  35_000,
);
