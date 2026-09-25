// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  cognitionRunPromptBody,
  formatCognitionRunEnvelope,
  parseCognitionRunEnvelope,
} from "./cognition-envelope.js";

describe("cognition run envelope", () => {
  test("renders the identity line a first attempt opens with", () => {
    expect(formatCognitionRunEnvelope({ runId: "run_1", kind: "data", attempt: 1 })).toBe(
      "Loop agent run run_1 (kind: data, attempt 1).",
    );
  });

  test("a re-attempt is told its predecessor may have written something", () => {
    const text = formatCognitionRunEnvelope({ runId: "run_1", kind: "data", attempt: 2 });
    expect(text.split("\n")[0]).toBe("Loop agent run run_1 (kind: data, attempt 2).");
    expect(text).toContain("already stamped with this run id and adopt that work");
  });

  test("what the writer emits, the reader recovers — every kind, both attempt shapes", () => {
    const kinds = [
      "data",
      "daily",
      "time_based",
      "feedback",
      "synthesis",
      "sweep",
      "bootstrap",
      "verification",
      "merge_adjudication",
      "notes_compaction",
    ];
    for (const kind of kinds) {
      for (const attempt of [1, 3]) {
        const run = { runId: `run_${kind}_${attempt}`, kind, attempt };
        expect(parseCognitionRunEnvelope(formatCognitionRunEnvelope(run))).toEqual(run);
      }
    }
  });

  test("the envelope is still readable with a body beneath it", () => {
    const prompt = [
      formatCognitionRunEnvelope({ runId: "run_9", kind: "sweep", attempt: 1 }),
      "",
      'Scheduled sweep "may-day" for 2026-08-21.',
      "More body.",
    ].join("\n");
    expect(parseCognitionRunEnvelope(prompt)).toEqual({
      runId: "run_9",
      kind: "sweep",
      attempt: 1,
    });
    expect(cognitionRunPromptBody(prompt)).toBe(
      'Scheduled sweep "may-day" for 2026-08-21.\nMore body.',
    );
  });

  test("the body skips the re-attempt caution as well as the envelope", () => {
    const prompt = [
      formatCognitionRunEnvelope({ runId: "run_9", kind: "data", attempt: 4 }),
      "",
      "A new document arrived: doc_1. Fetch its content with fetch_many.",
    ].join("\n");
    expect(cognitionRunPromptBody(prompt)).toBe(
      "A new document arrived: doc_1. Fetch its content with fetch_many.",
    );
  });

  test("text that is not a run prompt parses as nothing, rather than a default kind", () => {
    expect(parseCognitionRunEnvelope("")).toBeNull();
    expect(parseCognitionRunEnvelope("Background Cognition Steward run.\nRun id: x")).toBeNull();
    expect(parseCognitionRunEnvelope("Loop agent run r1 (kind: data)")).toBeNull();
    expect(cognitionRunPromptBody("not a prompt")).toBe("not a prompt");
  });
});
