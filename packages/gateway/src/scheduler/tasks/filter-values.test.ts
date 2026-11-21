// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import { createFilterValuesTask } from "./filter-values.js";
import type { FilterValueWork } from "../../access/filter-values.js";

const log = createLogger("test");
const ctx = {
  shouldYield: () => false,
  elapsedMs: () => 0,
  signal: new AbortController().signal,
  log,
};

const work = (documentId: string): FilterValueWork => ({
  documentId,
  revision: 1,
  document: null,
  declaration: "",
  cut: null,
});

/** A task over scripted answers, recording each call it makes in order. */
function taskOver(answers: {
  levels: Array<number | null>;
  work: FilterValueWork[][];
  passes: boolean[];
}) {
  const calls: string[] = [];
  const task = createFilterValuesTask({
    log,
    batchSize: 10,
    ioGate: {
      filterPostingLevelToMerge: async () => {
        calls.push("level?");
        return answers.levels.shift() ?? null;
      },
      filterValueWork: async (limit) => {
        calls.push(`work(${limit})`);
        return answers.work.shift() ?? [];
      },
    },
    writeGate: {
      mergeFilterPostings: async (level) => {
        calls.push(`merge(${level})`);
      },
      applyFilterValueWork: async (items) => {
        calls.push(`apply(${items.length})`);
        return { applied: items.length };
      },
      advanceFilterValuePasses: async (limit) => {
        calls.push(`pass(${limit})`);
        const changed = answers.passes.shift() ?? false;
        return { queued: changed ? limit : 0, changed };
      },
    },
  });
  const tick = async () => {
    const outcome = await task.run(undefined, ctx);
    return (outcome as { kind: "done"; value: { idle: boolean } }).value.idle;
  };
  return { task, calls, tick };
}

describe("the filter values task", () => {
  it("merges a full level before anything else, one merge per tick", async () => {
    const { calls, tick } = taskOver({ levels: [1, 0, null], work: [[work("d-1")]], passes: [] });
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(calls).toEqual([
      "level?",
      "merge(1)",
      "level?",
      "merge(0)",
      "level?",
      "work(10)",
      "apply(1)",
    ]);
  });

  it("cuts queued records, then advances a pass, and rests once neither has anything", async () => {
    const { calls, tick } = taskOver({
      levels: [],
      work: [[work("d-1"), work("d-2")]],
      passes: [true],
    });
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(true);
    expect(calls).toEqual([
      "level?",
      "work(10)",
      "apply(2)",
      "level?",
      "work(10)",
      "pass(10)",
      "level?",
      "work(10)",
      "pass(10)",
    ]);
  });
});
