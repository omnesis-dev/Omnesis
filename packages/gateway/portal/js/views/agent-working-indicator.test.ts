// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Eligibility spec for the turn-level working indicator (`workingIndicatorActive`) — the pure rule
// deciding WHEN the dots may show. Mirrors the iOS / Android `workingIndicatorActive` cases, with
// the two documented portal divergences: a batch tool is not special-cased (the portal renders its
// child cards from args, so a pending batch reads like any pending tool), and the pre-token /
// trailing-user beat shows the dots (no separate typing indicator on the portal). The reveal
// DEBOUNCE is a view concern, exercised separately.

import { describe, expect, it } from "vitest";

import { workingIndicatorActive } from "./agent-reducer.js";

const state = (busy: boolean, turns: unknown[]) => ({ busy, turns }) as never;
const assistant = (parts: unknown[], done = false) => ({ id: "a", role: "assistant", parts, done });
const tool = (name: string, result: unknown = null, children: unknown[] = []) => ({
  kind: "tool",
  tool: name,
  result,
  children,
});
const active = (s: unknown) => workingIndicatorActive(s as never);

describe("workingIndicatorActive", () => {
  it("inactive when not busy", () => {
    expect(active(state(false, [assistant([{ kind: "text", text: "hi" }])]))).toBe(false);
  });

  it("active on a trailing finished text block in flight", () => {
    expect(active(state(true, [assistant([{ kind: "text", text: "Let me look…" }])]))).toBe(true);
  });

  it("active on a trailing unknown part", () => {
    expect(active(state(true, [assistant([{ kind: "unknown", label: "message part" }])]))).toBe(true);
  });

  it("active on the pre-token / trailing-user beat", () => {
    // The portal has no separate pre-token indicator, so the dots cover it.
    expect(active(state(true, [{ id: "u", role: "user", parts: [{ kind: "text", text: "q" }] }]))).toBe(true);
  });

  it("active on an empty assistant turn awaiting the first delta", () => {
    expect(active(state(true, [assistant([])]))).toBe(true);
  });

  it("inactive once the turn has ended", () => {
    expect(active(state(true, [assistant([{ kind: "text", text: "done" }], true)]))).toBe(false);
  });

  it("inactive on a live trailing thinking part", () => {
    expect(active(state(true, [assistant([{ kind: "thinking", text: "reasoning…" }])]))).toBe(false);
  });

  it("inactive on a pending singular tool with its own spinner", () => {
    expect(active(state(true, [assistant([tool("search_documents", null)])]))).toBe(false);
  });

  it("active on a completed singular tool before the next step", () => {
    expect(active(state(true, [assistant([tool("search_documents", { hits: [] })])]))).toBe(true);
  });

  it("inactive on a pending batch tool — the portal renders its child cards from args", () => {
    // Divergence from iOS/Android (which special-case an empty-children batch as active): the
    // portal reconstructs the pseudo-child cards from `args`, so a pending batch shows spinners.
    expect(active(state(true, [assistant([tool("search_many", null)])]))).toBe(false);
  });

  it("active on a completed batch tool", () => {
    expect(active(state(true, [assistant([tool("search_many", { items: [] })])]))).toBe(true);
  });

  it("inactive on a running sub-agent card", () => {
    expect(active(state(true, [assistant([{ kind: "subagent", status: null }])]))).toBe(false);
  });

  it("active on a finished sub-agent card", () => {
    expect(active(state(true, [assistant([{ kind: "subagent", status: "complete" }])]))).toBe(true);
  });
});
