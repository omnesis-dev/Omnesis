// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { getActivePriority, runWithPriority } from "../priority.js";
import { createActivityRetentionTask } from "./task.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { TaskContext } from "../scheduler/types.js";
import type { WriteGate } from "../write-gate.js";
import type { FsCognitionTranscriptStore } from "../brain/transcripts.js";

const context = {} as TaskContext;

function harness(initial: OmnesisConfig = {}) {
  let config = initial;
  const dbPriorities: Array<ReturnType<typeof getActivePriority>> = [];
  const conversationPriorities: Array<ReturnType<typeof getActivePriority>> = [];
  const pruneDb = vi.fn((phase: string) => {
    dbPriorities.push(getActivePriority());
    return Promise.resolve({ phase, deleted: 0, hasMore: false });
  });
  const reclaimPages = vi.fn(() => Promise.resolve(0));
  const pruneTranscripts = vi.fn(() => Promise.resolve({ deleted: 0, hasMore: false }));
  const pruneConversations = vi.fn(() => {
    conversationPriorities.push(getActivePriority());
    return Promise.resolve({ deleted: 0, hasMore: false });
  });
  const bundle = createActivityRetentionTask(
    {
      writeGate: {
        pruneActivityRetentionBatch: pruneDb,
        reclaimActivityRetentionPages: reclaimPages,
      } as unknown as WriteGate,
      transcripts: { pruneBatch: pruneTranscripts } as unknown as FsCognitionTranscriptStore,
      pruneConversations,
      getConfig: () => config,
      log: createLogger("test:activity-retention"),
      clock: () => 10_000,
      startDelayMs: 0,
    },
    {} as Scheduler,
  );
  return {
    ...bundle,
    pruneDb,
    dbPriorities,
    reclaimPages,
    pruneTranscripts,
    pruneConversations,
    conversationPriorities,
    setConfig(next: OmnesisConfig) {
      config = next;
    },
  };
}

describe("activity retention task", () => {
  test("is inert and reports idle when the policy is omitted", async () => {
    const h = harness();
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(h.pruneDb).not.toHaveBeenCalled();
    expect(h.pruneTranscripts).not.toHaveBeenCalled();
    expect(h.pruneConversations).not.toHaveBeenCalled();
  });

  test("performs at most one bounded reclaim unit per tick", async () => {
    const h = harness({ activityRetention: { maxAge: "1s" } });
    h.pruneDb
      .mockResolvedValueOnce({ phase: "cognitionRuns", deleted: 100, hasMore: true })
      .mockResolvedValueOnce({ phase: "cognitionRuns", deleted: 1, hasMore: false });

    await h.task.run(undefined, context);
    expect(h.pruneDb).toHaveBeenCalledTimes(1);
    expect(h.pruneDb).toHaveBeenLastCalledWith("cognitionRuns", 9_000, 100);
    await h.task.run(undefined, context);
    expect(h.pruneDb).toHaveBeenCalledTimes(2);
    expect(h.pruneTranscripts).not.toHaveBeenCalled();
  });

  test("an explicit legacy transcript window keeps its original transcript-only scope", async () => {
    const h = harness({ brain: { transcriptRetention: "2s" } });
    for (let i = 0; i < 9; i += 1) await h.task.run(undefined, context);

    expect(h.pruneDb).not.toHaveBeenCalled();
    expect(h.pruneTranscripts).toHaveBeenCalledWith(8_000, 100);
    expect(h.pruneConversations).not.toHaveBeenCalled();
    expect(h.reclaimPages).not.toHaveBeenCalled();
  });

  test("reads config live so enabling the policy takes effect without reconstruction", async () => {
    const h = harness();
    await h.task.run(undefined, context);
    h.setConfig({ activityRetention: { maxAge: "1s" } });
    await h.task.run(undefined, context);
    expect(h.pruneDb).toHaveBeenCalledWith("cognitionRuns", 9_000, 100);
  });

  test("overrides a config request's inherited user priority", async () => {
    const h = harness({ activityRetention: { maxAge: "1s" } });
    await runWithPriority("user", () => h.task.run(undefined, context));

    expect(h.dbPriorities).toEqual(["background"]);
  });

  test("conversation cascades run one at a time at background priority", async () => {
    const h = harness({ activityRetention: { maxAge: "1s" } });
    // One run advances one phase, so reaching a given phase takes as many runs
    // as its place in the rotation.
    for (let i = 0; i < 6; i += 1) await h.task.run(undefined, context);

    expect(h.pruneConversations).toHaveBeenCalledWith(9_000, 1);
    expect(h.conversationPriorities).toEqual(["background"]);
  });

  test("continues the transcript phase while its bounded directory scan has more entries", async () => {
    const h = harness({ activityRetention: { maxAge: "1s" } });
    h.pruneTranscripts
      .mockResolvedValueOnce({ deleted: 0, hasMore: true })
      .mockResolvedValueOnce({ deleted: 0, hasMore: false });
    for (let i = 0; i < 5; i += 1) await h.task.run(undefined, context);
    expect(h.pruneTranscripts).toHaveBeenCalledTimes(1);
    await h.task.run(undefined, context);
    expect(h.pruneTranscripts).toHaveBeenCalledTimes(2);
  });
});
