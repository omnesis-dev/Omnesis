// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  computeFootprint,
  isFeaturePath,
  parseFeaturePaths,
  parseNumstat,
  resolveRenamePath,
} from "./footprint.js";

const briefsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("parseNumstat", () => {
  it("parses added/deleted counts and paths", () => {
    const entries = parseNumstat("12\t3\tpackages/gateway/src/brain/store.ts\n0\t7\tREADME.md\n");
    expect(entries).toEqual([
      { path: "packages/gateway/src/brain/store.ts", added: 12, deleted: 3 },
      { path: "README.md", added: 0, deleted: 7 },
    ]);
  });

  it("marks binary files with null line counts", () => {
    expect(parseNumstat("-\t-\tassets/logo.png\n")).toEqual([
      { path: "assets/logo.png", added: null, deleted: null },
    ]);
  });

  it("ignores blank lines", () => {
    expect(parseNumstat("\n\n")).toEqual([]);
  });
});

describe("resolveRenamePath", () => {
  it("resolves braced renames to the post-rename path", () => {
    expect(resolveRenamePath("packages/{old-name => new-name}/src/index.ts")).toBe(
      "packages/new-name/src/index.ts",
    );
  });

  it("collapses the empty segment of a segment-dropping rename", () => {
    expect(resolveRenamePath("packages/core/{nested => }/file.ts")).toBe("packages/core/file.ts");
  });

  it("resolves whole-path renames", () => {
    expect(resolveRenamePath("old/path.ts => new/path.ts")).toBe("new/path.ts");
  });

  it("leaves ordinary paths alone", () => {
    expect(resolveRenamePath("a/b/c.ts")).toBe("a/b/c.ts");
  });
});

describe("feature-path matching", () => {
  const prefixes = [
    "evals/briefs/",
    "packages/gateway/src/brain/",
    "packages/cli/src/commands/briefs.ts",
  ];

  it("matches files under a directory prefix", () => {
    expect(isFeaturePath("evals/briefs/src/spend-meter.ts", prefixes)).toBe(true);
    expect(isFeaturePath("packages/gateway/src/brain/store.ts", prefixes)).toBe(true);
  });

  it("matches an exact file entry", () => {
    expect(isFeaturePath("packages/cli/src/commands/briefs.ts", prefixes)).toBe(true);
  });

  it("does not match siblings or prefix-similar paths", () => {
    expect(isFeaturePath("packages/gateway/src/brain-unrelated/store.ts", prefixes)).toBe(false);
    expect(isFeaturePath("packages/cli/src/commands/briefs.test.ts", prefixes)).toBe(false);
    expect(isFeaturePath("packages/gateway/src/server.ts", prefixes)).toBe(false);
  });
});

describe("computeFootprint", () => {
  it("splits changed lines into feature vs shared and totals them", () => {
    const { feature, shared } = computeFootprint(
      [
        { path: "evals/briefs/src/spend-meter.ts", added: 100, deleted: 0 },
        { path: "packages/gateway/src/server.ts", added: 1, deleted: 1 },
        { path: "vitest.config.ts", added: 1, deleted: 0 },
        { path: "assets/logo.png", added: null, deleted: null },
      ],
      ["evals/briefs/"],
    );
    expect(feature).toMatchObject({ files: 1, added: 100, deleted: 0 });
    expect(shared).toMatchObject({ files: 3, added: 2, deleted: 1 });
    expect(shared.entries.map((entry) => entry.path)).toContain("assets/logo.png");
  });
});

describe("committed allowlist", () => {
  it("feature-paths.txt parses and covers the briefs eval subtree itself", () => {
    const prefixes = parseFeaturePaths(readFileSync(join(briefsDir, "feature-paths.txt"), "utf8"));
    expect(prefixes.length).toBeGreaterThan(0);
    expect(isFeaturePath("evals/briefs/src/footprint.ts", prefixes)).toBe(true);
    expect(isFeaturePath("packages/gateway/src/server.ts", prefixes)).toBe(false);
  });
});
