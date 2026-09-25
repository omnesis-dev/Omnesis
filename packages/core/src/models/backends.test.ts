// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { normalizeApiPathPrefix, extractModelIds } from "./backends.js";

describe("normalizeApiPathPrefix", () => {
  it("defaults to /v1 when unset or blank", () => {
    expect(normalizeApiPathPrefix(undefined)).toBe("/v1");
    expect(normalizeApiPathPrefix("")).toBe("/v1");
    expect(normalizeApiPathPrefix("   ")).toBe("/v1");
  });

  it("adds a leading slash and strips trailing slashes", () => {
    expect(normalizeApiPathPrefix("v1beta/openai")).toBe("/v1beta/openai");
    expect(normalizeApiPathPrefix("/v1/")).toBe("/v1");
  });
});

describe("extractModelIds", () => {
  it("parses the OpenAI-spec envelope { data: [{ id }] }", () => {
    const json = {
      object: "list",
      data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }],
    };
    expect(extractModelIds(json)).toEqual(["gpt-4o", "text-embedding-3-small"]);
  });

  it("parses a bare top-level array (Together AI shape)", () => {
    const json = [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", type: "chat" },
      { id: "intfloat/multilingual-e5-large-instruct", type: "embedding" },
    ];
    expect(extractModelIds(json)).toEqual([
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "intfloat/multilingual-e5-large-instruct",
    ]);
  });

  it("accepts bare id strings in the list", () => {
    expect(extractModelIds(["a", "b"])).toEqual(["a", "b"]);
    expect(extractModelIds({ data: ["a", { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("skips items without a usable id and tolerates junk", () => {
    expect(extractModelIds({ data: [{ id: "ok" }, {}, { id: 5 }, null] })).toEqual(["ok"]);
    expect(extractModelIds([{ id: "ok" }, "", { name: "x" }])).toEqual(["ok"]);
  });

  it("returns an empty array for non-list shapes", () => {
    expect(extractModelIds(null)).toEqual([]);
    expect(extractModelIds(undefined)).toEqual([]);
    expect(extractModelIds({})).toEqual([]);
    expect(extractModelIds({ data: "nope" })).toEqual([]);
    expect(extractModelIds("string")).toEqual([]);
  });
});
