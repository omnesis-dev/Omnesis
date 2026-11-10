// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage check for `IoOps` ↔ `ioHandlers`, `ioJournalHandlers` and
 * `ioSqlHandlers`.
 *
 * The type system already enforces `IO_OP_DEFS[].name: ComputeOpName`,
 * so a misspelling fails at compile time. This file exercises the same
 * invariant at runtime as a belt-and-suspenders against `as` casts or
 * any-typed handlers that could in theory slip through.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { IoOps } from "./io-ops.js";
import { ioHandlers } from "./io-handlers.js";
import { ioReadOpNames } from "./read-port.js";
import { IO_READS } from "./io-read-ports.js";
import { ioJournalHandlers } from "./io-journal-handlers.js";
import { ioSqlHandlers } from "./io-sql-handlers.js";

const allHandlers = { ...ioHandlers, ...ioJournalHandlers, ...ioSqlHandlers };

describe("IoOps registry coverage", () => {
  test("every IoOps entry has a matching handler", () => {
    const handlerNames = new Set(Object.keys(allHandlers));
    for (const [name, task] of IoOps) {
      expect(handlerNames, `IoOps "${name}" missing from handler registry`).toContain(name);
      expect(task.runner).toBe("io");
    }
  });

  test("every handler has a IoOps entry (no orphan handlers)", () => {
    const opNames = new Set(IoOps.keys());
    for (const name of Object.keys(allHandlers)) {
      expect(opNames, `handler "${name}" missing from IO_OP_DEFS`).toContain(name);
    }
  });

  test("no op name is served from two handles", () => {
    const tables = [ioHandlers, ioJournalHandlers, ioSqlHandlers].map((t) => Object.keys(t));
    const names = tables.flat();
    expect(new Set(names).size).toBe(names.length);
  });
});

test("no written-out io op shares a name with a read port's op", () => {
  // A written-out op of the same name would silently replace the port's.
  const portOps = ioReadOpNames(IO_READS);
  expect(portOps.length).toBeGreaterThan(0);
  const ioHandlersSource = readFileSync(new URL("./io-handlers.ts", import.meta.url), "utf8");
  for (const op of portOps) expect(ioHandlersSource, op).not.toContain(`"${op}"`);
});

test("discovery monthly scan is a background IO task with a matching reader", () => {
  expect(IoOps.get("io.knowledgeDiscoveryByMonth")?.runner).toBe("io");
  expect(typeof ioHandlers["io.knowledgeDiscoveryByMonth"]).toBe("function");
});
