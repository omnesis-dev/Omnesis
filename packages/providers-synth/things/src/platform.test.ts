// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { loadTasks, mapTask } from "./fixtures.js";
import synthThings from "./index.js";

describe("synth things — cross-platform on the wire", () => {
  it("clears supportedPlatforms inherited from the real Things provider", () => {
    // Real `defineSource` for Things declares `supportedPlatforms: ["darwin"]`.
    // The synth file spreads `...rest` from it, so the explicit override
    // here is what lets synth fixtures run on non-Darwin CI hosts.
    expect(synthThings.supportedPlatforms).toBeUndefined();
  });

  it("uses the production projections and emits projectable due/status metadata", () => {
    expect(synthThings.documentTemporalProjections?.map((spec) => spec.slot)).toEqual([
      "scheduled",
      "due",
    ]);
    const entries = loadTasks();
    const bothDates = entries.find((entry) => entry.scheduledAt && entry.deadline)!;
    const completed = entries.find((entry) => entry.status === "done" && entry.deadline)!;
    const undated = entries.find((entry) => !entry.scheduledAt && !entry.deadline)!;
    const ctx = {
      sourceId: SourceId("things:local"),
      providerId: ProviderId("things:local"),
    };

    expect(mapTask(bothDates, ctx).metadata).toMatchObject({
      scheduledAt: bothDates.scheduledAt,
      dueAt: bothDates.deadline?.slice(0, 10),
      status: "open",
      extra: {
        scheduled: bothDates.scheduledAt,
        deadline: bothDates.deadline?.slice(0, 10),
      },
    });
    expect(mapTask(completed, ctx).metadata).toMatchObject({
      dueAt: completed.deadline?.slice(0, 10),
      status: "completed",
    });
    expect(mapTask({ ...bothDates, status: "cancelled" }, ctx).metadata.status).toBe("canceled");
    expect(mapTask(undated, ctx).metadata).toMatchObject({
      scheduledAt: undefined,
      dueAt: undefined,
      status: "open",
    });
  });
});
