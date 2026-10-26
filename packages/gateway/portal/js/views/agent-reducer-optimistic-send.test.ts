// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A message shows the instant it is sent, keyed by its submission id. The
// gateway's `agent.user.message` event carries the ids it accepted, so the
// placeholder is renamed rather than repeated; a refused send withdraws it.

import { describe, expect, it } from "vitest";

import { reducer, initialState } from "./agent-reducer.js";

const r = reducer;
const sid = "sess-o";

function sent(text: string, optimisticId: string) {
  return r({ ...initialState(), sessionId: sid }, { kind: "user-send", text, optimisticId });
}

function userMessage(userMessageId: string, text: string, submissionIds?: string[]) {
  return {
    kind: "agent.user.message",
    payload: { sessionId: sid, userMessageId, text, ...(submissionIds ? { submissionIds } : {}) },
  };
}

describe("portal reducer — a send shows before the gateway confirms it", () => {
  it("renames the placeholder when the user-message event carries its submission id", () => {
    let s = sent("hi", "sub-1");
    expect(s.busy).toBe(true);
    expect(s.turns.map((t) => t.id)).toEqual(["sub-1"]);
    s = r(s, userMessage("u-1", "hi", ["sub-1"]));
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({ id: "u-1", role: "user", parts: [{ kind: "text", text: "hi" }] });
  });

  it("keeps the research flag of a renamed placeholder", () => {
    let s = r({ ...initialState(), sessionId: sid }, { kind: "user-send", text: "dig", optimisticId: "sub-1", deepResearch: true });
    s = r(s, userMessage("u-1", "dig", ["sub-1"]));
    expect(s.turns[0]).toMatchObject({ id: "u-1", deepResearch: true });
  });

  it("collapses coalesced placeholders into the single stamped turn, in the first one's place", () => {
    let s = sent("first", "sub-1");
    s = r(s, { kind: "agent.message.start", payload: { sessionId: sid, messageId: "m-0" } });
    s = r(s, { kind: "user-send", text: "second", optimisticId: "sub-2" });
    s = r(s, { kind: "user-send", text: "third", optimisticId: "sub-3" });
    s = r(s, userMessage("u-1", "second\n\nthird", ["sub-2", "sub-3"]));
    expect(s.turns.map((t) => t.id)).toEqual(["sub-1", "m-0", "u-1"]);
    expect(s.turns[2].parts).toEqual([{ kind: "text", text: "second\n\nthird" }]);
  });

  it("appends a message another device sent as a new turn", () => {
    let s = sent("hi", "sub-1");
    s = r(s, userMessage("u-1", "hi", ["sub-1"]));
    s = r(s, userMessage("u-2", "from my phone", ["someone-elses-id"]));
    s = r(s, userMessage("u-3", "legacy gateway, no ids"));
    expect(s.turns.map((t) => t.id)).toEqual(["u-1", "u-2", "u-3"]);
  });

  it("delivers a stamped turn once however many times the event repeats", () => {
    let s = sent("hi", "sub-1");
    s = r(s, userMessage("u-1", "hi", ["sub-1"]));
    const again = r(s, userMessage("u-1", "hi", ["sub-1"]));
    expect(again).toBe(s);
  });

  it("a refused send withdraws its placeholder and releases busy", () => {
    let s = sent("hi", "sub-1");
    s = r(s, { kind: "user-send-rejected", optimisticId: "sub-1" });
    expect(s.turns).toEqual([]);
    expect(s.busy).toBe(false);
  });

  it("a refused interrupt leaves the still-streaming assistant turn busy", () => {
    let s = { ...initialState(), sessionId: sid };
    s = r(s, { kind: "agent.message.start", payload: { sessionId: sid, messageId: "m-1" } });
    s = r(s, { kind: "user-send", text: "no, do this instead", optimisticId: "sub-1" });
    s = r(s, { kind: "user-send-rejected", optimisticId: "sub-1" });
    expect(s.turns.map((t) => t.id)).toEqual(["m-1"]);
    expect(s.busy).toBe(true);
  });

  it("withdrawing an unknown placeholder changes nothing", () => {
    const s = sent("hi", "sub-1");
    expect(r(s, { kind: "user-send-rejected", optimisticId: "never-sent" })).toBe(s);
  });
});
