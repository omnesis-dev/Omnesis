// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildHeapEnv,
  buildMemoryTight,
  buildNodeOptions,
  usableMemoryMb,
  type MemoryProbe,
} from "./build-heap.js";

const MIB = 1024 * 1024;

function probe(over: Partial<MemoryProbe> & { files?: Record<string, string> } = {}): MemoryProbe {
  const files = over.files ?? {};
  return {
    platform: "linux",
    totalMemoryBytes: () => 16384 * MIB,
    readFile: (path) => files[path] ?? null,
    env: {},
    ...over,
  };
}

describe("buildNodeOptions", () => {
  test("claims half the machine, capped, and never less than the build needs", () => {
    // A small host still gets the heap the build finishes with, and pages.
    expect(buildNodeOptions(1024, undefined)).toBe("--max-old-space-size=3072");
    expect(buildNodeOptions(4096, undefined)).toBe("--max-old-space-size=3072");
    expect(buildNodeOptions(7168, undefined)).toBe("--max-old-space-size=3584");
    // The reported case: a container with room the build never claimed.
    expect(buildNodeOptions(8192, undefined)).toBe("--max-old-space-size=4096");
    // A workstation: capped, not half of everything.
    expect(buildNodeOptions(131_072, undefined)).toBe("--max-old-space-size=8192");
    expect(buildNodeOptions(null, undefined)).toBe("");
  });

  test("an operator's own heap setting is left exactly as they wrote it; other options are kept", () => {
    expect(buildNodeOptions(131_072, "--max-old-space-size=512")).toBe("--max-old-space-size=512");
    expect(buildNodeOptions(8192, "--enable-source-maps")).toBe(
      "--enable-source-maps --max-old-space-size=4096",
    );
    expect(buildNodeOptions(1024, "--enable-source-maps")).toBe(
      "--enable-source-maps --max-old-space-size=3072",
    );
    expect(buildNodeOptions(null, "--enable-source-maps")).toBe("--enable-source-maps");
  });
});

describe("buildMemoryTight", () => {
  test("below the build heap plus its headroom, the machine has no room for a collector", () => {
    const withMemory = (mb: number, env: NodeJS.ProcessEnv = {}): boolean =>
      buildMemoryTight(probe({ totalMemoryBytes: () => mb * MIB, env }));
    // The reported host: 4 GB, a 3 GB heap, nothing to spare.
    expect(withMemory(4096)).toBe(true);
    expect(withMemory(5119)).toBe(true);
    expect(withMemory(5120)).toBe(false);
    expect(withMemory(16384)).toBe(false);
    // The heap the build really runs with counts, an operator's own included.
    expect(withMemory(8192, { NODE_OPTIONS: "--max-old-space-size=7168" })).toBe(true);
    expect(withMemory(4096, { NODE_OPTIONS: "--max-old-space-size=1024" })).toBe(false);
    // A container ceiling is the memory; unknown memory is not tight.
    expect(
      buildMemoryTight(probe({ files: { "/sys/fs/cgroup/memory.max": String(4096 * MIB) } })),
    ).toBe(true);
    expect(buildMemoryTight(probe({ totalMemoryBytes: () => 0 }))).toBe(false);
  });
});

describe("usableMemoryMb", () => {
  test("the smaller of the OS total and a cgroup ceiling wins; a stated number wins over both", () => {
    expect(usableMemoryMb(probe())).toBe(16384);
    expect(usableMemoryMb(probe({ files: { "/sys/fs/cgroup/memory.max": "8589934592\n" } }))).toBe(
      8192,
    );
    // "max" (no limit) and a limit above the machine change nothing.
    expect(usableMemoryMb(probe({ files: { "/sys/fs/cgroup/memory.max": "max\n" } }))).toBe(16384);
    expect(
      usableMemoryMb(
        probe({
          files: { "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(64 * 1024 * MIB) },
        }),
      ),
    ).toBe(16384);
    expect(usableMemoryMb(probe({ env: { OMNESIS_BUILD_MEMORY_MB: "3000" } }))).toBe(3000);
    expect(usableMemoryMb(probe({ env: { OMNESIS_BUILD_MEMORY_MB: "lots" } }))).toBe(16384);
  });

  test("macOS reads the OS total only; an unreadable total is unknown", () => {
    expect(
      usableMemoryMb(
        probe({ platform: "darwin", files: { "/sys/fs/cgroup/memory.max": "1048576" } }),
      ),
    ).toBe(16384);
    expect(usableMemoryMb(probe({ totalMemoryBytes: () => 0 }))).toBeNull();
  });

  test("buildHeapEnv yields the variable whenever the memory is known", () => {
    expect(buildHeapEnv(probe())).toEqual({ NODE_OPTIONS: "--max-old-space-size=8192" });
    expect(buildHeapEnv(probe({ totalMemoryBytes: () => 2048 * MIB }))).toEqual({
      NODE_OPTIONS: "--max-old-space-size=3072",
    });
    expect(buildHeapEnv(probe({ totalMemoryBytes: () => 0 }))).toBeUndefined();
  });
});

test("the Docker runtime build gets the policy's smallest heap", () => {
  // A Docker build cannot read the host it runs on before it starts, so the
  // runtime-build stage states the floor every machine gets.
  const dockerfile = readFileSync(
    fileURLToPath(new URL("../../../../Dockerfile", import.meta.url)),
    "utf8",
  );
  const stage = dockerfile.split(/^FROM .+ AS runtime-build$/mu)[1]?.split(/^FROM /mu)[0] ?? "";
  const stated = /^ARG NODE_OPTIONS=(.+)$/mu.exec(stage)?.[1];
  expect(stated).toBe(buildNodeOptions(1, undefined));
  expect(stage.indexOf("ARG NODE_OPTIONS=")).toBeLessThan(
    stage.indexOf("stage-runtime.mjs --build"),
  );
});
