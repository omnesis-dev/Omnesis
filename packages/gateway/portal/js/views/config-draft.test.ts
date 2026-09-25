// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  applyMergePatchToDraft,
  canonicalJson,
  diffConfigs,
  diffKind,
  dirtyPathsFor,
  formatDiffPath,
  formatDiffValue,
  isDirtyPath,
  jsonEqual,
  mergePatchFromDiffs,
  parseRawText,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./config-draft.js";
import {
  buildPatch,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./config-field-controls.js";

// All fixtures are invented: a fictional source id on a reserved domain,
// synthetic knobs, no corpus data.

const BASE = {
  dataRetention: { maxAge: "2y" },
  sources: {
    "example-drive:maya@example.com": { syncInterval: "5m", extractAttachments: true },
  },
  allowlist: ["a", "b"],
};

describe("applyMergePatchToDraft", () => {
  it("sets nested values without mutating the target", () => {
    const patch = { sources: { "example-drive:maya@example.com": { syncInterval: "10m" } } };
    const next = applyMergePatchToDraft(BASE, patch);

    expect(next.sources["example-drive:maya@example.com"].syncInterval).toBe("10m");
    expect(next.sources["example-drive:maya@example.com"].extractAttachments).toBe(true);
    expect(BASE.sources["example-drive:maya@example.com"].syncInterval).toBe("5m");
  });

  it("deletes keys on null and replaces arrays wholesale", () => {
    const next = applyMergePatchToDraft(BASE, {
      dataRetention: { maxAge: null },
      allowlist: ["c"],
    });

    expect(next.dataRetention).toEqual({});
    expect(next.allowlist).toEqual(["c"]);
    expect(BASE.allowlist).toEqual(["a", "b"]);
  });

  it("keeps a literal __proto__ record key as data through serialization", () => {
    // An object literal cannot name its own __proto__ key (it sets the
    // prototype), so build the patch the way the form does.
    const next = applyMergePatchToDraft(
      BASE,
      buildPatch(["sources", "__proto__", "syncInterval"], "5m"),
    );

    expect(Object.getPrototypeOf(next.sources)).toBe(Object.prototype);
    // An object literal cannot assert its own __proto__ key either, so
    // check the round-tripped record explicitly.
    const roundTripped = JSON.parse(JSON.stringify(next)).sources;
    expect(Object.hasOwn(roundTripped, "__proto__")).toBe(true);
    expect(roundTripped["__proto__"]).toEqual({ syncInterval: "5m" });
    expect(roundTripped["example-drive:maya@example.com"]).toEqual({
      syncInterval: "5m",
      extractAttachments: true,
    });
  });
});

describe("jsonEqual", () => {
  it("ignores object key order but not array order", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(jsonEqual({ v: undefined }, {})).toBe(false);
  });
});

describe("diffConfigs", () => {
  it("is empty for equal configs even when key order shifts", () => {
    const reordered = {
      allowlist: ["a", "b"],
      sources: {
        "example-drive:maya@example.com": { extractAttachments: true, syncInterval: "5m" },
      },
      dataRetention: { maxAge: "2y" },
    };
    expect(diffConfigs(BASE, reordered)).toEqual([]);
  });

  it("reports changed, added, and removed leaves with paths", () => {
    const next = {
      dataRetention: { maxAge: "30d" },
      sources: {
        "example-drive:maya@example.com": { syncInterval: "5m" },
        "example-notes:maya@example.com": { syncInterval: "1h" },
      },
      allowlist: ["a", "b"],
    };
    const diffs = diffConfigs(BASE, next);
    type DiffEntry = { path: string[]; oldValue: unknown; newValue: unknown };
    const kinds = new Map(
      (diffs as DiffEntry[]).map((d) => [formatDiffPath(d.path), diffKind(d)]),
    );

    expect(kinds.get("/dataRetention/maxAge")).toBe("changed");
    expect(kinds.get("/sources/example-drive:maya@example.com/extractAttachments")).toBe("removed");
    // An added subtree expands to one added entry per leaf.
    expect(kinds.get("/sources/example-notes:maya@example.com/syncInterval")).toBe("added");
    expect(diffs).toHaveLength(3);
  });

  it("treats an edited array as one wholesale entry", () => {
    const diffs = diffConfigs(BASE, { ...BASE, allowlist: ["a", "b", "c"] });
    expect(diffs).toHaveLength(1);
    expect(formatDiffPath(diffs[0].path)).toBe("/allowlist");
    expect(diffs[0].oldValue).toEqual(["a", "b"]);
    expect(diffs[0].newValue).toEqual(["a", "b", "c"]);
  });
});

