// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { Scheduler } from "../scheduler.js";
import { derivationSlaTasks } from "./derivation-sla.js";

it("warns for old pending generations, not freshly rewritten old documents", async () => {
  const db = new Database(":memory:");
  const scheduler = new Scheduler({ enablePreemption: false });
  const log = createLogger("derivation-age-test");
  const warn = vi.spyOn(log, "warn");
  const info = vi.spyOn(log, "info");
  const now = Date.parse("2026-08-09T12:00:00Z");
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY, ingested_at TEXT, updated_at TEXT,
    links_extracted_at TEXT, people_resolved_at TEXT, dates_extracted_at TEXT
  )`);
  db.prepare("INSERT INTO documents(id,ingested_at,updated_at) VALUES('rewritten',?,?)").run(
    new Date(now - 7 * 86_400_000).toISOString(),
    new Date(now - 60_000).toISOString(),
  );
  const { tasks } = derivationSlaTasks(
    { db, log, clock: () => now, getBarrierMs: () => 30 * 60_000, isBarrierActive: () => true },
    scheduler,
  );
  const context = {
    shouldYield: () => false,
    elapsedMs: () => 0,
    signal: new AbortController().signal,
    log,
  };
  try {
    for (const task of tasks) await task.run(undefined, context);
    expect(warn).not.toHaveBeenCalled();
    db.prepare("INSERT INTO documents(id,ingested_at,updated_at) VALUES('delayed',?,?)").run(
      new Date(now - 3 * 3_600_000).toISOString(),
      new Date(now - 3 * 3_600_000).toISOString(),
    );
    for (const task of tasks) await task.run(undefined, context);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(
      warn.mock.calls.every(([message]) => String(message).includes("oldest waiting 180m")),
    ).toBe(true);
    db.prepare(
      "UPDATE documents SET links_extracted_at=?, people_resolved_at=?, dates_extracted_at=? WHERE id='delayed'",
    ).run(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
    for (const task of tasks) await task.run(undefined, context);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenCalledTimes(3);
  } finally {
    await scheduler.dispose();
    db.close();
  }
});
