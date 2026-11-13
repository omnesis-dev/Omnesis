// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import { createFilterListSweepTask } from "./filter-list-sweep.js";
import type { FilterListKey } from "../../data/repositories/SourceFilterListRepository.js";

const log = createLogger("test");
const ctx = {
  shouldYield: () => false,
  elapsedMs: () => 0,
  signal: new AbortController().signal,
  log,
};

const at = (sourceId: string): FilterListKey => ({
  sourceId,
  field: "extra.folderIds",
  deviceId: "",
});

function taskOver(answers: Array<{ deleted: number; cursor: FilterListKey | null } | Error>) {
  const calls: Array<{ cursor: FilterListKey | null; limit: number }> = [];
  const task = createFilterListSweepTask({
    log,
    batchSize: 50,
    writeGate: {
      sweepFilterListRows: async (cursor, limit) => {
        calls.push({ cursor, limit });
        const answer = answers.shift() ?? { deleted: 0, cursor: null };
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  });
  const tick = async () => {
    const outcome = await task.run(undefined, ctx);
    return (outcome as { kind: "done"; value: { idle: boolean } }).value.idle;
  };
  return { task, calls, tick };
}

describe("the filter list sweep", () => {
  it("does one bounded writer operation per tick and carries on from where it stopped", async () => {
    const { calls, tick } = taskOver([
      { deleted: 50, cursor: at("filing:a") },
      { deleted: 50, cursor: at("filing:b") },
      { deleted: 3, cursor: null },
    ]);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(calls).toEqual([
      { cursor: null, limit: 50 },
      { cursor: at("filing:a"), limit: 50 },
      { cursor: at("filing:b"), limit: 50 },
    ]);
  });

  it("rests only after a whole pass that deleted nothing", async () => {
    const { tick } = taskOver([
      { deleted: 2, cursor: null },
      { deleted: 0, cursor: at("filing:a") },
      { deleted: 0, cursor: null },
    ]);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(true);
  });

  it("goes idle on a failure and starts again where it was", async () => {
    const { calls, tick } = taskOver([
      { deleted: 1, cursor: at("filing:a") },
      new Error("writer unavailable"),
      { deleted: 0, cursor: null },
    ]);
    await tick();
    expect(await tick()).toBe(true);
    await tick();
    expect(calls.map((call) => call.cursor)).toEqual([null, at("filing:a"), at("filing:a")]);
  });

  it("runs in the background", () => {
    const { task } = taskOver([]);
    expect(task.priority).toBe("background");
    expect(task.name).toBe("filterLists.sweep.tick");
  });
});
