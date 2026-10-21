// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises a plain-JS portal helper.
import { describe, expect, it } from "vitest";

import { anchorScrollTop, readingAnchor, replyEnded } from "./reading-anchor.js";

const user = (id: string) => ({ id, role: "user", parts: [{ kind: "text", text: "Q4 budget?" }] });
const assistant = (id: string) => ({ id, role: "assistant", parts: [{ kind: "text", text: "Here it is." }] });
const loaded = (turns: unknown[], extra = {}) => ({
  sessionId: "convo-1",
  busy: false,
  turns,
  messageCount: 4,
  ...extra,
});

describe("readingAnchor", () => {
  it("anchors an unread finished reply to its top", () => {
    const { turnId, seen } = readingAnchor(loaded([user("u-0"), assistant("a-1")]), null);
    expect(turnId).toBe("a-1");
    expect(seen).toEqual({ reply: "convo-1#4" });
  });

  it("follows the bottom when the owner's message is the last turn", () => {
    const before = { reply: "convo-1#2" };
    expect(readingAnchor(loaded([assistant("a-0"), user("u-1")]), before)).toEqual({
      turnId: null,
      seen: before,
    });
  });

  it("follows the bottom while the agent is mid-turn", () => {
    const result = readingAnchor(loaded([user("u-0"), assistant("a-1")], { busy: true }), null);
    expect(result).toEqual({ turnId: null, seen: null });
  });

  it("follows the bottom for an empty conversation", () => {
    expect(readingAnchor(loaded([]), null).turnId).toBeNull();
  });

  it("does not re-anchor a reply the reader was already positioned on", () => {
    const first = readingAnchor(loaded([user("u-0"), assistant("a-1")]), null);
    const again = readingAnchor(loaded([user("u-0"), assistant("a-1")]), first.seen);
    expect(again.turnId).toBeNull();
  });

  it("anchors a newer reply in the same conversation", () => {
    const seen = { reply: "convo-1#2" };
    expect(readingAnchor(loaded([user("u-0"), assistant("a-1")]), seen).turnId).toBe("a-1");
  });

  it("anchors the same reply count in another conversation", () => {
    const seen = { reply: "convo-2#4" };
    expect(readingAnchor(loaded([user("u-0"), assistant("a-1")]), seen).turnId).toBe("a-1");
  });

  it("leaves a reply watched to its end at the bottom and remembers it", () => {
    const { turnId, seen } = readingAnchor(
      loaded([user("u-0"), assistant("a-1")]),
      replyEnded("convo-1", true),
    );
    expect(turnId).toBeNull();
    expect(seen).toEqual({ reply: "convo-1#4" });
  });

  it("anchors a reply that finished while the page was in the background", () => {
    const result = readingAnchor(loaded([user("u-0"), assistant("a-1")]), replyEnded("convo-1", false));
    expect(result.turnId).toBe("a-1");
  });

  it("anchors a reply watched in another conversation", () => {
    const result = readingAnchor(loaded([user("u-0"), assistant("a-1")]), replyEnded("convo-2", true));
    expect(result.turnId).toBe("a-1");
  });

  it("anchors the latest Morning brief, which no message precedes", () => {
    const brief = { ...assistant("a-2"), brief: { day: "2026-03-04" } };
    expect(readingAnchor(loaded([assistant("a-0"), user("u-1"), brief]), null).turnId).toBe("a-2");
  });
});

describe("anchorScrollTop", () => {
  const box = (top: number, scrollTop = 0) => ({ scrollTop, getBoundingClientRect: () => ({ top }) });

  it("brings the target's top just under the container's top", () => {
    expect(anchorScrollTop(box(100, 50), box(700))).toBe(50 + 600 - 8);
  });

  it("never scrolls above the start", () => {
    expect(anchorScrollTop(box(100), box(102))).toBe(0);
  });
});
