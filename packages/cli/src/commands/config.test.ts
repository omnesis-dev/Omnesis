// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  parseConfigPath,
  buildNestedPatch,
  navigate,
  coerceValue,
  buildVersionConflictHeader,
  inertSourceKnobAt,
} from "./config.js";

describe("parseConfigPath", () => {
  test("empty paths", () => {
    expect(parseConfigPath("")).toEqual([]);
    expect(parseConfigPath("/")).toEqual([]);
  });

  test("dot-path shorthand", () => {
    expect(parseConfigPath("indexer.model")).toEqual(["indexer", "model"]);
    expect(parseConfigPath("search.defaultLimit")).toEqual(["search", "defaultLimit"]);
  });

  test("JSON pointer style", () => {
    expect(parseConfigPath("/search/defaultLimit")).toEqual(["search", "defaultLimit"]);
  });

  test("JSON pointer with source-id containing dots and colons", () => {
    expect(parseConfigPath("/sources/gmail:jamesbond@gmail.com/syncInterval")).toEqual([
      "sources",
      "gmail:jamesbond@gmail.com",
      "syncInterval",
    ]);
  });

  test("JSON pointer escapes ~0 and ~1", () => {
    expect(parseConfigPath("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });

  test("dot-path ignores trailing/double dots", () => {
    expect(parseConfigPath("a..b")).toEqual(["a", "b"]);
    expect(parseConfigPath("a.")).toEqual(["a"]);
  });
});

describe("buildNestedPatch", () => {
  test("single segment", () => {
    expect(buildNestedPatch(["a"], 42)).toEqual({ a: 42 });
  });

  test("nested segments build nested objects", () => {
    expect(buildNestedPatch(["a", "b", "c"], "hi")).toEqual({ a: { b: { c: "hi" } } });
  });

  test("null value preserved (for merge-patch delete)", () => {
    expect(buildNestedPatch(["sources", "gmail:x@y.com"], null)).toEqual({
      sources: { "gmail:x@y.com": null },
    });
  });

  test("empty segments returns the value itself", () => {
    expect(buildNestedPatch([], { a: 1 })).toEqual({ a: 1 });
  });
});

describe("navigate", () => {
  const cfg = {
    indexer: { model: "foo.gguf" },
    sources: { "gmail:x@y.com": { syncInterval: "2m" } },
  };

  test("returns sub-tree", () => {
    expect(navigate(cfg, ["indexer"])).toEqual({ model: "foo.gguf" });
  });

  test("returns leaf values", () => {
    expect(navigate(cfg, ["indexer", "model"])).toBe("foo.gguf");
    expect(navigate(cfg, ["sources", "gmail:x@y.com", "syncInterval"])).toBe("2m");
  });

  test("empty segments returns the whole object", () => {
    expect(navigate(cfg, [])).toEqual(cfg);
  });

  test("missing path returns undefined", () => {
    expect(navigate(cfg, ["missing"])).toBeUndefined();
    expect(navigate(cfg, ["indexer", "missing"])).toBeUndefined();
  });
});

describe("coerceValue", () => {
  test("booleans", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("false")).toBe(false);
  });

  test("null", () => {
    expect(coerceValue("null")).toBeNull();
  });

  test("integers + decimals", () => {
    expect(coerceValue("42")).toBe(42);
    expect(coerceValue("-3")).toBe(-3);
    expect(coerceValue("1.5")).toBe(1.5);
  });

  test("JSON arrays and objects", () => {
    expect(coerceValue("[1,2,3]")).toEqual([1, 2, 3]);
    expect(coerceValue('{"k":"v"}')).toEqual({ k: "v" });
  });

  test("quoted string forces string type", () => {
    expect(coerceValue('"42"')).toBe("42");
    expect(coerceValue('"true"')).toBe("true");
  });

  test("duration strings are unquoted strings by default", () => {
    expect(coerceValue("5m")).toBe("5m");
    expect(coerceValue("2h")).toBe("2h");
    expect(coerceValue("1y")).toBe("1y");
  });

  test("empty string stays empty", () => {
    expect(coerceValue("")).toBe("");
  });

  test("whitespace around values is trimmed for coercion, raw kept for strings", () => {
    expect(coerceValue("  true  ")).toBe(true);
    // For arbitrary strings we preserve the raw (the CLI already passed a
    // single argv slot, so preserving exact whitespace is the user's call).
    expect(coerceValue("hello world")).toBe("hello world");
  });

  test("malformed JSON falls back to string", () => {
    expect(coerceValue("[1,2")).toBe("[1,2");
  });
});

describe("inertSourceKnobAt", () => {
  test("returns the knob name for an inert per-source ingestion setting", () => {
    expect(inertSourceKnobAt(["sources", "apple-health:local", "syncInterval"])).toBe(
      "syncInterval",
    );
    expect(inertSourceKnobAt(["sources", "apple-health:local", "extractAttachments"])).toBe(
      "extractAttachments",
    );
    expect(inertSourceKnobAt(["sources", "apple-health:local", "maxAge"])).toBe("maxAge");
    expect(inertSourceKnobAt(["sources", "apple-health:local", "attachmentTypes"])).toBe(
      "attachmentTypes",
    );
  });

  test("returns null for params (still applies to push-based sources)", () => {
    expect(inertSourceKnobAt(["sources", "apple-health:local", "params"])).toBeNull();
  });

  test("returns null for non-knob source keys and non-source paths", () => {
    expect(inertSourceKnobAt(["sources", "gmail:x@y.com", "enabled"])).toBeNull();
    expect(inertSourceKnobAt(["sources", "apple-health:local"])).toBeNull();
    expect(inertSourceKnobAt(["indexer", "model"])).toBeNull();
    expect(inertSourceKnobAt([])).toBeNull();
  });
});

describe("buildVersionConflictHeader", () => {
  test("includes both old and new version numbers", () => {
    const header = buildVersionConflictHeader(7, 9);
    expect(header).toContain("was version 7");
    expect(header).toContain("now 9");
  });

  test("every line is a // JSON-with-comments comment so the editor strip-prelude regex still matches", () => {
    const header = buildVersionConflictHeader(1, 2);
    for (const line of header.split("\n")) {
      expect(line.startsWith("//")).toBe(true);
    }
  });

  test("describes both 'reload' and 'discard' user options so the user knows what to do", () => {
    const header = buildVersionConflictHeader(3, 4);
    // The user must understand they can keep editing on top of the fresh
    // contents OR exit without saving to abort. Otherwise the conflict
    // header is just noise.
    expect(header.toLowerCase()).toContain("reloaded");
    expect(header.toLowerCase()).toMatch(/exit|abort/);
  });

  test("flags the conflict as an ERROR-level prelude (not just informational)", () => {
    // The same regex strips ERROR + non-ERROR // prelude lines, so the
    // marker is for the human, not the editor — but it must still scream.
    expect(buildVersionConflictHeader(0, 1)).toContain("ERROR");
  });
});
