// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { diffConfigPaths } from "./config-diff.js";

describe("diffConfigPaths", () => {
  test("no diff when equal", () => {
    expect(diffConfigPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });

  test("scalar change", () => {
    expect(diffConfigPaths({ a: 1 }, { a: 2 })).toEqual(["/a"]);
  });

  test("added key", () => {
    expect(diffConfigPaths({}, { a: 1 })).toEqual(["/a"]);
  });

  test("removed key", () => {
    expect(diffConfigPaths({ a: 1 }, {})).toEqual(["/a"]);
  });

  test("nested", () => {
    expect(diffConfigPaths({ a: { b: 1 } }, { a: { b: 2 } })).toEqual(["/a/b"]);
  });

  test("an added subtree reports its leaves", () => {
    expect(diffConfigPaths({}, { gateway: { mdns: { enabled: false } } })).toEqual([
      "/gateway/mdns/enabled",
    ]);
  });

  test("arrays compared wholesale", () => {
    expect(diffConfigPaths({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(diffConfigPaths({ a: [1, 2] }, { a: [1, 3] })).toEqual(["/a"]);
  });

  test("keys with slashes and tildes are escaped; colons stay literal", () => {
    const before = { sources: { "gmail:maya@example.com": { syncInterval: "5m" } } };
    const after = { sources: { "gmail:maya@example.com": { syncInterval: "2m" } } };
    expect(diffConfigPaths(before, after)).toEqual([
      "/sources/gmail:maya@example.com/syncInterval",
    ]);
    expect(diffConfigPaths({}, { "a/b~c": 1 })).toEqual(["/a~1b~0c"]);
  });
});
