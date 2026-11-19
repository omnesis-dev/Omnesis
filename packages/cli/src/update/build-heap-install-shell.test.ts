// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { buildNodeOptions } from "./build-heap.js";

describe("the installer's shell copy of the policy", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /**
   * `usable_memory_mb` and `build_node_options`, sliced out of install.sh and
   * run under sh with the memory stated, so the shell's heap arithmetic
   * answers the same table this module answers. How the memory is read is
   * each side's own.
   */
  function shellPolicy(memoryMb: number, nodeOptions: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-build-heap-"));
    scratch.push(dir);
    const installer = readFileSync(
      fileURLToPath(new URL("../../../../scripts/install.sh", import.meta.url)),
      "utf8",
    );
    const memStart = installer.indexOf("usable_memory_mb() {");
    const memEnd = installer.indexOf("\n}\n", memStart) + 3;
    const optStart = installer.indexOf("build_node_options() {");
    const optEnd = installer.indexOf("\n}\n", optStart) + 3;
    expect(memStart).toBeGreaterThan(0);
    expect(optStart).toBeGreaterThan(0);
    const script = join(dir, "policy.sh");
    writeFileSync(
      script,
      `PLATFORM=linux\n${installer.slice(memStart, memEnd)}\n${installer.slice(optStart, optEnd)}\nbuild_node_options\n`,
    );
    // The memory is stated, so the shell's arithmetic is what runs — not this
    // host's own /proc/meminfo, which would make the answer depend on the
    // machine running the suite.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      OMNESIS_BUILD_MEMORY_MB: String(memoryMb),
    };
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    return execFileSync("sh", [script], { encoding: "utf8", env });
  }

  test.each([
    [1024, undefined],
    [4096, undefined],
    [4098, undefined],
    [6144, undefined],
    [7168, undefined],
    [8192, undefined],
    [16386, undefined],
    [131_072, undefined],
    [131_072, "--max-old-space-size=512"],
    [8192, "--enable-source-maps"],
    [1024, "--enable-source-maps"],
  ] as const)(
    "agrees with the TypeScript policy for %s MiB and NODE_OPTIONS=%s",
    (memoryMb, nodeOptions) => {
      expect(shellPolicy(memoryMb, nodeOptions)).toBe(buildNodeOptions(memoryMb, nodeOptions));
    },
  );
});
