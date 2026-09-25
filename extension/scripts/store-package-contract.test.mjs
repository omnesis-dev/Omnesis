// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  assertArtifactReplacement,
  assertReleaseCheckout,
  assertReleaseVersions,
  assertStoreFiles,
} from "./store-package-contract.mjs";

describe("Chrome store package fail-closed guards", () => {
  it("rejects version drift and a non-MV3 manifest", () => {
    expect(() =>
      assertReleaseVersions(
        { version: "1", manifest_version: 3 },
        { version: "2" },
        { productVersion: "1" },
      ),
    ).toThrow(/versions must match/u);
    expect(() =>
      assertReleaseVersions(
        { version: "1", manifest_version: 2 },
        { version: "1" },
        { productVersion: "1" },
      ),
    ).toThrow(/Manifest V3/u);
  });

  it("requires an exact recorded commit and a clean matching checkout", () => {
    const commit = "a".repeat(40);
    expect(() => assertReleaseCheckout({ dirty: "", head: commit })).toThrow(
      /OMNESIS_EXTENSION_RELEASE_COMMIT/u,
    );
    expect(() =>
      assertReleaseCheckout({ dirty: "", head: commit, expectedCommit: "A".repeat(40) }),
    ).toThrow(/exact lowercase Git SHA/u);
    expect(() =>
      assertReleaseCheckout({ dirty: " M file", head: commit, expectedCommit: commit }),
    ).toThrow(/clean checkout/u);
    expect(() =>
      assertReleaseCheckout({ dirty: "", head: commit, expectedCommit: "b".repeat(40) }),
    ).toThrow(/recorded release commit/u);
    expect(() =>
      assertReleaseCheckout({ dirty: "", head: commit, expectedCommit: commit }),
    ).not.toThrow();
  });

  it("rejects unexpected archive inputs", () => {
    expect(() => assertStoreFiles(["manifest.json", "surprise.js"], ["manifest.json"])).toThrow(
      /Unexpected store package contents/u,
    );
  });

  it("refuses to replace a same-version release with different bytes", () => {
    expect(() =>
      assertArtifactReplacement({
        releaseMode: true,
        existing: Buffer.from("old"),
        bytes: Buffer.from("new"),
        artifact: "release.zip",
      }),
    ).toThrow(/Refusing to overwrite/u);
    expect(() =>
      assertArtifactReplacement({
        releaseMode: true,
        existing: Buffer.from("same"),
        bytes: Buffer.from("same"),
        artifact: "release.zip",
      }),
    ).not.toThrow();
  });
});
