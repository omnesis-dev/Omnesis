// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetActiveUniverseCache } from "@omnesis/providers-synth-common";

const previousUniverse = process.env.OMNESIS_SYNTH_UNIVERSE;

async function discoverIn(universe: string) {
  process.env.OMNESIS_SYNTH_UNIVERSE = universe;
  resetActiveUniverseCache();
  vi.resetModules();
  const { default: synthScreenTime } = await import("./index.js");
  return synthScreenTime.discover!();
}

describe("synth screen-time discover", () => {
  afterEach(() => {
    if (previousUniverse === undefined) delete process.env.OMNESIS_SYNTH_UNIVERSE;
    else process.env.OMNESIS_SYNTH_UNIVERSE = previousUniverse;
    resetActiveUniverseCache();
  });

  it("reports the account in a universe that ships the fixture", async () => {
    await expect(discoverIn("e2e-minimal")).resolves.toHaveLength(1);
  });

  it("fails discovery in a universe without the fixture", async () => {
    await expect(discoverIn("japan-trip")).rejects.toThrow(
      /missing fixture screen-time\/apps\.json/,
    );
  });
});
