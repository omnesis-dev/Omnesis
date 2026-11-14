// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultDupeDbPath } from "./repository.js";

afterEach(() => vi.unstubAllEnvs());
it("preserves a caller's explicit HOME and the existing data layout", () => {
  const home = join(tmpdir(), "invented-near-dupes-home");
  vi.stubEnv("HOME", home);
  expect(defaultDupeDbPath()).toBe(join(home, ".config", "omnesis", "omnesis-dupes", "dupes.db"));
});
it("uses the OS home when a Windows-style environment has no HOME", () => {
  vi.stubEnv("HOME", undefined);
  expect(defaultDupeDbPath()).toBe(
    join(homedir(), ".config", "omnesis", "omnesis-dupes", "dupes.db"),
  );
});
