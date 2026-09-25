// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_RELEASE_CHECK_PERIOD_MS,
  DEFAULT_RELEASE_CHECK_START_DELAY_MS,
  createReleaseCheckTask,
} from "./task.js";

describe("release-check PeriodicTask", () => {
  test("is a main-thread background periodic and turns rejection into a quiet result", async () => {
    const task = createReleaseCheckTask({ check: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(task).toMatchObject({
      name: "release.check",
      runner: "main",
      priority: "background",
      periodMs: DEFAULT_RELEASE_CHECK_PERIOD_MS,
      startDelayMs: DEFAULT_RELEASE_CHECK_START_DELAY_MS,
      initialArgs: undefined,
    });
    const result = await task.run(undefined, {
      signal: new AbortController().signal,
    } as never);
    expect(result).toEqual({ kind: "done", value: { checked: false } });
  });
});
