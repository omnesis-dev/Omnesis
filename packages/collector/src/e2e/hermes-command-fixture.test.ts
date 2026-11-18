// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareHermesCommandFixture } from "./hermes-command-fixture.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("runs literal Hermes argv, rejects other commands, and leaves unrelated Node children untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes fixture spaces-"));
  roots.push(root);
  vi.stubEnv("NODE_OPTIONS", "--no-warnings");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...prepareHermesCommandFixture(root),
    HERMES_HOME: root,
  };
  expect(env.NODE_OPTIONS).toContain("--no-warnings");
  const executable = join(root, process.platform === "win32" ? "hermes.exe" : "hermes");
  const unrelated = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write('unrelated fixture')"],
    { env, encoding: "utf8" },
  );
  expect(unrelated.status, unrelated.stderr).toBe(0);
  expect(unrelated.stdout).toBe("unrelated fixture");
  expect(existsSync(join(root, ".omnesis-hermes-enabled-e2e"))).toBe(false);
  const refused = spawnSync(
    executable,
    ["plugins", "enable", "--allow-tool-override", "omnesis-integration"],
    { env, encoding: "utf8" },
  );
  expect(refused.status, refused.stderr).toBe(64);
  const accepted = spawnSync(
    executable,
    ["plugins", "enable", "--no-allow-tool-override", "omnesis-integration"],
    { env, encoding: "utf8" },
  );
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(existsSync(join(root, ".omnesis-hermes-enabled-e2e"))).toBe(true);
});
