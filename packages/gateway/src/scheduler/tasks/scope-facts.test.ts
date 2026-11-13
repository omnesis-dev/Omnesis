// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { scopeFactsBackfillTask } from "./scope-facts.js";

describe("scope facts periodic", () => {
  it("stays off the writer until filters are in use, then runs one bounded batch per tick and backs off when complete", async () => {
    const writeGate = {
      backfillDocumentScopes: vi
        .fn()
        .mockResolvedValueOnce({ processed: 2, sourcesCompleted: 0, subjectsResolved: 0 })
        .mockResolvedValueOnce({ processed: 0, sourcesCompleted: 0, subjectsResolved: 0 }),
    };
    let inUse = false;
    const deps = {
      writeGate,
      sourceFiltersInUse: () => inUse,
      peopleBatchSize: 2,
      peopleBatchIntervalMs: 1000,
      peopleIdleDelayMs: 60000,
      log: createLogger("test:scope-facts"),
    } satisfies Parameters<typeof scopeFactsBackfillTask>[0];
    const task = scopeFactsBackfillTask(deps);
    // An install without filters never reaches the writer, and starts by itself once it has them.
    expect(await task.run(undefined, undefined as never)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(writeGate.backfillDocumentScopes).not.toHaveBeenCalled();
    inUse = true;
    expect(await task.run(undefined, undefined as never)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(writeGate.backfillDocumentScopes).toHaveBeenCalledExactlyOnceWith(2);
    expect(await task.run(undefined, undefined as never)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(writeGate.backfillDocumentScopes).toHaveBeenCalledTimes(2);
  });
});
