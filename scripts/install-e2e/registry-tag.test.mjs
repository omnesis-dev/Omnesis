// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { newestCommonTag, nextPage } from "./registry-tag.mjs";

describe("newestCommonTag", () => {
  it("takes the newest X.Y.Z tag every image carries, numerically", () => {
    expect(
      newestCommonTag([
        ["0.9.0", "0.10.0", "0.10.1", "latest", "sha-abc123"],
        ["0.9.0", "0.10.0", "0.11.0-rc.1"],
      ]),
    ).toBe("0.10.0");
  });

  it("is null when no stable tag is common to all images", () => {
    expect(newestCommonTag([["1.0.0"], ["1.0.1"]])).toBeNull();
    expect(newestCommonTag([["latest"], ["latest"]])).toBeNull();
  });
});

describe("nextPage", () => {
  const url = "https://registry.example/v2/ns/image/tags/list?n=1000";

  it("follows the registry's Link header, relative or absolute", () => {
    expect(nextPage('</v2/ns/image/tags/list?last=0.9.0&n=1000>; rel="next"', url)).toBe(
      "https://registry.example/v2/ns/image/tags/list?last=0.9.0&n=1000",
    );
    expect(nextPage("<https://other.example/page2>; rel=next", url)).toBe(
      "https://other.example/page2",
    );
  });

  it("is null on the last page", () => {
    expect(nextPage(null, url)).toBeNull();
    expect(nextPage('</v2/x>; rel="prev"', url)).toBeNull();
  });
});
