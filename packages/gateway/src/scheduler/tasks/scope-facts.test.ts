// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { scopeFactsBackfillTask } from "./scope-facts.js";

describe("scope facts periodic", () => {
  it("runs one admitted bounded writer batch and backs off only after work is complete", async () => {
    const writeGate = {
      backfillDocumentScopes: vi
        .fn()
        .mockResolvedValueOnce({ processed: 2, sourcesCompleted: 0, subjectsResolved: 0 })
        .mockResolvedValueOnce({ processed: 0, sourcesCompleted: 0, subjectsResolved: 0 }),
    };
    const deps = {
      writeGate,
      peopleBatchSize: 2,
      peopleBatchIntervalMs: 1000,
      peopleIdleDelayMs: 60000,
      log: createLogger("test:scope-facts"),
    } satisfies Parameters<typeof scopeFactsBackfillTask>[0];
    const task = scopeFactsBackfillTask(deps);
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
