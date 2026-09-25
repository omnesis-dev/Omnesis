// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { NearDupDfStagingWorker } from "./NearDupDfStagingWorker.js";

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-df-staging-worker-"));
  dirs.push(dir);
  return join(dir, "staging.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("NearDupDfStagingWorker", () => {
  test.each(["clear", "encrypted"] as const)(
    "accumulates cross-page DF and closes its %s database before finish resolves",
    async (mode) => {
      const path = tempPath();
      const key = mode === "encrypted" ? randomBytes(32) : undefined;
      const worker = new NearDupDfStagingWorker({
        stagingPath: path,
        ...(key ? { stagingKey: key } : {}),
      });
      try {
        await worker.add([
          {
            docsProcessed: 1,
            shingleCounts: [
              ["alpha", 1],
              ["singleton", 1],
            ],
          },
          {
            docsProcessed: 1,
            shingleCounts: [
              ["alpha", 1],
              ["bravo", 1],
            ],
          },
        ]);
        await worker.add([
          { docsProcessed: 1, shingleCounts: [["bravo", 1]] },
          { docsProcessed: 0, shingleCounts: [] },
        ]);

        await expect(worker.finish(2)).resolves.toEqual({
          totalDocs: 3,
          uniqueShingles: 2,
        });

        const db = key
          ? (openEncryptedSqlite(path, {
              key,
              readonly: true,
              fileMustExist: true,
            }) as unknown as Database.Database)
          : new Database(path, { readonly: true, fileMustExist: true });
        try {
          expect(db.prepare("SELECT shingle, df FROM df ORDER BY shingle").all()).toEqual([
            { shingle: "alpha", df: 2 },
            { shingle: "bravo", df: 2 },
            { shingle: "singleton", df: 1 },
          ]);
        } finally {
          db.close();
        }
      } finally {
        await worker.dispose();
      }
    },
  );

  test("keeps the gateway event loop moving while a staging batch is written", async () => {
    const worker = new NearDupDfStagingWorker({ stagingPath: tempPath() });
    try {
      // Cross the startup handshake first: the immediate below must overlap
      // the staging operation itself, not merely worker boot.
      await worker.add([]);
      const pairs = Array.from(
        { length: 40_000 },
        (_, index) => [`shingle-${String(index).padStart(6, "0")}`, 1] as [string, number],
      );
      let settled = false;
      const add = worker
        .add([{ docsProcessed: 1, shingleCounts: pairs }])
        .finally(() => (settled = true));

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await add;

      settled = false;
      const finish = worker.finish(1).finally(() => (settled = true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await expect(finish).resolves.toEqual({ totalDocs: 1, uniqueShingles: pairs.length });
    } finally {
      await worker.dispose();
    }
  });

  test("rejects operations after disposal without leaving a timed-out request", async () => {
    const worker = new NearDupDfStagingWorker({ stagingPath: tempPath() });
    await worker.dispose();
    await expect(worker.add([])).rejects.toThrow("disposed");
    await expect(worker.finish(1)).rejects.toThrow("disposed");
  });

  test("rejects initialization errors and still disposes promptly", async () => {
    const worker = new NearDupDfStagingWorker({
      stagingPath: join(tempPath(), "missing", "staging.sqlite"),
    });
    // Delay the consumer to exercise the teardown race around worker startup.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(worker.add([])).rejects.toThrow();
    await expect(worker.dispose()).resolves.toBeUndefined();
  });
});
