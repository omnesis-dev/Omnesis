// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  isStateEnvelope,
  syncPage,
  withVersionedState,
  type SourceInstance,
  type SourceStateSpec,
  type StateOutcome,
  type SyncCursor,
} from "@omnesis/source-sdk";
import {
  appleNotesStateSpec,
  appleContactsStateSpec,
  appleRemindersStateSpec,
  appleCalendarStateSpec,
  appleCallLogStateSpec,
  appleVoicemailStateSpec,
  appleImessageStateSpec,
} from "./state.js";

/** A fake instance that records what it was handed and returns a fixed next cursor. */
function recordingInstance(next: SyncCursor) {
  const seen: (SyncCursor | null)[] = [];
  const instance: SourceInstance = {
    sync: async (cursor) => {
      seen.push(cursor);
      return syncPage([], next);
    },
  };
  return { instance, seen };
}

/**
 * Exercises the three things every Apple source's spec must get right,
 * driven through `withVersionedState` (the host's decorator) rather than
 * `sync` directly, since resolving the stored value is the host's job.
 */
function testsCommonToEverySpec(
  sourceId: string,
  spec: SourceStateSpec,
  settledCursor: SyncCursor,
  midCycleCursor: SyncCursor,
) {
  test("a first run resolves fresh, then resumes from the written-back envelope", async () => {
    const { instance, seen } = recordingInstance(settledCursor);
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, spec, {
      sourceId,
      onResolve: (o) => outcomes.push(o),
    });

    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(seen).toEqual([null, settledCursor]);
  });

  test("a mid-cycle cursor resumes, not rebootstraps", async () => {
    const { instance, seen } = recordingInstance(settledCursor);
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, spec, {
      sourceId,
      onResolve: (o) => outcomes.push(o),
    });

    const envelope = { e: 1, v: spec.version, s: sourceId, state: midCycleCursor };
    await versioned.sync(envelope as unknown as SyncCursor);

    expect(outcomes[0]?.kind).toBe("resume");
    expect(seen).toEqual([midCycleCursor]);
  });

  test("an unrecognised stored value rebootstraps rather than parking the source", async () => {
    const { instance, seen } = recordingInstance(settledCursor);
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, spec, {
      sourceId,
      onResolve: (o) => outcomes.push(o),
    });

    const garbage = { e: 1, v: spec.version, s: sourceId, state: { notARecognisedField: true } };
    await versioned.sync(garbage as unknown as SyncCursor);

    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(seen).toEqual([null]);
  });
}

describe("appleNotesStateSpec", () => {
  testsCommonToEverySpec(
    "apple-notes:local",
    appleNotesStateSpec,
    { lastModifiedTimestamp: 700 },
    // Mid-bootstrap: a queue total pinned and a tie-breaker for the page
    // boundary, no snapshot signature yet (only computed on the final page).
    { lastModifiedTimestamp: 400, lastModifiedPk: 12, cycleQueueTotal: 900 },
  );
});

describe("appleContactsStateSpec", () => {
  testsCommonToEverySpec(
    "apple-contacts:local",
    appleContactsStateSpec,
    { lastModifiedTimestamp: 700 },
    {
      lastModifiedTimestamp: 400,
      lastUniqueId: "ABCD-1234",
      bootstrapInProgress: true,
      cycleQueueTotal: 300,
    },
  );
});

describe("appleRemindersStateSpec", () => {
  testsCommonToEverySpec(
    "apple-reminders:local",
    appleRemindersStateSpec,
    { lastModifiedTimestamp: 700 },
    { lastModifiedTimestamp: 400, lastModifiedPk: 3, cycleQueueTotal: 50 },
  );
});

describe("appleCalendarStateSpec", () => {
  testsCommonToEverySpec(
    "apple-calendar:local",
    appleCalendarStateSpec,
    { lastModifiedTimestamp: 700 },
    // Mid-bootstrap page position, with the cycle's own ROWID ceiling pinned
    // and the insertion high-water mark from the prior completed cycle.
    {
      lastModifiedTimestamp: 200,
      insertRowIdHighWater: 500,
      cycleRowIdCeiling: 900,
      pageModKey: 350,
      pageRowId: 640,
      bootstrapInProgress: true,
      cycleQueueTotal: 120,
    },
  );
});

describe("appleCallLogStateSpec", () => {
  testsCommonToEverySpec(
    "apple-call-log:local",
    appleCallLogStateSpec,
    { lastModifiedTimestamp: 700, lastSnapshotSignature: "3:700:9:2100", affectedDates: [] },
    {
      lastModifiedTimestamp: 200,
      insertRowIdHighWater: 500,
      cycleRowIdCeiling: 900,
      pageModKey: 350,
      pageRowId: 640,
      bootstrapInProgress: true,
      cycleQueueTotal: 40,
      lastSnapshotSignature: "1:200:5:200",
      affectedDates: ["2026-08-30", "2026-08-31"],
    },
  );

  test("decode rejects a non-string entry in affectedDates", () => {
    expect(
      appleCallLogStateSpec.decode({
        lastModifiedTimestamp: 1,
        affectedDates: [1, 2],
      }),
    ).toBeNull();
  });
});

describe("appleVoicemailStateSpec", () => {
  // Voicemail has no incremental watermark and no partial-page state — every
  // sync re-reads the whole table in one page (`hasMore` is always false), so
  // there is no mid-cycle shape distinct from a settled one. The map itself
  // can still hold many entries, which is what the second argument exercises.
  testsCommonToEverySpec(
    "apple-voicemail:local",
    appleVoicemailStateSpec,
    { daySignatures: { "2026-09-01": "abc123" } },
    { daySignatures: { "2026-08-01": "aaa", "2026-08-02": "bbb", "2026-08-03": "ccc" } },
  );
});

describe("appleImessageStateSpec", () => {
  testsCommonToEverySpec(
    "apple-imessage:local",
    appleImessageStateSpec,
    { lastRowId: 5000 },
    // Mid-bootstrap: a queue total pinned, and per-chat-day signatures
    // already accumulated from an earlier settled cycle.
    {
      lastRowId: 2500,
      cycleQueueTotal: 8000,
      lastSnapshotSignature: "abc",
      lastDaySignatures: { "+15550100:2026-08-01": "sig-a", "chat123:2026-08-02": "sig-b" },
    },
  );

  test("decode rejects a lastDaySignatures value with a non-string entry", () => {
    expect(
      appleImessageStateSpec.decode({
        lastRowId: 1,
        lastDaySignatures: { "chat:2026-01-01": 5 },
      }),
    ).toBeNull();
  });
});
