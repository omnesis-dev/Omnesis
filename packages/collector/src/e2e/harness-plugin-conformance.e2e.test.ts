// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import { delimiter, join, resolve } from "node:path";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { fetchPeerCert, ownedProcessCleanupReceipt } from "@omnesis/core";
import { resolveHarnessCommand } from "@omnesis/agent-integration";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  assertHarnessRuntimeConformance,
  isolatedHarnessEnvironment,
} from "./harness-runtime-conformance.js";
import { e2eTsxCommand } from "./gateway-env.js";
import { execE2EBufferedCommand } from "./e2e-buffered-command.js";
import { writeNoBrowserPreload } from "./enrollment-browser-fixture.js";
import { enrollManagedIntegration, type ManagedHarness } from "./managed-integration-enrollment.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const requestedHarness = parseRequestedHarness();
const conformanceDescribe = requestedHarness ? describe : describe.skip;

conformanceDescribe("pinned external harness plugin conformance", () => {
  let gateway: MultiCollectorHarness;
  let previousTempDir: string | undefined;

  beforeAll(async () => {
    previousTempDir = process.env.TMPDIR;
    const isolatedTempDir = process.env.OMNESIS_HARNESS_TMPDIR;
    if (isolatedTempDir) process.env.TMPDIR = isolatedTempDir;
    gateway = new MultiCollectorHarness({
      extraGatewayEnv: {
        // The inventory under test deliberately includes the two gated
        // subscription tools. Experimental mode reveals the Lab; enable Watches
        // below; synthetic mode stays off throughout this conformance test.
        OMNESIS_EXPERIMENTAL: "1",
        OMNESIS_SYNTHETIC: "0",
      },
    });
    await gateway.start();
    await gateway.json("/admin/lab/watches", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await gateway?.destroy();
    } finally {
      if (previousTempDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTempDir;
    }
  }, 15_000);

  test("connect installs the plugin, its real host exposes exactly its expected tools, and uninstall takes it all off", async () => {
    if (!requestedHarness) throw new Error("the conformance harness was not selected");
    const root = mkdtempSync(join(tmpdir(), `omnesis-${requestedHarness}-conformance-`));
    const home = join(root, "harness");
    const osHome = join(root, "os-home");
    const cliConfig = join(root, "omnesis-config");
    const fakeBin = join(root, "bin");
    const processTemp = join(root, "tmp");
    const openerMarker =
      process.platform === "win32" ? join(fakeBin, "launches.txt") : join(root, "opener-invoked");
    for (const directory of [home, osHome, cliConfig, fakeBin, processTemp]) {
      mkdirSync(directory, { recursive: true });
    }
    for (const opener of ["open", "xdg-open"]) {
      writeFileSync(join(fakeBin, opener), '#!/bin/sh\n: > "$OMNESIS_OPENER_MARKER"\n', {
        mode: 0o755,
      });
    }
    if (requestedHarness === "openclaw") {
      writeFileSync(
        join(home, "openclaw.json"),
        `${JSON.stringify({ update: { checkOnStart: false } }, null, 2)}\n`,
      );
    } else {
      writeFileSync(
        join(home, "config.yaml"),
        "display:\n  background_process_notifications: all\nsecurity:\n  tirith_enabled: false\n  allow_lazy_installs: false\nagent:\n  gateway_startup_warmup_timeout: 0\n",
      );
    }

    let primaryError: unknown;
    let failed = false;
    let retainInputs = false;
    try {
      const environment = isolatedHarnessEnvironment({
        harness: requestedHarness,
        repositoryRoot,
        home,
        osHome,
        tempDir: processTemp,
      });
      environment.OMNESIS_OPENER_MARKER = openerMarker;
      if (process.platform === "win32") {
        const preload = await writeNoBrowserPreload(fakeBin);
        environment.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
        for (const directory of [environment.APPDATA, environment.LOCALAPPDATA])
          if (directory) mkdirSync(directory, { recursive: true });
      }
      const { fingerprint } = await fetchPeerCert("localhost", gateway.gatewayPort);
      const enrollment = await enrollManagedIntegration({
        harness: requestedHarness,
        repositoryRoot,
        gatewayUrl: gateway.gatewayUrl,
        portalApiKey: gateway.bootstrapToken,
        gatewayDbPath: gateway.getDbPath(),
        home,
        fakeBin,
        cliConfigDir: cliConfig,
        trustFingerprint: fingerprint,
        connectEnv: environment,
        inheritConnectEnv: false,
        createPairingCode: async () => {
          const pairing = await gateway.json<{ pairingCode: string }>("/admin/devices/pair", {
            method: "POST",
            body: JSON.stringify({
              name: `Fictional ${requestedHarness} conformance integration`,
              kind: "agent",
              scopes: ["subscriptions:receive"],
            }),
          });
          return pairing.pairingCode;
        },
      });

      expect(existsSync(openerMarker)).toBe(true);
      if (process.platform === "win32") {
        const opened = readFileSync(openerMarker, "utf8").trim().split("\n")[0]!;
        expect(new URL(opened).origin).toBe(new URL(gateway.gatewayUrl).origin);
        expect(enrollment.connectOutput).toContain(opened);
      }
      expect(installedPluginExists(requestedHarness, home)).toBe(true);
      await assertHarnessRuntimeConformance({
        harness: requestedHarness,
        repositoryRoot,
        home,
        environment,
      });
      expect(toolInvocationAuditCount(gateway.getDbPath())).toBe(0);

      // `omnesis uninstall <harness>` against the same real host: the plugin
      // is unregistered through the harness's own CLI, every file connect
      // wrote is gone, and the operator's own settings are untouched.
      await runCli(["uninstall", requestedHarness, "--yes"], environment, cliConfig);
      expect(installedPluginExists(requestedHarness, home)).toBe(false);
      expect(existsSync(join(home, "omnesis"))).toBe(false);
      const skill =
        requestedHarness === "openclaw"
          ? join(home, "skills", "omnesis")
          : join(home, "skills", "productivity", "omnesis");
      expect(existsSync(skill)).toBe(false);
      if (requestedHarness === "openclaw") {
        const config = JSON.parse(readFileSync(join(home, "openclaw.json"), "utf8"));
        expect(config.update).toEqual({ checkOnStart: false });
        expect(JSON.stringify(config)).not.toContain("omnesis");
        const command = resolveHarnessCommand("openclaw", ["plugins", "list"], {
          env: environment,
        });
        const listed = await execE2EBufferedCommand(command.command, command.args, {
          cwd: repositoryRoot,
          env: environment,
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        expect(listed.stdout).not.toContain("omnesis-integration");
      } else {
        const config = readFileSync(join(home, "config.yaml"), "utf8");
        expect(config).toContain("background_process_notifications: all");
        expect(config).not.toContain("omnesis-integration");
      }
      const again = await runCli(["uninstall", requestedHarness, "--yes"], environment, cliConfig);
      expect(again).toContain("Nothing of Omnesis to remove");
    } catch (error) {
      failed = true;
      primaryError = error;
      retainInputs = ownedProcessCleanupReceipt(error) !== undefined;
    } finally {
      if (!retainInputs) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (cleanupError) {
          primaryError = failed
            ? new AggregateError([primaryError, cleanupError], "Harness fixture removal failed")
            : cleanupError;
          failed = true;
        }
      }
    }
    if (failed) throw primaryError;
  }, 240_000);
});

/** Resolve only after CLI exit zero and confirmed Windows cohort closure. */
async function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  configDir: string,
): Promise<string> {
  const command = e2eTsxCommand(join(repositoryRoot, "packages/cli/src/index.ts"));
  const res = await execE2EBufferedCommand(command.command, [...command.args, ...args], {
    cwd: repositoryRoot,
    env: {
      ...environment,
      PATH: [join(repositoryRoot, "node_modules", ".bin"), environment.PATH ?? ""].join(delimiter),
      OMNESIS_CONFIG_DIR: configDir,
      NO_COLOR: "1",
    },
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  return `${res.stdout}${res.stderr}`;
}

function parseRequestedHarness(): ManagedHarness | undefined {
  const value = process.env.OMNESIS_HARNESS_CONFORMANCE;
  if (value === undefined || value === "") return undefined;
  if (value === "openclaw" || value === "hermes") return value;
  throw new Error("OMNESIS_HARNESS_CONFORMANCE must be openclaw or hermes");
}

function installedPluginExists(harness: ManagedHarness, home: string): boolean {
  if (harness === "hermes") {
    return ["__init__.py", "adapter.py", "plugin.yaml"].every((file) =>
      existsSync(join(home, "plugins", "omnesis-integration", file)),
    );
  }
  return (
    globSync("npm/projects/*/node_modules/@omnesis/agent-integration/openclaw-entry.mjs", {
      cwd: home,
    }).length === 1
  );
}

function toolInvocationAuditCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM access_audit_events WHERE event_type = 'mcp-tool-invoked'",
        )
        .get() as { count: number }
    ).count;
  } finally {
    db.close();
  }
}
