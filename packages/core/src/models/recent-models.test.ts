// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  MAX_RECENT_MODELS_PER_ROLE,
  mergeRecentCandidates,
  recordRecentHistory,
  siblingRolesForRecentModels,
  type RecentModelHistory,
} from "./recent-models.js";

describe("siblingRolesForRecentModels", () => {
  it("groups the chat roles together for an agent reference", () => {
    expect(siblingRolesForRecentModels("agent")).toEqual([
      "agent",
      "privacy-reviewer",
      "background-agent",
      "watch-judge",
      "brief-judge",
    ]);
  });

  it("is symmetric: every chat role sees the same group", () => {
    for (const role of [
      "privacy-reviewer",
      "background-agent",
      "watch-judge",
      "brief-judge",
    ] as const) {
      expect(siblingRolesForRecentModels(role)).toEqual(siblingRolesForRecentModels("agent"));
    }
  });

  it("keeps ocr, transcriber and embedder to themselves", () => {
    expect(siblingRolesForRecentModels("ocr")).toEqual(["ocr"]);
    expect(siblingRolesForRecentModels("transcriber")).toEqual(["transcriber"]);
    expect(siblingRolesForRecentModels("embedder")).toEqual(["embedder"]);
  });

  it("returns no roles for the entailment verifier", () => {
    expect(siblingRolesForRecentModels("entailment-verifier")).toEqual([]);
  });
});

describe("mergeRecentCandidates", () => {
  it("lists the reference capability's own current model first", () => {
    const got = mergeRecentCandidates({
      reference: "agent",
      current: {
        agent: "openai/gpt-4o",
        "privacy-reviewer": "codex/gpt-5.4",
      },
      history: {},
    });
    expect(got).toEqual([
      { role: "agent", value: "openai/gpt-4o" },
      { role: "privacy-reviewer", value: "codex/gpt-5.4" },
    ]);
  });

  it("deduplicates the same model used by several sibling capabilities", () => {
    const got = mergeRecentCandidates({
      reference: "agent",
      current: {
        agent: "codex/gpt-5.4",
        "background-agent": "codex/gpt-5.4",
        "privacy-reviewer": "openai/gpt-4o",
      },
      history: {},
    });
    expect(got.map((c) => c.value)).toEqual(["codex/gpt-5.4", "openai/gpt-4o"]);
  });

  it("includes a replaced model from history alongside the current one", () => {
    const got = mergeRecentCandidates({
      reference: "agent",
      current: { agent: "openai/gpt-4o" },
      history: { agent: ["openai/gpt-4o", "codex/gpt-5.4"] },
    });
    expect(got).toEqual([
      { role: "agent", value: "openai/gpt-4o" },
      { role: "agent", value: "codex/gpt-5.4" },
    ]);
  });

  it("shows a sibling's current model with no history at all (fresh upgrade)", () => {
    const got = mergeRecentCandidates({
      reference: "agent",
      current: { "privacy-reviewer": "codex/gpt-5.4" },
      history: {},
    });
    expect(got).toEqual([{ role: "privacy-reviewer", value: "codex/gpt-5.4" }]);
  });

  it("keeps at most two candidates per role", () => {
    const got = mergeRecentCandidates({
      reference: "agent",
      current: { agent: "c" },
      history: { agent: ["b", "a", "stale"] },
    });
    expect(got.map((c) => c.value)).toEqual(["c", "b"]);
    expect(MAX_RECENT_MODELS_PER_ROLE).toBe(2);
  });

  it("skips cleared and unconfigured capabilities", () => {
    const got = mergeRecentCandidates({
      reference: "agent",
      current: { agent: "openai/gpt-4o", "privacy-reviewer": null },
      history: { "background-agent": [] },
    });
    expect(got).toEqual([{ role: "agent", value: "openai/gpt-4o" }]);
  });

  it("returns nothing for the entailment verifier", () => {
    expect(
      mergeRecentCandidates({
        reference: "entailment-verifier",
        current: { "entailment-verifier": "openai/gpt-4o" },
        history: {},
      }),
    ).toEqual([]);
  });
});

describe("recordRecentHistory", () => {
  it("prepends the new value and keeps the replaced one", () => {
    const history: RecentModelHistory = {};
    const next = recordRecentHistory(history, "agent", "codex/gpt-5.4", "openai/gpt-4o");
    expect(next).toEqual({ agent: ["openai/gpt-4o", "codex/gpt-5.4"] });
    expect(history).toEqual({});
  });

  it("drops everything past the per-role cap", () => {
    const next = recordRecentHistory({ agent: ["b", "a"] }, "agent", "b", "c");
    expect(next).toEqual({ agent: ["c", "b"] });
  });

  it("records a fresh assignment with no previous value", () => {
    expect(recordRecentHistory({}, "ocr", null, "northstar/dots-ocr")).toEqual({
      ocr: ["northstar/dots-ocr"],
    });
  });

  it("keeps the previous value when an assignment is cleared", () => {
    expect(recordRecentHistory({}, "agent", "openai/gpt-4o", null)).toEqual({
      agent: ["openai/gpt-4o"],
    });
  });

  it("leaves history untouched when nothing changed", () => {
    const history: RecentModelHistory = { agent: ["openai/gpt-4o"] };
    expect(recordRecentHistory(history, "agent", "openai/gpt-4o", "openai/gpt-4o")).toBe(history);
    expect(recordRecentHistory(history, "agent", null, null)).toBe(history);
  });
});
