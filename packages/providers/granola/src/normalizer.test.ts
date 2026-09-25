// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { noteToRecord, noteToDocument } from "./normalizer.js";
import type { GranolaNoteDetail } from "./types.js";

const providerId = ProviderId("granola:alice@example.com");
const sourceId = SourceId("granola-meetings");

function sampleNote(overrides: Partial<GranolaNoteDetail> = {}): GranolaNoteDetail {
  return {
    id: "not_abc123DEF45678",
    object: "note",
    title: "Weekly sync",
    created_at: "2026-06-01T09:00:00.000Z",
    updated_at: "2026-06-01T10:05:00.000Z",
    web_url: "https://granola.ai/notes/not_abc123DEF45678",
    summary_text: "Discussed roadmap and Q3 goals.",
    summary_markdown: "## Decisions\n- Ship the thing",
    transcript: [
      {
        speaker: { source: "microphone", diarization_label: "Alice" },
        text: "Let's start.",
        start_time: "2026-06-01T09:00:10.000Z",
        end_time: "2026-06-01T09:00:12.000Z",
      },
      {
        speaker: { source: "speaker", diarization_label: "Bob" },
        text: "Sounds good.",
        start_time: "2026-06-01T09:30:00.000Z",
        end_time: "2026-06-01T09:30:02.000Z",
      },
    ],
    owner: { name: "Alice", email: "alice@example.com" },
    attendees: [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ],
    calendar_event: { title: "Weekly sync", start_time: "2026-06-01T09:00:00.000Z" },
    folder_membership: [{ id: "fol_x", name: "Team" }],
    ...overrides,
  };
}

describe("noteToRecord", () => {
  test("maps core fields and computes duration + attendee count", () => {
    const row = noteToRecord(sampleNote(), "2026-06-02T00:00:00.000Z", "maya.reeves@example.com");
    expect(row.id).toBe("not_abc123DEF45678");
    expect(row.title).toBe("Weekly sync");
    expect(row.owner_email).toBe("alice@example.com");
    expect(row.attendee_count).toBe(2);
    expect(row.has_summary).toBe(true);
    expect(row.transcript_segment_count).toBe(2);
    // 09:00:10 → 09:30:02 = 1792 seconds
    expect(row.duration_seconds).toBe(1792);
    expect(row.started_at).toBe("2026-06-01T09:00:00.000Z");
    expect(row.synced_at).toBe("2026-06-02T00:00:00.000Z");
    expect(JSON.parse(row.attendees as string)).toHaveLength(2);
    expect(JSON.parse(row.folder_names as string)).toEqual(["Team"]);
  });

  test("handles a note with no transcript and no summary", () => {
    const row = noteToRecord(
      sampleNote({ transcript: null, summary_text: "", summary_markdown: null }),
      "2026-06-02T00:00:00.000Z",
      "maya.reeves@example.com",
    );
    expect(row.duration_seconds).toBeNull();
    expect(row.transcript_segment_count).toBe(0);
    expect(row.has_summary).toBe(false);
    expect(row.summary_text).toBeNull();
  });
});

describe("noteToDocument", () => {
  test("renders markdown with summary + transcript and attaches people", () => {
    const doc = noteToDocument(sampleNote(), providerId, sourceId);
    expect(doc.externalId).toBe("not_abc123DEF45678");
    expect(doc.title).toBe("Weekly sync");
    expect(doc.content).toContain("## Summary");
    expect(doc.content).toContain("Ship the thing");
    expect(doc.content).toContain("**Alice:** Let's start.");
    expect(doc.content).toContain("**Bob:** Sounds good.");
    expect(doc.metadata.documentType).toBe("note");
    expect(doc.metadata.sourceUrl).toBe("https://granola.ai/notes/not_abc123DEF45678");
    expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const people = doc.metadata.people ?? [];
    const owner = people.find((p) => p.role === "owner");
    expect(owner?.isSelf).toBe(true);
    expect(owner?.emails).toEqual(["alice@example.com"]);
    // Owner is not duplicated as an attendee.
    const attendees = people.filter((p) => p.role === "attendee");
    expect(attendees).toHaveLength(1);
    expect(attendees[0].emails).toEqual(["bob@example.com"]);
  });

  test("falls back to a default title for untitled notes", () => {
    const doc = noteToDocument(sampleNote({ title: null }), providerId, sourceId);
    expect(doc.title).toBe("Untitled meeting");
  });
});
