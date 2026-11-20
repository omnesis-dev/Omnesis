// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { plaudTime, recordingToDocument } from "./normalizer.js";
import type { FileSummary } from "./schemas.js";

const ctx = {
  providerId: ProviderId("plaud:maya.reeves@example.com"),
  sourceId: SourceId("plaud-recordings:maya.reeves@example.com"),
  accountEmail: "maya.reeves@example.com",
};

const file: FileSummary = {
  id: "rec-1",
  filename: "Q4 budget review",
  start_time: Date.UTC(2026, 9, 6, 9, 30),
  duration: 3_725_000,
  version_ms: Date.UTC(2026, 9, 6, 11, 0),
  edit_time: 1_791_000_000,
  keywords: ["budget", " "],
  is_trash: false,
  is_trans: true,
  is_summary: true,
};

describe("recordingToDocument", () => {
  test("renders Plaud's summary and transcript as a conversation", () => {
    const doc = recordingToDocument(
      {
        file,
        deviceName: "Desk recorder",
        summary: {
          text: "Travel is over plan.",
          keyPoints: ["Cut two trips"],
          actionItems: ["Send the sheet"],
        },
        transcript: {
          source: "plaud",
          segments: [
            { startMs: 0, speaker: "Maya", text: "Let's start." },
            { startMs: 3_661_000, speaker: "Speaker 2", text: "Agreed." },
          ],
        },
      },
      ctx,
    );
    expect(doc.title).toBe("Q4 budget review");
    expect(doc.externalId).toBe("rec-1");
    expect(doc.content).toBe(
      [
        "## Summary",
        "",
        "Travel is over plan.",
        "",
        "### Key points",
        "- Cut two trips",
        "",
        "### Action items",
        "- Send the sheet",
        "",
        "## Transcript",
        "",
        "[00:00:00] Maya: Let's start.",
        "[01:01:01] Speaker 2: Agreed.",
      ].join("\n"),
    );
    expect(doc.sourceCreatedAt).toBe("2026-10-06T09:30:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-10-06T11:00:00.000Z");
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.people).toEqual([
      { role: "owner", emails: ["maya.reeves@example.com"], isSelf: true },
    ]);
    expect(doc.metadata.extra).toEqual({
      durationSeconds: 3725,
      device: "Desk recorder",
      transcriptSource: "plaud",
      hasSummary: true,
      speakers: ["Maya", "Speaker 2"],
      keywords: ["budget"],
    });
  });

  test("renders a local transcript as plain text with its language", () => {
    const doc = recordingToDocument(
      { file, transcript: { source: "local", text: "Let's start.", language: "en" } },
      ctx,
    );
    expect(doc.content).toBe("## Transcript\n\nLet's start.");
    expect(doc.metadata.extra).toMatchObject({
      transcriptSource: "local",
      language: "en",
      hasSummary: false,
    });
    expect(doc.metadata.extra).not.toHaveProperty("speakers");
  });

  test("says when there is no transcript yet, and names an untitled recording", () => {
    const doc = recordingToDocument({ file: { ...file, filename: " " } }, ctx);
    expect(doc.title).toBe("Untitled recording");
    expect(doc.content).toBe("## Transcript\n\nNo transcript of this recording is available yet.");
    expect(doc.metadata.extra).toMatchObject({ transcriptSource: "none" });
  });

  test("the content hash follows the content", () => {
    const a = recordingToDocument({ file }, ctx);
    const b = recordingToDocument({ file, transcript: { source: "local", text: "Hi" } }, ctx);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

describe("plaudTime", () => {
  test.each([
    [Date.UTC(2026, 0, 2), "2026-01-02T00:00:00.000Z"],
    [Date.UTC(2026, 0, 2) / 1000, "2026-01-02T00:00:00.000Z"],
    [0, undefined],
    [null, undefined],
  ])("%s → %s", (input, expected) => expect(plaudTime(input)).toBe(expected));
});
