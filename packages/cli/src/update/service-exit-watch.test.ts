// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DOWN_CONFIRM_MS, ServiceExitWatch } from "./service-exit-watch.js";
import type { ServiceLiveness } from "../service/types.js";

const reading = (over: Partial<ServiceLiveness>): ServiceLiveness => ({
  installed: true,
  running: true,
  down: false,
  starts: 0,
  detail: "active (running)",
  ...over,
});

/** Feeds readings two seconds apart, as the health wait polls. */
function feed(watch: ServiceExitWatch, readings: ServiceLiveness[]): Array<string | null> {
  return readings.map((r, i) => watch.observe(r, i * 2_000));
}

describe("ServiceExitWatch", () => {
  test("a gateway whose process stays up is never called exited", () => {
    const verdicts = feed(new ServiceExitWatch(), Array(300).fill(reading({ starts: 4 })));
    expect(verdicts.every((v) => v === null)).toBe(true);
  });

  test("two relaunches since the first reading are a crash loop", () => {
    const watch = new ServiceExitWatch();
    expect(watch.observe(reading({ starts: 3 }), 0)).toBeNull();
    expect(watch.observe(reading({ starts: 4, running: false, down: true }), 2_000)).toBeNull();
    expect(watch.observe(reading({ starts: 5, detail: "state = spawn scheduled" }), 4_000)).toMatch(
      /relaunched it 2 times while waiting \(state = spawn scheduled\)/u,
    );
  });

  test("one relaunch that then stays up is not a crash loop", () => {
    const watch = new ServiceExitWatch();
    const verdicts = feed(watch, [
      reading({ starts: 0 }),
      reading({ starts: 1, running: false, down: true }),
      ...Array(100).fill(reading({ starts: 1 })),
    ]);
    expect(verdicts.every((v) => v === null)).toBe(true);
  });

  test("a unit held down past the confirmation span has exited", () => {
    const watch = new ServiceExitWatch();
    const down = reading({ running: false, down: true, starts: null, detail: "failed (failed)" });
    const verdicts = feed(watch, Array(10).fill(down));
    const first = verdicts.findIndex((v) => v !== null);
    expect(first * 2_000).toBeGreaterThanOrEqual(DOWN_CONFIRM_MS);
    expect(verdicts[first]).toMatch(/not been running for 1[5-9]s \(failed \(failed\)\)/u);
  });

  test("a brief gap between processes resets the down streak", () => {
    const watch = new ServiceExitWatch();
    const down = reading({ running: false, down: true, starts: null });
    const up = reading({ starts: null });
    const verdicts = feed(watch, [down, down, down, down, up, down, down, down, down, up]);
    expect(verdicts.every((v) => v === null)).toBe(true);
  });

  test("a starting process is neither up nor down", () => {
    const watch = new ServiceExitWatch();
    const starting = reading({
      running: false,
      down: false,
      starts: 0,
      detail: "activating (start)",
    });
    expect(feed(watch, Array(100).fill(starting)).every((v) => v === null)).toBe(true);
  });

  test("an uninstalled unit decides nothing", () => {
    const watch = new ServiceExitWatch();
    const gone = reading({ installed: false, running: false, down: false, starts: null });
    expect(feed(watch, Array(100).fill(gone)).every((v) => v === null)).toBe(true);
  });
});
