// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { stripThinkTags, createThinkTagFilter, toErrorMessage } from "./utils.js";

describe("stripThinkTags", () => {
  it("removes a closed <think> span and keeps the answer", () => {
    expect(stripThinkTags("<think>reasoning here</think>The answer")).toBe("The answer");
  });

  it("keeps text before and after a closed span", () => {
    expect(stripThinkTags("before <think>mid</think> after")).toBe("before  after".trim());
  });

  it("drops an unclosed <think> to the end (some servers omit the close)", () => {
    expect(stripThinkTags("partial answer<think>and then reasoning that never closes")).toBe(
      "partial answer",
    );
  });

  it("returns the text unchanged when there is no think tag", () => {
    expect(stripThinkTags("just a normal answer")).toBe("just a normal answer");
  });

  it("is case-insensitive and handles multiline reasoning", () => {
    expect(stripThinkTags("<THINK>line1\nline2</THINK>done")).toBe("done");
  });
});

describe("createThinkTagFilter", () => {
  it("suppresses a think span that arrives in one chunk", () => {
    const f = createThinkTagFilter();
    expect(f.sawThinking).toBe(false);
    expect(f.push("<think>secret</think>answer")).toBe("answer");
    expect(f.sawThinking).toBe(true);
    expect(f.flush()).toBe("");
    expect(f.sawThinking).toBe(true);
  });

  it("suppresses a think tag split across multiple chunks", () => {
    const f = createThinkTagFilter();
    // The opening tag and closing tag are split mid-token across deltas.
    let out = "";
    out += f.push("<thi");
    out += f.push("nk>secret rea");
    out += f.push("soning</thi");
    out += f.push("nk>visible ");
    out += f.push("answer");
    out += f.flush();
    expect(out).toBe("visible answer");
  });

  it("passes through normal text immediately, holding back only a partial tag", () => {
    const f = createThinkTagFilter();
    expect(f.push("hello world")).toBe("hello world");
    // A lone "<" could be the start of <think>, so it's held until disambiguated.
    expect(f.push("<")).toBe("");
    expect(f.push("x>more")).toBe("<x>more");
    expect(f.flush()).toBe("");
  });

  it("flushes a held partial that never became a tag", () => {
    const f = createThinkTagFilter();
    expect(f.push("answer<thi")).toBe("answer");
    // Stream ended mid-"<thi" — it wasn't a real tag, so emit it.
    expect(f.flush()).toBe("<thi");
  });

  it("drops content still inside an unclosed think block at flush", () => {
    const f = createThinkTagFilter();
    expect(f.push("<think>reasoning with no close")).toBe("");
    expect(f.flush()).toBe("");
  });
});

describe("toErrorMessage", () => {
  it("returns a plain error's message", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-error throw", () => {
    expect(toErrorMessage("just a string")).toBe("just a string");
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("names the reason behind a fetch failure instead of the category", () => {
    // The exact shape Node's fetch() rejects with: a bare TypeError whose
    // cause holds the socket failure that actually happened.
    const cause = new Error("read ECONNRESET");
    const err = new TypeError("fetch failed", { cause });
    expect(toErrorMessage(err)).toBe("fetch failed: read ECONNRESET");
  });

  it("steps into an AggregateError's failures, which sit outside cause", () => {
    const aggregate = new AggregateError([
      new Error("connect ECONNREFUSED 203.0.113.7:443"),
      new Error("connect ECONNREFUSED 203.0.113.8:443"),
    ]);
    const err = new TypeError("fetch failed", { cause: aggregate });
    expect(toErrorMessage(err)).toBe("fetch failed: connect ECONNREFUSED 203.0.113.7:443");
  });

  it("names the class when every link is silent", () => {
    expect(toErrorMessage(new AggregateError([]))).toBe("AggregateError");
  });

  it("falls back to code when a link carries no message", () => {
    const cause = Object.assign(new Error(""), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(toErrorMessage(new TypeError("fetch failed", { cause }))).toBe(
      "fetch failed: UND_ERR_CONNECT_TIMEOUT",
    );
  });

  it("does not repeat a reason a wrapper already quoted", () => {
    // The shape half this codebase throws: the wrapper names itself and
    // embeds its cause's text. Joining naively says the reason twice.
    const cause = new TypeError("fetch failed", { cause: new Error("other side closed") });
    const wrapper = new Error(`check failed: ${cause.message}: other side closed`, { cause });
    expect(toErrorMessage(wrapper)).toBe("check failed: fetch failed: other side closed");
  });

  it("states a repeated message once", () => {
    // A provider mapper that rethrows with the SDK's own text would otherwise
    // render "fetch failed: fetch failed".
    const inner = new TypeError("fetch failed");
    const outer = new Error("fetch failed", { cause: inner });
    expect(toErrorMessage(outer)).toBe("fetch failed");
  });

  it("terminates on a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(toErrorMessage(b)).toBe("b: a");
  });

  it("bounds a long chain", () => {
    let err = new Error("link0");
    for (let i = 1; i < 12; i += 1) err = new Error(`link${i}`, { cause: err });
    const out = toErrorMessage(err);
    expect(out.split(": ")).toHaveLength(5);
    expect(out).toBe("link11: link10: link9: link8: link7");
  });
});
