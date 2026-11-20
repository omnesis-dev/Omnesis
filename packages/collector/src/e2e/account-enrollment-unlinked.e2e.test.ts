// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every gateway offers the Omnesis account and the cloud relay, so a gateway
 * that never linked an account must behave as a gateway without them did:
 * nothing account-bound acts, nothing asks for a passkey, QR pairing and the
 * device list are unchanged, no response grows an enrollment field, and
 * reading the account page writes nothing into the config directory.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execWindowsJob } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { REPO_ROOT } from "./account-enrollment-harness.js";
import { E2EHarness } from "./harness.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";

const execFileAsync = promisify(execFile);

describe("a gateway that never linked an Omnesis account", () => {
  let harness: E2EHarness;
  let directory: string;

  async function cli(args: string[]): Promise<{ code: number; output: string }> {
    const command = e2eTsxCommand("packages/cli/src/index.ts");
    const env: NodeJS.ProcessEnv = {
      ...e2eGatewayEnv(),
      OMNESIS_CONFIG_DIR: join(directory, "cli"),
      OMNESIS_GATEWAY_URL: harness.gatewayUrl,
      OMNESIS_TOKEN: harness.apiKey,
      OMNESIS_LOG_LEVEL: "error",
    };
    const execute = process.platform === "win32" ? execWindowsJob : execFileAsync;
    const result = await execute(command.command, [...command.args, ...args], {
      cwd: REPO_ROOT,
      env,
      timeout: 30_000,
    }).then(
      (value) => ({ ...value, code: 0 }),
      (error: { stdout?: string; stderr?: string; code?: number }) => ({
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: typeof error.code === "number" ? error.code : 1,
      }),
    );
    return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-unlinked-"));
    harness = new E2EHarness();
    await harness.start();
  }, gatewayBootBudgetMs() + 30_000);

  afterAll(async () => {
    await harness?.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  function configEntries(): string[] {
    const configDir = (harness as unknown as { configDir: string }).configDir;
    return readdirSync(configDir, { recursive: true }).map(String);
  }

  test("reading the account page shows nothing connected and writes nothing", async () => {
    const before = configEntries();
    expect(before.filter((entry) => /cloud-relay|acme|enrollment/i.test(entry))).toEqual([]);
    const status = await harness.gatewayJson<{
      configured: boolean;
      enabled: boolean;
      tunnel: { state: string };
    }>("/admin/cloud-relay");
    expect(status).toMatchObject({ configured: false, enabled: false });
    expect(status.tunnel.state).toBe("disabled");
    expect(configEntries().filter((entry) => /cloud-relay|acme|enrollment/i.test(entry))).toEqual(
      [],
    );
    // Starting over has nothing to discard, and writes nothing either.
    const startOver = await harness.gatewayJson<{ configured: boolean; can: object }>(
      "/admin/cloud-relay/start-over",
      { method: "POST", body: "{}" },
    );
    expect(startOver).toMatchObject({ configured: false, can: { startOver: false } });
    expect(startOver).not.toHaveProperty("unfinished");
    expect(configEntries().filter((entry) => /cloud-relay|acme|enrollment/i.test(entry))).toEqual(
      [],
    );
  });

  test("no account-bound route acts", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/devices/account/config"],
      ["POST", "/devices/account/challenge", {}],
      ["GET", "/devices/google/config"],
      ["GET", "/admin/cloud-pairing/requests"],
      ["POST", "/portal/api/handoff", {}],
      ["POST", "/portal/api/handoff/redeem", { code: "a".repeat(43) }],
      [
        "POST",
        "/admin/step-up/options",
        { method: "POST", path: "/admin/tokens", bodySha256: "0".repeat(64) },
      ],
    ];
    for (const [method, path, body] of routes) {
      const response = await harness.gatewayFetch(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await response.arrayBuffer();
      expect(response.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
  });

  test("no administrative action asks for a passkey, even when marked as relayed", async () => {
    const relayed = { "x-omnesis-cloud-relay": "1" };
    const pairing = await harness.gatewayFetch("/admin/devices/pair", {
      method: "POST",
      headers: relayed,
      body: JSON.stringify({ kind: "cli", name: "Fictional relayed-mark CLI" }),
    });
    expect(pairing.status).toBe(200);
    const devices = await harness.gatewayJson<{ items: Array<{ id: string }> }>("/admin/devices");
    const token = await harness.gatewayFetch("/admin/tokens", {
      method: "POST",
      headers: relayed,
      body: JSON.stringify({ deviceId: devices.items[0]!.id, scopes: ["read"] }),
    });
    expect(token.status).toBe(200);
    expect(JSON.stringify(await token.json())).not.toMatch(/step.?up/i);
  });

  test("QR pairing makes the codes it always made, with no Omnesis address", async () => {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "android", name: "Fictional unlinked phone" }),
    });
    const plan = await harness.gatewayJson<{ addresses: Array<Record<string, unknown>> }>(
      "/admin/devices/pair-addresses",
      { method: "POST", body: JSON.stringify({ pairingCode: pairing.pairingCode }) },
    );
    expect(plan.addresses.length).toBeGreaterThan(0);
    for (const address of plan.addresses) expect(address.label).not.toBe("Omnesis address");
    const qr = await harness.gatewayJson<{ payload: string }>("/admin/devices/pair-qr", {
      method: "POST",
      body: JSON.stringify({ pairingCode: pairing.pairingCode, gatewayUrl: harness.gatewayUrl }),
    });
    expect(JSON.stringify(qr)).not.toMatch(/-strict/);
  });

  test("Connectivity lists no relay address MCP could answer on", async () => {
    const state = await harness.gatewayJson<{
      mcpAddresses: Array<{ id: string; available: boolean; url: string | null }>;
    }>("/admin/remote-access");
    const relay = state.mcpAddresses.find((row) => row.id === "relay");
    expect(relay).toMatchObject({ available: false, url: null });
  });

  test("responses carry no enrollment and no relay marker", async () => {
    const devices = await harness.gatewayJson<{ items: Array<Record<string, unknown>> }>(
      "/admin/devices",
    );
    expect(devices.items.length).toBeGreaterThan(0);
    for (const device of devices.items) expect(device).not.toHaveProperty("enrollment");
    const whoami = await harness.gatewayJson<Record<string, unknown>>("/whoami");
    expect(whoami).not.toHaveProperty("enrollment");
    const signedOut = await fetch(`${harness.gatewayUrl}/portal/api/session`);
    expect(await signedOut.text()).toBe('{"authenticated":false}');
    const health = (await (await fetch(`${harness.gatewayUrl}/health`)).json()) as object;
    expect(health).not.toHaveProperty("cloudRelay");
  });

  test("the CLI offers the account commands, and reports an unconnected gateway", async () => {
    const help = await cli(["--help"]);
    expect(help.output).toMatch(/^\s+cloud\b/m);
    const status = await cli(["cloud", "status"]);
    expect(status.code, status.output).toBe(0);
  });
});
