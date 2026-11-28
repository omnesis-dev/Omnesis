// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as filesystem from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  telemetryForcedOff,
  telemetryRuntimeAllowed,
  telemetryTestRuntime,
} from "../../packages/gateway/src/telemetry/policy.js";
import * as analytics from "./qualify-analytics.mjs";
import * as inventory from "./native-inventory.mjs";
import { smokeRuntime, smokeRuntimeEnvironment } from "./smoke-runtime.mjs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rm: vi.fn(actual.rm) };
});

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
  const env = { ...process.env };
  // Inherited color controls can emit warnings before the imported module runs.
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./scripts/desktop/smoke-runtime.mjs")'],
    { cwd: root, env, encoding: "utf8", timeout: 10000 },
  );
  expect(imported.error).toBeUndefined();
  expect(imported.status).toBe(0);
  expect(imported.stdout).toBe("");
  expect(imported.stderr).toBe("");
  const direct = spawnSync(process.execPath, ["scripts/desktop/smoke-runtime.mjs"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(direct.error).toBeUndefined();
  expect(direct.status).not.toBe(0);
  expect(direct.stderr).toContain("Missing --runtime");
});

const ownedHomes = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(filesystem.rm).mockReset();
  vi.unstubAllEnvs();
  for (const home of ownedHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function analyticsSmokeFixture() {
  const home = mkdtempSync(join(tmpdir(), "omnesis-analytics-smoke-test-"));
  ownedHomes.push(home);
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  writeFileSync(
    join(runtime, "desktop-runtime.json"),
    JSON.stringify({
      format: 1,
      architecture: process.arch,
      codeUsageProtocol: 1,
      dataUsageProtocol: 1,
      processAuthorityProtocol: 3,
      runtimeLauncher: "runtime-exec",
      inventory: [],
    }),
  );
  vi.spyOn(inventory, "inventoryBundle").mockResolvedValue([]);
  vi.spyOn(analytics, "qualifyDesktopAnalytics").mockReturnValue({
    extension: "invented-offline-extension",
    engineVersion: "v1.5.6",
  });
  vi.stubEnv("TMPDIR", home);
  return {
    home,
    runtime,
    options: {
      analyticsRestore: {
        input: join(home, "input"),
        upstreamNode: process.execPath,
        architecture: process.arch,
      },
    },
  };
}

test("analytics-only smoke mode creates the ordinary private epoch/profile owner and cleans it after success", async () => {
  const f = analyticsSmokeFixture();
  const qualify = vi
    .spyOn(analytics, "qualifyDesktopAnalyticsRestore")
    .mockImplementation(({ runtime, home, scope, env }) => {
      expect(runtime).toMatch(/[a-f0-9]{64}$/u);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(scope.configDir, "desktop-install.json")).mode & 0o777).toBe(0o600);
      expect(env.OMNESIS_RUNTIME_MODE).toBe("test");
      return Promise.resolve();
    });
  await smokeRuntime(f.runtime, f.options);
  expect(qualify).toHaveBeenCalledTimes(1);
  expect(readdirSync(f.home)).toEqual(["runtime"]);
});

test("unknown physical qualification cleanup retains its exact private runtime/profile home", async () => {
  const f = analyticsSmokeFixture(),
    failure = Object.assign(new Error("Invented joined-owner refusal"), {
      cleanupFailure: "invented-join",
    });
  vi.spyOn(analytics, "qualifyDesktopAnalyticsRestore").mockRejectedValue(failure);
  await expect(smokeRuntime(f.runtime, f.options)).rejects.toBe(failure);
  const homes = readdirSync(f.home).filter((name) =>
    name.startsWith("omnesis-desktop-bundle-smoke-"),
  );
  expect(homes).toHaveLength(1);
  expect(statSync(join(f.home, homes[0])).mode & 0o777).toBe(0o700);
});

test("a changed sealed inventory refuses analytics qualification before any engine process", async () => {
  const f = analyticsSmokeFixture();
  vi.spyOn(inventory, "inventoryBundle").mockResolvedValue([{ path: "invented-mismatch" }]);
  const qualify = vi.spyOn(analytics, "qualifyDesktopAnalyticsRestore").mockResolvedValue();
  await expect(smokeRuntime(f.runtime, f.options)).rejects.toThrow(
    "Runtime differs from its sealed build inventory",
  );
  expect(analytics.qualifyDesktopAnalytics).not.toHaveBeenCalled();
  expect(qualify).not.toHaveBeenCalled();
  expect(readdirSync(f.home)).toEqual(["runtime"]);
});

// This exercises the owned filesystem boundary, not a native process-join proof.
test("home removal refusal preserves the primary qualification error and exact retained home", async () => {
  const f = analyticsSmokeFixture();
  const primary = new Error("Invented qualification failure");
  const removal = Object.assign(new Error("Invented removal refusal"), { code: "EACCES" });
  let ownedHome;
  vi.spyOn(analytics, "qualifyDesktopAnalyticsRestore").mockImplementation(({ home }) => {
    ownedHome = home;
    return Promise.reject(primary);
  });
  const remove = vi.mocked(filesystem.rm).mockRejectedValueOnce(removal);
  let failure;
  try {
    await smokeRuntime(f.runtime, f.options);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([primary, removal]);
  expect(failure.errors[0]).toBe(primary);
  expect(failure.errors[1]).toBe(removal);
  expect(failure.cleanupFailure).toBe("runtime-qualification-home");
  expect(remove).toHaveBeenCalledExactlyOnceWith(ownedHome, { recursive: true, force: true });
  expect(statSync(ownedHome).mode & 0o777).toBe(0o700);
  expect(readdirSync(f.home)).toContain(ownedHome.slice(f.home.length + 1));
});
