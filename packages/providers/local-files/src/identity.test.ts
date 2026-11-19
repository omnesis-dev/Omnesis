// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { exactFileIdentity, fileIdentityKey, isExactFileIdentity } from "./identity.js";
import { localFilesStateSpec } from "./state.js";

const first = 9_007_199_254_740_992n;
const second = first + 1n;

describe("exact local file identities", () => {
  test("NTFS identifiers that round to the same Number keep distinct identity keys", () => {
    expect(Number(first)).toBe(Number(second));
    const a = exactFileIdentity({ dev: 42n, ino: first });
    const b = exactFileIdentity({ dev: 42n, ino: second });
    expect(a).not.toBe(b);
    expect(fileIdentityKey({ device: 42, inode: Number(first), fileIdentity: a })).toBe(
      `42:${first}`,
    );
    expect(fileIdentityKey({ device: 42, inode: Number(second), fileIdentity: b })).toBe(
      `42:${second}`,
    );
    expect(fileIdentityKey({ device: 42, inode: 7 })).toBe("42:7");
  });

  test("v1 state accepts installed numeric entries and the optional exact identity", () => {
    const entry = {
      mtime: 1,
      contentHash: "hash",
      rawHash: "raw",
      size: 1,
      inode: 7,
      device: 42,
      stableId: "ino:42:7",
    };
    for (const file of [entry, { ...entry, fileIdentity: `42:${first}` }]) {
      const cursor = { version: 1, fileMap: { "fictional-note": file } };
      expect(localFilesStateSpec.decode(cursor)).toEqual(cursor);
    }
    expect(
      localFilesStateSpec.decode({
        version: 1,
        fileMap: { "fictional-note": { ...entry, fileIdentity: "malformed" } },
      }),
    ).toBeNull();
    expect(isExactFileIdentity("42:0")).toBe(false);
    expect(() => exactFileIdentity({ dev: 42n, ino: 0n })).toThrow(/identity/);
  });
});
