// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { GO_CACHE_DIR, OUTPUT_DIR, helperProgram } from "./outputs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The .gitignore rule that ignores `path`, as `<pattern>`, or null when nothing does. */
function ignoringRule(path) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-v", path], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  // <source>:<line>:<pattern>\t<path>
  return result.stdout.split("\t")[0].split(":").slice(2).join(":");
}

describe("the Tailscale helper's build outputs", () => {
  // An older release's updater refuses a checkout whose `git status` lists
  // anything, and an update that rolls back to that release leaves these files
  // behind. Only rules that every release carries keep that checkout clean.
  const outputs = [
    helperProgram(false),
    helperProgram(true),
    join(GO_CACHE_DIR, "toolchains", "go1.0.0", "bin", "go"),
    join(GO_CACHE_DIR, "path", "pkg", "mod", "cache", "download", "list"),
    join(GO_CACHE_DIR, "build", "README"),
  ];

  test.each(outputs)("%s is ignored by the generic dist/ rule", (path) => {
    expect(relative(OUTPUT_DIR, path).startsWith("..")).toBe(false);
    expect(ignoringRule(path)).toBe("dist/");
  });

  test("the gateway looks for the program where the build puts it", () => {
    const source = readFileSync(
      join(root, "packages/gateway/src/tailscale-embed/helper-binary.ts"),
      "utf8",
    );
    // The source names the program in a URL, which always uses "/".
    const fromGatewaySrc = relative(
      join(root, "packages/gateway/src/tailscale-embed"),
      join(root, helperProgram(false)),
    )
      .split(sep)
      .join("/");
    expect(source).toContain(`\`${fromGatewaySrc}\${`);
  });
});
