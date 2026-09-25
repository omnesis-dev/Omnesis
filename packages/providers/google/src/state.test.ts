// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import {
  createMockCalendar,
  createCalendarSource,
  createMockDrive,
  createDriveSource,
  createMockGmail,
  createGmailSource,
  makeCalendarListEntry,
} from "./testing/mock-google.js";
import { GoogleContactsSource } from "./contacts.js";
import {
  gmailStateSpec,
  googleCalendarStateSpec,
  googleDriveStateSpec,
  googleContactsStateSpec,
} from "./state.js";

function gmailInstance(): SourceInstance {
  const source = createGmailSource(createMockGmail());
  return { sync: (cursor) => source.sync(cursor) };
}

function driveInstance(): SourceInstance {
  const source = createDriveSource(createMockDrive());
  return { sync: (cursor) => source.sync(cursor) };
}

function contactsInstance(): SourceInstance {
  const source = new GoogleContactsSource({} as never, "tester@example.com");
  const mockPeople = {
    people: {
      connections: {
        list: vi.fn(() => Promise.resolve({ data: { connections: [], nextSyncToken: "tok-1" } })),
      },
    },
  };
  Object.defineProperty(source, "people", {
    value: mockPeople,
    writable: true,
    configurable: true,
  });
  return { sync: (cursor) => source.sync(cursor) };
}

function calendarInstance(mockCalendar: ReturnType<typeof createMockCalendar>): SourceInstance {
  const source = createCalendarSource(mockCalendar);
  return { sync: (cursor) => source.sync(cursor) };
}

describe("gmailStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(gmailInstance(), gmailStateSpec, {
      sourceId: "gmail:tester",
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

describe("googleDriveStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(driveInstance(), googleDriveStateSpec, {
      sourceId: "google-drive:tester",
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

describe("googleContactsStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(contactsInstance(), googleContactsStateSpec, {
      sourceId: "google-contacts:tester",
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

describe("googleCalendarStateSpec via the host decorator", () => {
  it.each([
    { lastSnapshotAt: "2026-01-01T00:00:00Z", snapshotPresentIds: [] },
    { occurrenceExpansion: true, calendarSyncTokens: {} },
  ])("preserves expansion for reset or explicitly expanding installed state %j", async (stored) => {
    const mock = createMockCalendar();
    mock.calendarList.list = vi.fn(async () => ({
      data: { items: [makeCalendarListEntry("cal-1")] },
    }));
    mock.events.list = vi.fn(async () => ({ data: { items: [], nextSyncToken: "next" } }));
    const wrapped = withVersionedState(calendarInstance(mock), googleCalendarStateSpec, {
      sourceId: "google-calendar:tester",
    });
    const result = await wrapped.sync(stored);
    expect(mock.events.list.mock.calls[0][0].singleEvents).toBe(true);
    expect(result.cursor).toMatchObject({ state: { occurrenceExpansion: true } });
  });
  it("first run resolves fresh, adopts occurrence expansion, and a mid-cycle page still resumes", async () => {
    const mockCalendar = createMockCalendar();
    mockCalendar.calendarList.list = vi.fn(() =>
      Promise.resolve({
        data: { items: [makeCalendarListEntry("cal-1"), makeCalendarListEntry("cal-2")] },
      }),
    );
    mockCalendar.events.list = vi.fn(() =>
      Promise.resolve({ data: { items: [], nextSyncToken: "tok-1" } }),
    );

    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(calendarInstance(mockCalendar), googleCalendarStateSpec, {
      sourceId: "google-calendar:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // First page: one of two calendars drains, so the cycle isn't complete —
    // exactly the mid-cycle shape `decode` has to accept without treating it
    // as legacy.
    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(first.hasMore).toBe(true);
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a pre-expansion cursor migrates to occurrenceExpansion: false and keeps behaving as legacy", async () => {
    const mockCalendar = createMockCalendar();
    mockCalendar.calendarList.list = vi.fn(() =>
      Promise.resolve({ data: { items: [makeCalendarListEntry("cal-1")] } }),
    );
    mockCalendar.events.list = vi.fn(() =>
      Promise.resolve({ data: { items: [], nextSyncToken: "legacy-token-next" } }),
    );

    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(calendarInstance(mockCalendar), googleCalendarStateSpec, {
      sourceId: "google-calendar:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // What an install from before occurrence expansion existed persisted:
    // per-calendar sync tokens, unwrapped, with no `occurrenceExpansion` flag.
    const legacyStored = { calendarSyncTokens: { "cal-1": "legacy-master-token" } };
    const result = await versioned.sync(legacyStored);

    expect(outcomes[0]?.kind).toBe("migrated");
    if (outcomes[0]?.kind === "migrated") {
      expect(outcomes[0].from).toBe(1);
      expect(outcomes[0].to).toBe(2);
      expect(outcomes[0].state.occurrenceExpansion).toBe(false);
    }
    // The migrated flag reaches `sync`, which keeps the request shape a
    // pre-expansion install always used — no `singleEvents`, no bounded window.
    const call = mockCalendar.events.list.mock.calls[0][0];
    expect(call.syncToken).toBe("legacy-master-token");
    expect(call.singleEvents).toBeUndefined();
    expect(isStateEnvelope(result.cursor)).toBe(true);

    // Resuming from the now-envelope-wrapped value decodes directly at
    // version 2 and stays on the legacy path — the migration is one-time.
    const outcomes2: StateOutcome[] = [];
    const versioned2 = withVersionedState(calendarInstance(mockCalendar), googleCalendarStateSpec, {
      sourceId: "google-calendar:tester",
      onResolve: (outcome) => outcomes2.push(outcome),
    });
    await versioned2.sync(result.cursor);
    expect(outcomes2[0]?.kind).toBe("resume");
  });
});
