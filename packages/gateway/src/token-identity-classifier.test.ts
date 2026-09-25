// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  buildClassifyPrompt,
  parseClassifyResponse,
  classifyTokens,
} from "./token-identity-classifier.js";
import type { CompleteCapability } from "@omnesis/core";

describe("buildClassifyPrompt", () => {
  test("lists every token and names the three labels", () => {
    const prompt = buildClassifyPrompt(["reservations", "nakamura"]);
    expect(prompt).toContain("reservations");
    expect(prompt).toContain("nakamura");
    expect(prompt).toContain("personal_name");
    expect(prompt).toContain("role_generic");
    expect(prompt).toContain("ambiguous");
  });
});

describe("parseClassifyResponse", () => {
  const requested = ["reservations", "nakamura", "ne", "tickets"];

  test("parses clean token: label lines", () => {
    const out = parseClassifyResponse(
      ["reservations: role_generic", "nakamura: personal_name", "ne: ambiguous"].join("\n"),
      requested,
    );
    expect(out.get("reservations")).toBe("role_generic");
    expect(out.get("nakamura")).toBe("personal_name");
    expect(out.get("ne")).toBe("ambiguous");
  });

  test("tolerates list markers and trailing explanations", () => {
    const out = parseClassifyResponse(
      [
        "- reservations: role_generic (a booking mailbox)",
        "1. nakamura: personal_name — surname",
      ].join("\n"),
      requested,
    );
    expect(out.get("reservations")).toBe("role_generic");
    expect(out.get("nakamura")).toBe("personal_name");
  });

  test("ignores tokens not requested and invalid labels", () => {
    const out = parseClassifyResponse(
      ["tickets: nonsense", "elephant: role_generic", "reservations: role_generic"].join("\n"),
      requested,
    );
    expect(out.has("tickets")).toBe(false); // invalid label dropped
    expect(out.has("elephant")).toBe(false); // not requested
    expect(out.get("reservations")).toBe("role_generic");
  });

  test("ignores prose lines without a colon", () => {
    const out = parseClassifyResponse(
      ["Here are the labels:", "nakamura: personal_name"].join("\n"),
      requested,
    );
    expect(out.size).toBe(1);
    expect(out.get("nakamura")).toBe("personal_name");
  });
});

describe("classifyTokens", () => {
  function stubProvider(reply: (prompt: string) => string): CompleteCapability {
    return {
      name: "stub",
      modelId: "stub",
      complete: async (prompt: string) => reply(prompt),
      dispose: async () => {},
    };
  }

  test("defaults omitted/unparseable tokens to ambiguous so they are recorded", async () => {
    // Provider only labels one of the two tokens.
    const provider = stubProvider(() => "reservations: role_generic");
    const out = await classifyTokens(provider, ["reservations", "nakamura"]);
    expect(out.get("reservations")).toBe("role_generic");
    expect(out.get("nakamura")).toBe("ambiguous");
  });

  test("a failing batch leaves its tokens unlabeled (retried next pass)", async () => {
    const provider = stubProvider(() => {
      throw new Error("model down");
    });
    const out = await classifyTokens(provider, ["reservations"]);
    expect(out.size).toBe(0);
  });
});
