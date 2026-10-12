// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { TaskService } from "./service.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00");
let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function service() {
  const calls: string[] = [];
  const gate = directWriteGate(db);
  const tasks = new TaskService(db, gate, () => NOW, {
    writeGate: {
      cancelScheduledRunsForLoop: async (id) => {
        calls.push(`cancel ${id}`);
        return 0;
      },
      dropObservationsForResolvedLoop: async (id) => {
        calls.push(`drop ${id}`);
        return [];
      },
    },
    mirror: {
      refresh: async (id) => {
        calls.push(`refresh ${id}`);
      },
      remove: async (ids) => {
        calls.push(`remove ${ids.join(",")}`);
      },
    },
  });
  return { tasks, calls };
}

const origin = { surface: "tasks", runId: "user:tasks" } as const;

describe("TaskService effects", () => {
  test("a change refreshes the loop mirror", async () => {
    const { tasks, calls } = service();
    await tasks.apply({
      ...origin,
      kind: "create",
      id: "loop_a",
      origin: "user",
      title: "Buy stamps",
    });
    await tasks.apply({ ...origin, kind: "migrate", id: "loop_a", to: "2026-03-12" });
    expect(calls).toEqual(["refresh loop_a", "refresh loop_a"]);
  });

  test("resolving a task retracts its checks and drops its observations", async () => {
    const { tasks, calls } = service();
    await tasks.apply({
      ...origin,
      kind: "create",
      id: "loop_a",
      origin: "user",
      title: "Buy stamps",
    });
    calls.length = 0;
    await tasks.apply({ ...origin, kind: "complete", id: "loop_a" });
    expect(calls).toEqual(["refresh loop_a", "cancel loop_a", "drop loop_a"]);
  });

  test("deleting a task removes its mirror and checks", async () => {
    const { tasks, calls } = service();
    await tasks.apply({
      ...origin,
      kind: "create",
      id: "loop_a",
      origin: "user",
      title: "Buy stamps",
    });
    calls.length = 0;
    await tasks.apply({ ...origin, kind: "delete", id: "loop_a" });
    expect(calls).toEqual(["remove loop_a", "cancel loop_a"]);
  });

  test("a refused command has no effects", async () => {
    const { tasks, calls } = service();
    const result = await tasks.apply({ ...origin, kind: "complete", id: "loop_missing" });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
