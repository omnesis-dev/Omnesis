// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  graphAdmissionReserve,
  graphShedFloor,
  memoryHeadroom,
  readCgroupMemoryLimit,
  resolveMemoryBudget,
  type ReadText,
} from "./memory-budget.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function files(map: Record<string, string>): ReadText {
  return (path) => map[path] ?? null;
}

describe("readCgroupMemoryLimit", () => {
  it("reads a container's cgroup v2 limit at its namespace root", () => {
    const read = files({
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${6 * GIB}\n`,
    });
    expect(readCgroupMemoryLimit(read)).toBe(6 * GIB);
  });

  it("treats cgroup v2 `max` as no limit", () => {
    const read = files({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "max\n" });
    expect(readCgroupMemoryLimit(read)).toBeNull();
  });

  it("takes the tightest limit on the way from a service's cgroup to the root", () => {
    const read = files({
      "/proc/self/cgroup": "0::/system.slice/omnesis-gateway.service\n",
      "/sys/fs/cgroup/system.slice/omnesis-gateway.service/memory.max": "max\n",
      "/sys/fs/cgroup/system.slice/memory.max": `${3 * GIB}\n`,
    });
    expect(readCgroupMemoryLimit(read)).toBe(3 * GIB);
  });

  it("falls back to cgroup v1, ignoring its page-rounded unlimited value", () => {
    expect(
      readCgroupMemoryLimit(
        files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${2 * GIB}\n` }),
      ),
    ).toBe(2 * GIB);
    expect(
      readCgroupMemoryLimit(
        files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" }),
      ),
    ).toBeNull();
  });

  it("is null without a cgroup (macOS, or no memory controller)", () => {
    expect(readCgroupMemoryLimit(files({}))).toBeNull();
  });
});

describe("resolveMemoryBudget", () => {
  const container = files({
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.max": `${6 * GIB}\n`,
  });

  it("prefers the configured limit over the cgroup and the host", () => {
    expect(resolveMemoryBudget({ limitMb: 4096, read: container, hostBytes: 16 * GIB })).toEqual({
      bytes: 4 * GIB,
      source: "config",
    });
  });

  it("uses the cgroup limit when it is below the host's memory", () => {
    expect(resolveMemoryBudget({ read: container, hostBytes: 16 * GIB })).toEqual({
      bytes: 6 * GIB,
      source: "cgroup",
    });
  });

  it("uses the host's memory when the cgroup allows more than the host has", () => {
    expect(resolveMemoryBudget({ read: container, hostBytes: 4 * GIB })).toEqual({
      bytes: 4 * GIB,
      source: "host",
    });
  });

  it("uses the host's memory without a cgroup limit", () => {
    expect(resolveMemoryBudget({ read: files({}), hostBytes: 8 * GIB })).toEqual({
      bytes: 8 * GIB,
      source: "host",
    });
  });
});

describe("memoryHeadroom", () => {
  const budget = { bytes: 8 * GIB, source: "cgroup" as const };

  it("is what the budget leaves above the process's anonymous memory", () => {
    const read = files({
      "/proc/self/status": `VmRSS:\t${3 * 1024 * 1024} kB\nRssAnon:\t${2 * 1024 * 1024} kB\n`,
      "/proc/meminfo": `MemTotal:\t${32 * 1024 * 1024} kB\nMemAvailable:\t${20 * 1024 * 1024} kB\n`,
    });
    expect(memoryHeadroom(budget, read)).toBe(6 * GIB);
  });

  it("is capped by what the host still has available", () => {
    const read = files({
      "/proc/self/status": `RssAnon:\t${2 * 1024 * 1024} kB\n`,
      "/proc/meminfo": `MemAvailable:\t${1024 * 1024} kB\n`,
    });
    expect(memoryHeadroom(budget, read)).toBe(GIB);
  });

  it("takes a configured budget at its word, without the host figure", () => {
    const read = files({
      "/proc/self/status": `RssAnon:\t${2 * 1024 * 1024} kB\n`,
      "/proc/meminfo": `MemAvailable:\t${1024 * 1024} kB\n`,
    });
    expect(memoryHeadroom({ bytes: 8 * GIB, source: "config" }, read)).toBe(6 * GIB);
  });
});

describe("graph sizing", () => {
  it("caps the reserve and the shed floor however large the host", () => {
    const large = { bytes: 256 * GIB, source: "host" as const };
    expect(graphAdmissionReserve(large)).toBe(4 * GIB);
    expect(graphShedFloor(large)).toBe(GIB);
  });

  it("sheds below the admission reserve, so an admitted graph is not shed at once", () => {
    for (const bytes of [GIB, 4 * GIB, 64 * GIB, 256 * GIB]) {
      const b = { bytes, source: "host" as const };
      expect(graphShedFloor(b)).toBeLessThan(graphAdmissionReserve(b));
    }
  });
});
