// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetActiveUniverseCache } from "@omnesis/providers-synth-common";

async function discoverIn(universe: string) {
  // Pre-discovered mode, so the answer never depends on a pair marker some
  // earlier synthetic run left in this machine's config directory.
  vi.stubEnv("OMNESIS_SYNTH_PRE_DISCOVERED", "1");
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", universe);
  resetActiveUniverseCache();
  vi.resetModules();
  const { default: synthScreenTime } = await import("./index.js");
  return synthScreenTime.discover!();
}

describe("synth screen-time discover", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
