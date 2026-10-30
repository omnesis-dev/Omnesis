// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetActiveUniverseCache } from "@omnesis/providers-synth-common";

const SELF = "5550100201";

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-telegram-synth-"));
  // Discovery reads the pair markers under OMNESIS_CONFIG_DIR, so a marker
  // from any other run can never answer for this one.
  vi.stubEnv("OMNESIS_CONFIG_DIR", configDir);
  vi.stubEnv("OMNESIS_SYNTH_PRE_DISCOVERED", "0");
  vi.resetModules();
  resetActiveUniverseCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetActiveUniverseCache();
  rmSync(configDir, { recursive: true, force: true });
});

async function load() {
  const { default: definition } = await import("./index.js");
  const { simulatedServer } = await import("./wraps-real.js");
  return { definition, simulatedServer };
}

test("discovers nothing on a host that was never paired and holds no session", async () => {
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "telegram-sync");
  const { definition } = await load();
  expect(await definition.discover?.({ configDir })).toEqual([]);
});

test("discovers the account whose session a context already seeded on this host", async () => {
  // What a collector restarted over a source the gateway already holds sees:
  // the source was added without a sign-in, so there is no pair marker, but
  // its first context left the session on disk.
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "telegram-sync");
  const { definition, simulatedServer } = await load();
  await simulatedServer().seedAccount(configDir, Number(SELF));
  expect(await definition.discover?.({ configDir })).toEqual([SELF]);
});

test("a stored session does not conjure an account in a universe without a corpus", async () => {
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "telegram-sync");
  const { simulatedServer } = await load();
  await simulatedServer().seedAccount(configDir, Number(SELF));

  vi.resetModules();
  resetActiveUniverseCache();
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "default");
  const { definition } = await load();
  expect(await definition.discover?.({ configDir })).toEqual([]);
});
