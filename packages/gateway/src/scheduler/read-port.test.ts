// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { directReadPort, ioReadHandlers, ioReadOpNames, ioReadPort } from "./read-port.js";

const READS = {
  fixtureCount: (db: Database.Database, kind: string) =>
    db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM fixture WHERE kind=?").get(kind)!
      .n,
  fixtureFails: (_db: Database.Database): number => {
    throw new Error("fixture read failed");
  },
};

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE fixture(kind TEXT); INSERT INTO fixture VALUES('note'),('note'),('task')");
});
afterEach(() => db.close());

it("runs each read on the caller's handle, and turns a throw into a rejection", async () => {
  const port = directReadPort(READS, db);
  expect(await port.fixtureCount("note")).toBe(2);
  const pending = port.fixtureFails();
  expect(pending).toBeInstanceOf(Promise);
  await expect(pending).rejects.toThrow("fixture read failed");
});

it("names each read's io op and hands the worker the same function", () => {
  expect(ioReadOpNames(READS)).toEqual(["io.fixtureCount", "io.fixtureFails"]);
  const handlers = ioReadHandlers(READS);
  expect(handlers["io.fixtureCount"]).toBe(READS.fixtureCount);
  expect(handlers["io.fixtureCount"](db, "task")).toBe(1);
});

it("enqueues each read as its io op with the caller's arguments", async () => {
  const call = vi.fn(async () => 7);
  const port = ioReadPort(READS, call);
  expect(await port.fixtureCount("note")).toBe(7);
  expect(call).toHaveBeenCalledWith("io.fixtureCount", ["note"]);
});
