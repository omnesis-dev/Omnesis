// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage check for `IoOps` ↔ `ioHandlers`.
 *
 * The type system already enforces `IO_OP_DEFS[].name: ComputeOpName`,
 * so a misspelling fails at compile time. This file exercises the same
 * invariant at runtime as a belt-and-suspenders against `as` casts or
 * any-typed handlers that could in theory slip through.
 */

import { describe, expect, test } from "vitest";
import { IoOps } from "./io-ops.js";
import { ioHandlers } from "./io-handlers.js";

describe("IoOps registry coverage", () => {
  test("every IoOps entry has a matching handler in ioHandlers", () => {
    const handlerNames = new Set(Object.keys(ioHandlers));
    for (const [name, task] of IoOps) {
      expect(handlerNames, `IoOps "${name}" missing from handler registry`).toContain(name);
      expect(task.runner).toBe("io");
    }
  });

  test("every handler in ioHandlers has a IoOps entry (no orphan handlers)", () => {
    const opNames = new Set(IoOps.keys());
    for (const name of Object.keys(ioHandlers)) {
      expect(opNames, `ioHandlers "${name}" missing from IO_OP_DEFS`).toContain(name);
    }
  });
});