describe("parseRawText", () => {
  it("parses valid JSON and reports invalid JSON with its error", () => {
    expect(parseRawText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseRawText('{"a":}');
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe("string");
  });

  it("rejects empty input so Save stays disabled on a cleared editor", () => {
    expect(parseRawText("").ok).toBe(false);
    expect(parseRawText("   ").ok).toBe(false);
  });
});

describe("mergePatchFromDiffs", () => {
  it("round-trips: applying the combined patch reproduces the draft", () => {
    const draft = {
      dataRetention: {},
      sources: {
        "example-drive:maya@example.com": { syncInterval: "10m", extractAttachments: true },
        "example-notes:maya@example.com": { syncInterval: "1h" },
      },
      allowlist: ["z"],
    };
    const diffs = diffConfigs(BASE, draft);
    expect(diffs.length).toBeGreaterThan(0);

    const patch = mergePatchFromDiffs(diffs);
    expect(applyMergePatchToDraft(BASE, patch)).toEqual(draft);
    // Removals travel as null so the gateway deletes the key.
    expect(patch.dataRetention.maxAge).toBeNull();
  });

  it("is empty for an empty diff", () => {
    expect(mergePatchFromDiffs([])).toEqual({});
  });

  it("throws on root-level diffs, which need a full PUT instead", () => {
    expect(() => mergePatchFromDiffs([{ path: [], oldValue: {}, newValue: [] }])).toThrow(
      /full PUT/,
    );
  });

  it("round-trips a __proto__ record key without touching prototypes", () => {
    const base = { sources: {} };
    const draft = JSON.parse('{"sources":{"__proto__":{"syncInterval":"5m"}}}');
    const diffs = diffConfigs(base, draft);
    expect(diffs).toHaveLength(1);
    const patch = mergePatchFromDiffs(diffs);
    const applied = applyMergePatchToDraft(base, patch);
    expect(Object.getPrototypeOf(applied.sources)).toBe(Object.prototype);
    expect(Object.hasOwn(applied.sources, "__proto__")).toBe(true);
  });

  it("maps an explicitly added null to a merge-patch delete", () => {
    // Under RFC 7396 null deletes: a raw-typed {"k": null} reviews as an
    // addition but persists as an absent key through PATCH (raw PUT
    // preserves explicit nulls; the schema has no nullable leaves).
    const diffs = diffConfigs({}, { k: null });
    expect(diffs).toHaveLength(1);
    expect(diffKind(diffs[0])).toBe("added");
    const applied = applyMergePatchToDraft({}, mergePatchFromDiffs(diffs));
    expect(applied).toEqual({});
  });
});

describe("diff display helpers", () => {
  it("escapes pointer separators in paths and marks absence", () => {
    expect(formatDiffPath(["sources", "type/account", "syncInterval"])).toBe(
      "/sources/type~1account/syncInterval",
    );
    expect(formatDiffPath(["a~b"])).toBe("/a~0b");
    expect(formatDiffValue(undefined)).toBe("—");
    expect(formatDiffValue("5m")).toBe('"5m"');
  });

  it("truncates long values", () => {
    const long = formatDiffValue({ items: Array.from({ length: 50 }, (_, i) => `value-${i}`) });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("dirtyPathsFor / isDirtyPath", () => {
  it("highlights only the added leaf, not untouched siblings under a new section", () => {
    // Reported QA bug: naming a fresh `self` section lit up Name, Emails,
    // and Phones. The added object must expand to leaf entries.
    const dirty = dirtyPathsFor({}, { self: { name: "Operator" } });

    expect(isDirtyPath(dirty, ["self", "name"])).toBe(true);
    expect(isDirtyPath(dirty, ["self", "emails"])).toBe(false);
    expect(isDirtyPath(dirty, ["self", "phones"])).toBe(false);
    expect(isDirtyPath(dirty, ["self"])).toBe(false);
  });

  it("marks changed leaves and fields under added subtrees", () => {
    const next = {
      dataRetention: { maxAge: "30d" },
      sources: {
        "example-drive:maya@example.com": { syncInterval: "5m" },
        "example-notes:maya@example.com": { syncInterval: "1h" },
      },
      allowlist: ["a", "b"],
    };
    const dirty = dirtyPathsFor(BASE, next);

    expect(isDirtyPath(dirty, ["dataRetention", "maxAge"])).toBe(true);
    expect(isDirtyPath(dirty, ["sources", "example-drive:maya@example.com", "extractAttachments"])).toBe(true);
    // The added subtree expands to a leaf entry, which highlights exactly.
    expect(isDirtyPath(dirty, ["sources", "example-notes:maya@example.com", "syncInterval"])).toBe(true);
    expect(isDirtyPath(dirty, ["allowlist"])).toBe(false);
    expect(isDirtyPath(dirty, ["dataRetention"])).toBe(false);
  });

  it("is empty without a draft, so highlights vanish with the edit", () => {
    expect(dirtyPathsFor(BASE, null).size).toBe(0);
    expect(isDirtyPath(new Set(), ["dataRetention", "maxAge"])).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("pretty-prints with the file's trailing newline", () => {
    expect(canonicalJson({ b: 2, a: [1] })).toBe('{\n  "b": 2,\n  "a": [\n    1\n  ]\n}\n');
  });
});
