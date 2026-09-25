// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  emptySync,
  isStateEnvelope,
  resolveSourceState,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { GranolaMeetingsSource } from "./meetings.js";
import { granolaMeetingsStateSpec } from "./state.js";
import type { GranolaClient, ListNotesParams } from "./client.js";
import type { GranolaNoteDetail, GranolaNoteSummary, GranolaNotesListResponse } from "./types.js";

const providerId = ProviderId("granola:tester");
const sourceId = SourceId("granola-meetings");
const ACCOUNT_ID = "tester@example.com";

function summary(id: string, updatedAt: string): GranolaNoteSummary {
  return {
    id,
    object: "note",
    title: `Note ${id}`,
    owner: { name: "Tester", email: ACCOUNT_ID },
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: updatedAt,
  };
}

function detail(id: string): GranolaNoteDetail {
  return {
    id,
    object: "note",
    title: `Note ${id}`,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T10:05:00.000Z",
    web_url: `https://granola.ai/notes/${id}`,
    summary_text: "summary",
    summary_markdown: null,
    transcript: null,
    owner: { name: "Tester", email: ACCOUNT_ID },
    attendees: [],
    calendar_event: null,
    folder_membership: [],
  };
}

class FakeClient {
  constructor(private pages: GranolaNotesListResponse[]) {}
  async listNotes(_params: ListNotesParams = {}): Promise<GranolaNotesListResponse> {
    return this.pages.shift() ?? { notes: [], hasMore: false, cursor: null };
  }
  async getNote(id: string): Promise<GranolaNoteDetail> {
    return detail(id);
  }
}

function instance(client: FakeClient): SourceInstance {
  const source = new GranolaMeetingsSource(
    client as unknown as GranolaClient,
    providerId,
    sourceId,
    undefined,
    ACCOUNT_ID,
    { now: () => "2026-06-02T00:00:00.000Z" },
  );
  // Driven through `withVersionedState` rather than `syncStructured` directly,
  // because resolving the stored value is the host's job.
  return {
    sync: () => Promise.resolve(emptySync()),
    syncStructured: (cursor) => source.syncStructured(cursor as never),
  };
}

describe("granolaMeetingsStateSpec via the host decorator", () => {
  it.each(["backfill", "incremental"] as const)(
    "preserves an installed %s page token and watermark during migration",
    (phase) => {
      const prior = {
        phase,
        pageCursor: "page-2",
        syncedUpTo: "2026-06-01T00:00:00.000Z",
        sweepMaxUpdatedAt: "2026-06-02T00:00:00.000Z",
      };
      for (const stored of [prior, { e: 1, v: 1, state: prior }]) {
        const result = resolveSourceState(granolaMeetingsStateSpec, stored);
        expect(result.kind).toBe("migrated");
        if (result.kind === "migrated")
          expect(result.state).toEqual({ ...prior, reconciliationVersion: 2 });
      }
    },
  );

  it("an installed partial backfill finishes without a snapshot, then rewalks completely", async () => {
    const client = new FakeClient([
      { notes: [summary("tail", "2026-06-01T09:00:00.000Z")], hasMore: false, cursor: null },
      {
        notes: [
          summary("head", "2026-06-01T10:00:00.000Z"),
          summary("tail", "2026-06-01T09:00:00.000Z"),
        ],
        hasMore: false,
        cursor: null,
      },
    ]);
    const wrapped = withVersionedState(instance(client), granolaMeetingsStateSpec, { sourceId });
    const tail = await wrapped.syncStructured!({
      phase: "backfill",
      pageCursor: "page-2",
      sweepMaxUpdatedAt: "2026-06-01T10:00:00.000Z",
    });
    expect(tail.presentExternalIds).toBeUndefined();
    const full = await wrapped.syncStructured!(tail.cursor);
    expect(full.presentExternalIds).toEqual(["head", "tail"]);
  });

  it("refuses malformed snapshot bookkeeping through unreadable-state policy", () => {
    expect(
      resolveSourceState(granolaMeetingsStateSpec, {
        e: 1,
        v: 2,
        state: { phase: "snapshot", reconciliationVersion: 2, snapshot: { ids: { notes: 42 } } },
      }).kind,
    ).toBe("rebootstrap");
  });

  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const client = new FakeClient([{ notes: [], hasMore: false, cursor: null }]);
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance(client), granolaMeetingsStateSpec, {
      sourceId: "granola-meetings:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.syncStructured!(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(result.cursor)).toBe(true);

    const second = await versioned.syncStructured!(result.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a mid-sweep cursor round-trips through the envelope without losing the page token", async () => {
    const client = new FakeClient([
      { notes: [summary("not_1", "2026-06-01T08:00:00.000Z")], hasMore: true, cursor: "page2" },
      { notes: [summary("not_2", "2026-06-01T09:00:00.000Z")], hasMore: false, cursor: null },
    ]);
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance(client), granolaMeetingsStateSpec, {
      sourceId: "granola-meetings:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const first = await versioned.syncStructured!(null);
    expect(first.hasMore).toBe(true);
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.syncStructured!(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect((outcomes[1] as { state?: { pageCursor?: string } }).state?.pageCursor).toBe("page2");
    expect(second.hasMore).toBe(false);
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("an unreadable stored value rebootstraps rather than stopping the source", async () => {
    const client = new FakeClient([{ notes: [], hasMore: false, cursor: null }]);
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance(client), granolaMeetingsStateSpec, {
      sourceId: "granola-meetings:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // A value with no recognisable phase — corruption, or a future build's
    // shape this one can't read.
    const result = await versioned.syncStructured!({ phase: "orbiting" } as never);
    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
