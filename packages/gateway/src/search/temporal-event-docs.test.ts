// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { eventDocumentsInWindows, type TemporalIndexReader } from "./temporal-event-docs.js";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";
import type { TemporalWindow } from "./temporal-intent.js";

const WINDOW: TemporalWindow = {
  startDay: "2026-10-08",
  endDay: "2026-10-09",
  startMs: Date.parse("2026-10-07T23:00:00Z"),
  endExclusiveMs: Date.parse("2026-10-08T23:00:00Z"),
  text: "tomorrow",
};

function item(id: string, provenance: Partial<TemporalItem>, anchored = true): TemporalItem {
  return {
    id,
    origin: provenance.mention ? "mention" : provenance.annotation ? "annotation" : "projection",
    start: "2026-10-08T09:00:00.000Z",
    endExclusive: "2026-10-08T10:00:00.000Z",
    anchored,
    precision: "instant",
    allDay: false,
    label: id,
    kind: "event",
    modality: "scheduled",
    status: "active",
    ...provenance,
  } as TemporalItem;
}

/** A reader answering each window in turn with the next list of items. */
function reader(answers: TemporalItem[][], seen: TemporalQueryInput[] = []): TemporalIndexReader {
  let i = 0;
  return {
    async anchoredItems(input) {
      seen.push(input);
      return answers[i++] ?? [];
    },
  };
}

describe("eventDocumentsInWindows", () => {
  const mention = (id: string, documentId: string) =>
    item(id, { mention: { documentId, sourceId: "s", text: "8 Oct", relative: false } });

  it("collects every origin's documents per window, in order, once each", async () => {
    const seen: TemporalQueryInput[] = [];
    const second: TemporalWindow = {
      ...WINDOW,
      startMs: WINDOW.startMs + 86_400_000,
      endExclusiveMs: WINDOW.endExclusiveMs + 86_400_000,
    };
    const ids = await eventDocumentsInWindows(
      reader(
        [
          [
            item("p1", {
              projection: { documentId: "doc-calendar" } as TemporalItem["projection"],
            }),
            mention("m1", "doc-email"),
            // An analytics projection bound to no document contributes nothing.
            item("p2", { projection: {} as TemporalItem["projection"] }),
          ],
          [
            item("a1", {
              annotation: {
                documentIds: ["doc-note", "doc-email"],
              } as TemporalItem["annotation"],
            }),
          ],
        ],
        seen,
      ),
      [WINDOW, second],
      "Europe/London",
      ["gmail:maya@example.com"],
    );
    expect(ids).toEqual(["doc-calendar", "doc-email", "doc-note"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      from: "2026-10-07T23:00:00.000Z",
      to: "2026-10-08T23:00:00.000Z",
      timeZone: "Europe/London",
      origins: ["projection", "annotation", "mention"],
      limit: 100,
      sourceIds: ["gmail:maya@example.com"],
    });
  });

  it("reads every source when the search names none", async () => {
    const seen: TemporalQueryInput[] = [];
    await eventDocumentsInWindows(reader([[]], seen), [WINDOW], "UTC", undefined);
    expect(seen[0]!.sourceIds).toBeUndefined();
  });

  it("keeps what it read when the time index fails", async () => {
    let calls = 0;
    const failing: TemporalIndexReader = {
      async anchoredItems() {
        calls++;
        if (calls > 1) throw new Error("analytics store unavailable");
        return [mention("m1", "doc-email")];
      },
    };
    expect(
      await eventDocumentsInWindows(failing, [WINDOW, WINDOW], "Europe/London", undefined),
    ).toEqual(["doc-email"]);
  });
});
