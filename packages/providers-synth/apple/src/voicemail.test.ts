// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { loadVoicemails, mapVoicemail } from "./fixtures.js";

describe("synthetic Apple voicemail documents", () => {
  test("aggregates a day with transcript content and normalized participant identities", () => {
    const entry = loadVoicemails().find((candidate) => candidate.date === "2025-09-06")!;
    const document = mapVoicemail(entry, {
      sourceId: SourceId("apple-voicemail:john.smith@icloud.example"),
      providerId: ProviderId("apple:john.smith@icloud.example"),
    });

    expect(document).toMatchObject({
      externalId: "voicemail:2025-09-06",
      title: "Voicemail — 2025-09-06",
      metadata: {
        documentType: "voicemail",
        rollingAggregate: true,
        extra: {
          voicemailCount: 2,
          totalDurationSeconds: 62,
          transcriptCount: 2,
        },
      },
    });
    expect(document.content).toContain("blue folder at the reception desk");
    expect(document.content).toContain("community hall booking is confirmed");
    expect(document.metadata.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "participant",
          emails: expect.arrayContaining(["john.smith@icloud.example"]),
        }),
        expect.objectContaining({ role: "participant", phones: ["+15550150"] }),
        expect.objectContaining({ role: "participant", phones: ["+15550101"] }),
      ]),
    );
    expect(
      document.metadata.people?.some((person) =>
        person.emails?.some(
          (email) => email === "john.smith@example.com" || email === "john.smith@acme.example",
        ),
      ),
    ).toBe(false);
    expect(document.metadata.extra?.voicemails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "synth-voicemail-001",
          caller: "+15550150",
          hasTranscript: true,
        }),
      ]),
    );
  });
});
