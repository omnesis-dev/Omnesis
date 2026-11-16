// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { availableMemory, parseVmStat } from "./available-memory.mjs";
import { unitWorkers } from "../run-check.mjs";

const GIB = 1024 ** 3;
const PAGE = 16384;
const pages = (gib) => Math.round((gib * GIB) / PAGE);

// The shape `vm_stat` prints on macOS, with invented counts: 1.5 GiB free,
// 3 GiB of cached files and 0.5 GiB purgeable on a 7 GiB machine.
const vmStat = `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)
Pages free:                               ${pages(1.5)}.
Pages active:                             ${pages(1.25)}.
Pages inactive:                           ${pages(2.5)}.
Pages speculative:                        ${pages(0.25)}.
Pages throttled:                                  0.
Pages wired down:                         ${pages(1)}.
Pages purgeable:                          ${pages(0.5)}.
"Translation faults":                      90210344.
Pages copy-on-write:                        1234567.
Pages zero filled:                         45678901.
Pages reactivated:                           123456.
Pages purged:                                 23456.
File-backed pages:                        ${pages(3)}.
Anonymous pages:                          ${pages(1.5)}.
Pages stored in compressor:                    4321.
Pages occupied by compressor:                  1234.
Decompressions:                                5678.
Compressions:                                  6789.
Pageins:                                     345678.
Pageouts:                                       123.
Swapins:                                          0.
Swapouts:                                         0.
`;

describe("available memory", () => {
  test("macOS counts the file cache it reclaims, as Linux's MemAvailable does", () => {
    expect(parseVmStat(vmStat)).toBe((pages(1.5) + pages(3) + pages(0.5)) * PAGE);
    const available = availableMemory({
      platform: "darwin",
      nodeAvailable: 1.5 * GIB,
      vmStat: () => vmStat,
    });
    expect(Math.round(available / GIB)).toBe(5);
  });

  test("the cached files decide the unit pool a macOS runner gets", () => {
    // Free pages alone gave this machine one worker; counting its file cache
    // gives it the two its cores and memory hold.
    expect(unitWorkers({}, 3, 1.5 * GIB)).toBe(1);
    const available = availableMemory({
      platform: "darwin",
      nodeAvailable: 1.5 * GIB,
      vmStat: () => vmStat,
    });
    expect(unitWorkers({}, 3, available)).toBe(2);
  });

  test("other platforms keep Node's own measure", () => {
    let read = false;
    const available = availableMemory({
      platform: "linux",
      nodeAvailable: 9 * GIB,
      vmStat: () => {
        read = true;
        return vmStat;
      },
    });
    expect(available).toBe(9 * GIB);
    expect(read).toBe(false);
  });

  test("an unreadable or unfamiliar vm_stat falls back to Node's measure", () => {
    for (const output of [null, "", "Pages free: 12.\n"]) {
      expect(
        availableMemory({ platform: "darwin", nodeAvailable: 3 * GIB, vmStat: () => output }),
      ).toBe(3 * GIB);
    }
  });

  test("never reports less than Node's own measure", () => {
    expect(
      availableMemory({ platform: "darwin", nodeAvailable: 20 * GIB, vmStat: () => vmStat }),
    ).toBe(20 * GIB);
  });
});
