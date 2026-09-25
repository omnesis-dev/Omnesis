// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { BadgeRefreshCoordinator } from "./badge-refresh.js";

describe("BadgeRefreshCoordinator", () => {
  it("computes and applies a newer snapshot only after an older apply completes", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const applied: string[] = [];
    let current = "paired";
    const coordinator = new BadgeRefreshCoordinator();
    const first = coordinator.run(async () => {
      const snapshot = current;
      await firstGate;
      applied.push(snapshot);
    });
    await Promise.resolve();
    current = "unpaired";
    const second = coordinator.run(async () => {
      applied.push(current);
    });

    await Promise.resolve();
    expect(applied).toEqual([]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(applied).toEqual(["paired", "unpaired"]);
  });
});
