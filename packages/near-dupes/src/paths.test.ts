// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { defaultCorpusDbPath, defaultComparisonOutputPath } from "./paths.js";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
afterEach(() => vi.unstubAllEnvs());
it("preserves the explicit HOME corpus layout and uses the OS home without HOME", () => {
  const home = join(tmpdir(), "invented-study-home");
  vi.stubEnv("HOME", home);
  expect(defaultCorpusDbPath()).toBe(join(home, ".config", "omnesis", "omnesis.db"));
  vi.stubEnv("HOME", undefined);
  expect(defaultCorpusDbPath()).toBe(join(homedir(), ".config", "omnesis", "omnesis.db"));
  expect(defaultComparisonOutputPath()).toBe(join(tmpdir(), "near-dupes-study", "comparison.md"));
});
it.each([
  ["runner/cli.ts", "run"],
  ["report/cli.ts", "show"],
  ["report/comparison.ts", "report"],
])(
  "%s prints portable corpus defaults with HOME unset without opening a database",
  (entry, command) => {
    const env = { ...process.env, HOME: undefined, NO_COLOR: "1", FORCE_COLOR: undefined };
    const home = execFileSync(process.execPath, ["-p", "require('node:os').homedir()"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const help = execFileSync(
      process.execPath,
      [tsx, fileURLToPath(new URL(entry, import.meta.url)), command, "--help"],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    expect(help).toContain(join(home, ".config", "omnesis", "omnesis.db"));
    if (entry === "report/comparison.ts")
      expect(help).toContain(join(tmpdir(), "near-dupes-study", "comparison.md"));
  },
);
