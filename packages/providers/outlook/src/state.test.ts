// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  emptySync,
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { createMockGraph, createOutlookEmailSource } from "./testing/mock-outlook.js";
import { OneDriveSource } from "./onedrive.js";
import { OutlookCalendarSource } from "./outlook-calendar.js";
import { outlookEmailStateSpec, outlookCalendarStateSpec, oneDriveStateSpec } from "./state.js";
import type { CalendarGraphClientLike } from "./outlook-calendar-types.js";
import type { DriveDeltaResponse } from "./onedrive-types.js";

function emailInstance(): SourceInstance {
  const source = createOutlookEmailSource(createMockGraph());
  return { sync: (cursor) => source.sync(cursor as never) };
}

describe("installed Outlook calendar snapshot migration", () => {
  it("finishes the legacy page without a snapshot then re-enumerates the original window", async () => {
    const graph = {
      get: vi.fn(async (path: string) =>
        path.startsWith("/me/calendars?")
          ? {
              value: [
                { id: "first", name: "Primary" },
                { id: "second", name: "Projects" },
              ],
            }
          : { value: [], "@odata.deltaLink": "https://graph.microsoft.com/delta/next" },
      ),
    };
    const wrapped = withVersionedState(calendarInstance(graph), outlookCalendarStateSpec, {
      sourceId: "outlook-calendar:tester",
    });
    const first = await wrapped.sync({
      calendarLinks: { first: "https://graph.microsoft.com/delta/first" },
      pendingCalendars: ["second"],
      resumeLink: "https://graph.microsoft.com/page/second",
      windowStart: "2023-01-01T00:00:00.000Z",
      windowRefreshAfter: "2099-01-01T00:00:00.000Z",
      snapshotPresentIds: ["first:event"],
      knownMasters: ["first:master"],
      enumeratedMasters: [],
    });
    expect(
      graph.get.mock.calls.some(([path]) => path === "https://graph.microsoft.com/page/second"),
    ).toBe(true);
    expect(first.presentExternalIds).toBeUndefined();
    const finished = await wrapped.sync(first.cursor);
    expect(finished.presentExternalIds).toBeUndefined();
    expect(finished.cursor).toMatchObject({ state: { knownMasters: ["first:master"] } });
    graph.get.mockClear();
    const restarted = await wrapped.sync(finished.cursor);
    expect(restarted.cursor).toMatchObject({
      state: { windowStart: "2023-01-01T00:00:00.000Z", snapshotCalendars: ["first", "second"] },
    });
    expect(graph.get).toHaveBeenCalledWith(
      "/me/calendars/first/calendarView/delta",
      expect.objectContaining({ startDateTime: "2023-01-01T00:00:00.000Z" }),
      expect.any(Object),
    );
    expect(restarted.deletedExternalIds).toEqual([]);
  });
  it("preserves delta bookmarks and schedules a complete re-enumeration", async () => {
    const stored = {
      calendarLinks: { first: "https://graph.microsoft.com/delta/first" },
      pendingCalendars: ["second"],
      resumeLink: "https://graph.microsoft.com/page/second",
      windowStart: "2023-01-01T00:00:00.000Z",
      windowRefreshAfter: "2099-01-01T00:00:00.000Z",
      snapshotPresentIds: ["first:event"],
      knownMasters: ["first:master"],
    };
    let received: unknown;
    const wrapped = withVersionedState(
      {
        sync: async (cursor) => {
          received = cursor;
          return emptySync(cursor!);
        },
      },
      outlookCalendarStateSpec,
      { sourceId: "outlook-calendar:tester" },
    );
    const result = await wrapped.sync(stored);
    const { snapshotPresentIds: _ids, ...expected } = stored;
    expect(received).toEqual({ ...expected, windowRefreshAfter: "1970-01-01T00:00:00.000Z" });
    expect(result.cursor).toMatchObject({ v: 2 });
  });
});

function oneDriveInstance(): SourceInstance {
  const graph = {
    get: vi.fn(() => Promise.resolve({ value: [] } as DriveDeltaResponse)),
    getBytes: vi.fn(() => Promise.resolve(new TextEncoder().encode(""))),
  };
  const source = new OneDriveSource(
    async () => "mock-token",
    "onedrive:tester",
    "microsoft:tester",
  );
  Object.defineProperty(source, "graph", { value: graph, writable: true, configurable: true });
  return { sync: (cursor) => source.sync(cursor as never) };
}

function calendarInstance(graph: { get: ReturnType<typeof vi.fn> }): SourceInstance {
  const source = new OutlookCalendarSource(
    async () => "mock-token",
    "outlook-calendar:tester",
    "microsoft:tester",
    undefined,
    { graph: graph as unknown as CalendarGraphClientLike },
  );
  return { sync: (cursor) => source.sync(cursor as never) };
}

describe("outlookEmailStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(emailInstance(), outlookEmailStateSpec, {
      sourceId: "outlook-email:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });
});

describe("oneDriveStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(oneDriveInstance(), oneDriveStateSpec, {
      sourceId: "onedrive:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });
});

describe("outlookCalendarStateSpec via the host decorator", () => {
  it("first run resolves fresh, and a mid-cycle page still resumes", async () => {
    const graph = {
      get: vi.fn((path: string) => {
        if (path.startsWith("/me/calendars?")) {
          return Promise.resolve({
            value: [
              { id: "cal-1", name: "Calendar" },
              { id: "cal-2", name: "Side projects" },
            ],
          });
        }
        return Promise.resolve({ value: [], "@odata.deltaLink": "https://graph/delta-1" });
      }),
    };

    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(calendarInstance(graph), outlookCalendarStateSpec, {
      sourceId: "outlook-calendar:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // First page: one of two calendars drains, so the cycle isn't complete —
    // exactly the mid-cycle shape `decode` has to accept.
    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(first.hasMore).toBe(true);
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("refuses the pre-per-calendar single-stream cursor shape rather than resuming from it", async () => {
    const graph = {
      get: vi.fn(() => Promise.resolve({ value: [], "@odata.deltaLink": "https://graph/delta-1" })),
    };
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(calendarInstance(graph), outlookCalendarStateSpec, {
      sourceId: "outlook-calendar:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // What a build before per-calendar delta links existed persisted: a
    // single `phase`/`link` stream keyed on the bare Graph event id.
    const result = await versioned.sync({ phase: "incremental", link: "https://graph/old-delta" });

    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
