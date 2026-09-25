// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { buildTalkbackSystemPrompt } from "./talkback-prompt.js";

const NOW = new Date("2026-07-02T10:00:00.000Z");

describe("buildTalkbackSystemPrompt — self-memory injection", () => {
  test("injects the user's profile as read context when present", () => {
    const prompt = buildTalkbackSystemPrompt({
      notes: "",
      selfMemory: "- (role) ZZTALKBACK-founder",
      now: NOW,
    });
    expect(prompt).toContain("<user-profile>");
    expect(prompt).toContain("ZZTALKBACK-founder");
  });

  test("omits the profile block when self-memory is empty/absent", () => {
    const empty = buildTalkbackSystemPrompt({
      notes: "",
      selfMemory: "",
      now: NOW,
    });
    expect(empty).not.toContain("<user-profile>");
    const absent = buildTalkbackSystemPrompt({
      notes: "",
      now: NOW,
    });
    expect(absent).not.toContain("<user-profile>");
  });
});

describe("buildTalkbackSystemPrompt — the operator's standing instructions", () => {
  const MARKER = "ZZTALKBACK-OPERATORRULE never open with a greeting";

  test("carries OMNESIS.md into a brief's follow-up thread", () => {
    const prompt = buildTalkbackSystemPrompt({
      notes: "",
      operatorInstructions: MARKER,
      now: NOW,
    });
    expect(prompt).toContain("# The operator's standing instructions");
    expect(prompt).toContain(MARKER);
  });

  test("keeps the section above the clock line, where prefix caching wants it", () => {
    // Everything above the clock is identical run to run; putting the operator
    // section below it would push a stable block past the volatile one and
    // shorten the cacheable prefix for no reason.
    const prompt = buildTalkbackSystemPrompt({
      notes: "",
      operatorInstructions: MARKER,
      now: NOW,
    });
    expect(prompt.indexOf(MARKER)).toBeLessThan(prompt.indexOf("Current time:"));
  });

  test("renders nothing when the file is absent or empty", () => {
    const absent = buildTalkbackSystemPrompt({ notes: "", now: NOW });
    expect(buildTalkbackSystemPrompt({ notes: "", operatorInstructions: "", now: NOW })).toBe(
      absent,
    );
    expect(absent).not.toContain("# The operator's standing instructions");
  });
});
