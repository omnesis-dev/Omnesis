// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { parseToolArgs, toolArgsUnparseableResult } from "./backend.js";

describe("parseToolArgs", () => {
  it("parses a JSON object", () => {
    expect(parseToolArgs('{"query":"quarterly budget"}')).toEqual({
      ok: true,
      args: { query: "quarterly budget" },
    });
  });

  it("treats an empty string as a no-argument call", () => {
    expect(parseToolArgs("")).toEqual({ ok: true, args: {} });
  });

  it("treats a whitespace-only string as a no-argument call", () => {
    expect(parseToolArgs("  \n\t ")).toEqual({ ok: true, args: {} });
  });

  it("passes non-object JSON values through unchanged", () => {
    expect(parseToolArgs("[1,2]")).toEqual({ ok: true, args: [1, 2] });
  });

  it("reports truncated JSON instead of coercing to {}", () => {
    const out = parseToolArgs('{"query":"unfini');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.length).toBeGreaterThan(0);
  });

  it("reports a non-JSON wrapper instead of coercing to {}", () => {
    const out = parseToolArgs('args={"query":"x"}');
    expect(out.ok).toBe(false);
  });
});

describe("toolArgsUnparseableResult", () => {
  it("carries the parse error and echoes the raw arguments", () => {
    const result = toolArgsUnparseableResult("Unexpected end of JSON input", '{"query":"unfini');
    expect(result).toMatchObject({ kind: "error", code: "tool_args_unparseable" });
    if (result.kind === "error") {
      expect(result.message).toContain("Unexpected end of JSON input");
      expect(result.message).toContain('{"query":"unfini');
      expect(result.message).toContain("Re-issue the call");
    }
  });

  it("truncates a very long raw string to keep the transcript bounded", () => {
    const raw = `{"note":"${"x".repeat(5000)}`;
    const result = toolArgsUnparseableResult("Unexpected end of JSON input", raw);
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.message).toContain("[truncated]");
    expect(result.message.length).toBeLessThan(2500);
  });
});
