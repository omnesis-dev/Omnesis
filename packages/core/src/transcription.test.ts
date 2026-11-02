// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SyncError, isTransientSyncError } from "@omnesis/types";
import { syncIssuesSchema } from "./sync-issues.js";
import {
  AudioUnreadableError,
  transcriptionPlaceholderNote,
  transcriptionSyncIssues,
} from "./transcription.js";

describe("transcriptionSyncIssues", () => {
  test("reports nothing for an empty backlog", () => {
    expect(
      transcriptionSyncIssues({
        awaiting: 0,
        transcriberUnavailable: 0,
        unavailable: 0,
        unreadable: 0,
      }),
    ).toEqual([]);
  });

  test("a backlog a transcriber is working through is information with no remedy", () => {
    const issues = transcriptionSyncIssues({
      awaiting: 12,
      transcriberUnavailable: 0,
      unavailable: 0,
      unreadable: 0,
    });
    expect(issues).toEqual([
      {
        code: "transcription-awaiting",
        scope: "item",
        kind: "transient",
        count: 12,
        severity: "info",
        message: "12 voice notes awaiting transcription",
      },
    ]);
  });

  test("a backlog that found no transcriber is a warning carrying the fix", () => {
    const [issue] = transcriptionSyncIssues({
      awaiting: 3,
      transcriberUnavailable: 2,
      unavailable: 0,
      unreadable: 0,
    });
    expect(issue.severity).toBe("warning");
    expect(issue.count).toBe(3);
    expect(issue.message).toBe("3 voice notes waiting for a transcriber");
    expect(issue.remediation?.summary).toBe("No transcriber is currently available");
    expect(issue.remediation?.steps.join(" ")).toContain("check that its backend is available");
    expect(issue.remediation?.restartRequired).toBe(false);
  });

  test("every report fits the wire schema, so no field is dropped in transit", () => {
    const issues = transcriptionSyncIssues(
      { awaiting: 3, transcriberUnavailable: 2, unavailable: 4, unreadable: 5 },
      "voice clips",
    );
    expect(syncIssuesSchema.safeParse(issues).success).toBe(true);
  });

  test("audio that is gone is its own warning, singular when one", () => {
    const issues = transcriptionSyncIssues(
      { awaiting: 0, transcriberUnavailable: 0, unavailable: 1, unreadable: 0 },
      "audio clips",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("transcription-audio-unavailable");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toMatch(/^1 audio clip could not be transcribed/);
  });
});

describe("unreadable audio", () => {
  test("is its own warning, apart from audio that is gone and from the waiting backlog", () => {
    const issues = transcriptionSyncIssues({
      awaiting: 0,
      transcriberUnavailable: 0,
      unavailable: 0,
      unreadable: 2,
    });
    expect(issues).toEqual([
      {
        code: "transcription-audio-unreadable",
        scope: "item",
        kind: "unknown",
        count: 2,
        severity: "warning",
        message: "2 voice notes could not be transcribed: the audio could not be decoded",
      },
    ]);
  });

  test("its error concerns one item and is never retried as transient", () => {
    const err = new AudioUnreadableError();
    expect(err).toBeInstanceOf(SyncError);
    expect(err.name).toBe("AudioUnreadableError");
    expect(err.scope).toBe("item");
    expect(isTransientSyncError(err)).toBe(false);
  });
});

describe("transcriptionPlaceholderNote", () => {
  test("names each state in plain words", () => {
    expect(transcriptionPlaceholderNote("awaiting")).toBe("awaiting transcription");
    expect(transcriptionPlaceholderNote("transcriber-unavailable")).toBe(
      "no transcriber available",
    );
    expect(transcriptionPlaceholderNote("no-speech")).toBe("no speech detected");
    expect(transcriptionPlaceholderNote("audio-unavailable")).toBe("audio unavailable");
    expect(transcriptionPlaceholderNote("audio-missing")).toBe(
      "audio not downloaded on this device",
    );
    expect(transcriptionPlaceholderNote("audio-unreadable")).toBe("audio could not be decoded");
  });
});
