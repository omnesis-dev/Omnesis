// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { smokeRuntimeEnvironment } from "./smoke-runtime.mjs";
import {
  telemetryForcedOff,
  telemetryRuntimeAllowed,
  telemetryTestRuntime,
} from "../../packages/gateway/src/telemetry/policy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("the compiled smoke environment retains unrelated profile probes and denies telemetry independently", () => {
  const runtime = join(tmpdir(), "invented-smoke-runtime");
  const home = join(tmpdir(), "invented-smoke-home");
  const env = smokeRuntimeEnvironment(runtime, home);
  expect(env).toEqual({
    PATH: join(runtime, "bin") + ":/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    OMNESIS_RUNTIME_MODE: "test",
    OMNESIS_TELEMETRY: "0",
    OMNESIS_E2E_DESKTOP_RUNTIME_SMOKE: "1",
    OMNESIS_CONFIG_DIR: join(home, "unrelated-headless"),
    OMNESIS_SECRET_SERVICE: "dev.omnesis.unrelated-fixture",
    OMNESIS_GATEWAY_URL: "https://unreachable.example.test",
    OMNESIS_TOKEN: "omn_test",
  });
  const entryPath = join(runtime, "packages/cli/dist/index.js");
  expect(telemetryForcedOff(env)).toBe(true);
  expect(telemetryRuntimeAllowed({ env, entryPath })).toBe(false);
  // Even accidentally enabling both ordinary controls cannot remove the independent test veto.
  const production = { ...env, OMNESIS_RUNTIME_MODE: "production", OMNESIS_TELEMETRY: "on" };
  expect(telemetryTestRuntime(production)).toBe(true);
  expect(telemetryRuntimeAllowed({ env: production, entryPath })).toBe(false);
  delete production.OMNESIS_E2E_DESKTOP_RUNTIME_SMOKE;
  expect(telemetryRuntimeAllowed({ env: production, entryPath })).toBe(true);
});

test("importing the smoke helper is inert while direct CLI execution still requires the runtime argument", () => {
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./scripts/desktop/smoke-runtime.mjs")'],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  expect(imported.error).toBeUndefined();
  expect(imported.status).toBe(0);
  expect(imported.stdout).toBe("");
  expect(imported.stderr).toBe("");
  const direct = spawnSync(process.execPath, ["scripts/desktop/smoke-runtime.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(direct.error).toBeUndefined();
  expect(direct.status).not.toBe(0);
  expect(direct.stderr).toContain("Missing --runtime");
});
