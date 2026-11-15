// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sign-in enrollment sits behind the cloud relay opt-in. A gateway and CLI
 * started without `OMNESIS_CLOUD_RELAY_ENABLED` expose none of it: every new
 * route is absent, existing responses carry no new fields, the CLI lists no new
 * command, and QR pairing grants a collector exactly what it always did.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { REPO_ROOT } from "./account-enrollment-harness.js";
import { E2EHarness } from "./harness.js";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";

const execFileAsync = promisify(execFile);

describe("sign-in enrollment with the cloud relay flag off", () => {
  let harness: E2EHarness;
  let directory: string;
  const prior = process.env.OMNESIS_CLOUD_RELAY_ENABLED;

  async function cli(args: string[], flag: boolean): Promise<string> {
    return (await cliRun(args, flag)).output;
  }

  async function cliRun(args: string[], flag: boolean): Promise<{ code: number; output: string }> {
    const command = e2eTsxCommand("packages/cli/src/index.ts");
    const env: NodeJS.ProcessEnv = {
      ...e2eGatewayEnv(),
      OMNESIS_CONFIG_DIR: join(directory, "cli"),
      OMNESIS_GATEWAY_URL: harness.gatewayUrl,
      OMNESIS_TOKEN: harness.apiKey,
      OMNESIS_LOG_LEVEL: "error",
    };
    delete env.OMNESIS_CLOUD_RELAY_ENABLED;
    if (flag) env.OMNESIS_CLOUD_RELAY_ENABLED = "1";
    const result = await execFileAsync(command.command, [...command.args, ...args], {
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
    delete process.env.OMNESIS_CLOUD_RELAY_ENABLED;
    directory = await mkdtemp(join(tmpdir(), "omnesis-enroll-flag-off-"));
    harness = new E2EHarness();
    await harness.start();
  }, gatewayBootBudgetMs() + 30_000);

  afterAll(async () => {
    await harness?.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (prior === undefined) delete process.env.OMNESIS_CLOUD_RELAY_ENABLED;
    else process.env.OMNESIS_CLOUD_RELAY_ENABLED = prior;
  }, 30_000);

  test("every enrollment route is absent", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/devices/account/challenge", {}],
      ["POST", "/devices/account/request", {}],
      ["POST", "/devices/account/poll", {}],
      ["GET", "/devices/account/config"],
      ["POST", "/devices/account/passkey/options", {}],
      ["GET", "/devices/account/approval/00000000-0000-4000-8000-000000000001"],
      ["POST", "/devices/account/approval/options", {}],
      ["POST", "/devices/account/approval", {}],
      ["POST", "/devices/token/challenge", {}],
      ["POST", "/devices/token/rotate", {}],
      ["GET", "/admin/cloud-relay"],
      ["POST", "/admin/cloud-relay/connect", { termsAccepted: true }],
      ["POST", "/admin/cloud-relay/connect/cancel", {}],
      ["PUT", "/admin/cloud-relay/enrollment", { policy: "automatic" }],
      ["DELETE", "/admin/cloud-relay/trusted-sign-ins/fictional"],
      ["POST", "/admin/cloud-relay/incidents/ack", {}],
      ["DELETE", "/admin/cloud-relay/trusted-sign-ins/fictional?revokeDevices=true"],
      ["GET", "/admin/cloud-relay/trusted-sign-ins"],
      ["POST", "/admin/cloud-relay/passkeys/confirm/options", {}],
      ["POST", "/admin/cloud-relay/passkeys/confirm", { proof: {} }],
      ["GET", "/admin/cloud-pairing/requests"],
      ["POST", "/admin/cloud-pairing/decision", {}],
      ["POST", "/admin/step-up/options", {}],
      ["POST", "/admin/step-up", {}],
    ];
    const statuses = await Promise.all(
      routes.map(async ([method, path, body]) => {
        const response = await harness.gatewayFetch(path, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        await response.arrayBuffer();
        return `${method} ${path} ${response.status}`;
      }),
    );
    expect(statuses).toEqual(routes.map(([method, path]) => `${method} ${path} 404`));
  });

  /** Status and body of a request sent without the harness's credential. */
  async function anonymous(method: string, path: string): Promise<string> {
    const response = await fetch(`${harness.gatewayUrl}${path}`, {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
    });
    return `${response.status} ${await response.text()}`;
  }

  async function authenticated(method: string, path: string): Promise<string> {
    const response = await harness.gatewayFetch(path, {
      method,
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    return `${response.status} ${await response.text()}`;
  }

  /** Pair a throwaway device and return its bearer token and id. */
  async function pairDevice(
    kind: string,
    capabilities: Record<string, unknown>,
  ): Promise<{ status: number; token: string; deviceId: string }> {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        kind,
        name: `Fictional ${kind} ${Math.random().toString(36).slice(2, 8)}`,
      }),
    });
    const redeemed = await fetch(`${harness.gatewayUrl}/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: pairing.pairingCode, capabilities }),
    });
    const body = (await redeemed.json()) as { token?: string; device?: { id: string } };
    return { status: redeemed.status, token: body.token ?? "", deviceId: body.device?.id ?? "" };
  }

  test("sign-in and direct-candidate routes answer as a path the gateway never had", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/devices/google/config"],
      ["POST", "/devices/google/authorize"],
      ["POST", "/devices/google/challenge"],
      ["POST", "/devices/google/request"],
      ["POST", "/devices/google/poll"],
      ["GET", "/devices/account/config"],
      ["POST", "/devices/account/authorize"],
      ["GET", "/devices/direct-candidates"],
    ];
    for (const [method, path] of routes) {
      // The control path exists on no build, so it shows what an absent route returns.
      const control = "/devices/fictional-absent-route";
      expect(await anonymous(method, path), `${method} ${path}`).toBe(
        await anonymous(method, control),
      );
      expect(await authenticated(method, path), `${method} ${path}`).toBe(
        await authenticated(method, control),
      );
    }
  });

  test("/health and /status carry no cloud relay key", async () => {
    const health = (await (await fetch(`${harness.gatewayUrl}/health`)).json()) as object;
    expect(health).not.toHaveProperty("cloudRelay");
    const status = await harness.gatewayJson<Record<string, unknown>>("/status");
    expect(status).not.toHaveProperty("cloudRelay");
    // The neighbouring mode flags are still there, so the key was not simply renamed away.
    expect(health).toHaveProperty("experimental");
    expect(status).toHaveProperty("experimental");
  });

  test("a reported connection path is ignored and appears in no response", async () => {
    for (const path of ["relay", "local"]) {
      const response = await harness.gatewayFetch("/whoami", {
        headers: { "x-omnesis-connection-path": path },
      });
      expect(response.status).toBe(200);
    }
    const devices = await harness.gatewayJson<{ items: Array<Record<string, unknown>> }>(
      "/admin/devices",
      { headers: { "x-omnesis-connection-path": "relay" } },
    );
    expect(devices.items.length).toBeGreaterThan(0);
    for (const device of devices.items) expect(device).not.toHaveProperty("connectionPath");
    expect(JSON.stringify(devices)).not.toMatch(/connectionPath/);
    const session = await harness.gatewayFetch("/portal/api/session", {
      headers: { "x-omnesis-connection-path": "relay" },
    });
    const body = (await session.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["authenticated", "scopes"]);
  });

  test("the login page is told nothing about sign-in and asks for nothing new", async () => {
    // The one request the login page already makes is its only source of the flag.
    const signedOut = await fetch(`${harness.gatewayUrl}/portal/api/session`);
    expect(await signedOut.text()).toBe('{"authenticated":false}');
    const shell = await fetch(`${harness.gatewayUrl}/portal/`);
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toBe(readFileSync(join(REPO_ROOT, "packages/gateway/portal/index.html"), "utf8"));
    expect(html).not.toMatch(/cloud|google|enrollment|relay/i);
    // Sign-in mounts only behind that answer, never unconditionally.
    const app = await (await fetch(`${harness.gatewayUrl}/portal/js/app.js`)).text();
    const mounts = app.match(/<\$\{CloudPairingLogin\}/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(app).toContain("${cloudRelay && html`<${CloudPairingLogin} />`}");
    expect(app).toContain("cloudRelay=${session.cloudRelay === true}");
  });

  test("no administrative action asks for a passkey step-up, even marked as relayed, and a step-up header changes nothing", async () => {
    const relayed = { "x-omnesis-cloud-relay": "1" };
    const pairing = await harness.gatewayFetch("/admin/devices/pair", {
      method: "POST",
      headers: relayed,
      body: JSON.stringify({ kind: "cli", name: "Fictional relayed-mark CLI" }),
    });
    expect(pairing.status).toBe(200);
    expect(await pairing.json()).toMatchObject({ pairingCode: expect.any(String) });
    const devices = await harness.gatewayJson<{ items: Array<{ id: string }> }>("/admin/devices");
    const token = await harness.gatewayFetch("/admin/tokens", {
      method: "POST",
      headers: { ...relayed, "x-omnesis-step-up": "fictional" },
      body: JSON.stringify({ deviceId: devices.items[0]!.id, scopes: ["read"] }),
    });
    expect(token.status).toBe(200);
    expect(JSON.stringify(await token.json())).not.toMatch(/step.?up/i);
  });

  test("the pairing QR refuses the strict trust modes as values it does not know", async () => {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "android", name: "Fictional strict-mode phone" }),
    });
    for (const trustMode of ["pinned-leaf-strict", "pinned-key-strict"]) {
      const response = await harness.gatewayFetch("/admin/devices/pair-qr", {
        method: "POST",
        body: JSON.stringify({
          pairingCode: pairing.pairingCode,
          gatewayUrl: harness.gatewayUrl,
          trustMode,
        }),
      });
      expect(response.status, trustMode).toBe(400);
      expect(await response.json(), trustMode).toEqual({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        detail: [
          {
            path: "/trustMode",
            message: 'Invalid option: expected one of "auto"|"system"|"pinned-leaf"',
          },
        ],
      });
    }
  });

  test("the pairing address list names no Omnesis address", async () => {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "android", name: "Fictional address-list phone" }),
    });
    const plan = await harness.gatewayJson<{ addresses: Array<Record<string, unknown>> }>(
      "/admin/devices/pair-addresses",
      { method: "POST", body: JSON.stringify({ pairingCode: pairing.pairingCode }) },
    );
    expect(plan.addresses.length).toBeGreaterThan(0);
    for (const address of plan.addresses) {
      expect(address).not.toHaveProperty("kind");
      expect(address.label).not.toBe("Omnesis address");
    }
  });

  test("the pairing-reminder capability and claim header mean nothing", async () => {
    // An unknown capability key is passed through whatever its value.
    const phone = await pairDevice("android", { platform: "android", pairingNotifications: "yes" });
    expect(phone.status).toBe(200);
    const listed = await harness.gatewayJson<{
      items: Array<{ id: string; capabilities: Record<string, unknown> }>;
    }>("/admin/devices");
    expect(
      listed.items.find((device) => device.id === phone.deviceId)?.capabilities
        .pairingNotifications,
    ).toBe("yes");
    const claimToken = await harness.gatewayJson<{ token: string }>("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({ deviceId: phone.deviceId, scopes: ["push:claim"] }),
    });
    for (const header of [undefined, "1"]) {
      const claim = await fetch(`${harness.gatewayUrl}/notifications/claim`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${claimToken.token}`,
          "content-type": "application/json",
          ...(header ? { "X-Omnesis-Pairing-Notifications": header } : {}),
        },
        body: "{}",
      });
      expect(claim.status).toBe(204);
    }
  });

  test("the gateway's config directory holds nothing of the cloud relay", () => {
    const configDir = (harness as unknown as { configDir: string }).configDir;
    const entries = readdirSync(configDir, { recursive: true }).map(String);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((entry) => /cloud-relay|acme|enrollment/i.test(entry))).toEqual([]);
  });

  test("devices and identity responses carry no enrollment fields", async () => {
    const devices = await harness.gatewayJson<{ items: Array<Record<string, unknown>> }>(
      "/admin/devices",
    );
    expect(devices.items.length).toBeGreaterThan(0);
    for (const device of devices.items) {
      expect(device).not.toHaveProperty("enrollment");
      expect(JSON.stringify(device)).not.toMatch(/enrollment/i);
    }
    const whoami = await harness.gatewayJson<Record<string, unknown>>("/whoami");
    expect(whoami).not.toHaveProperty("enrollment");
    expect(JSON.stringify(whoami)).not.toMatch(/enrollment/i);
  });

  test("the CLI's help lists no cloud or enrollment commands, while the flag reveals them", async () => {
    expect(await cli(["--help"], false)).not.toMatch(/^\s+cloud\b/m);
    // The same help with the flag on, so the absence above is meaningful.
    expect(await cli(["--help"], true)).toMatch(/^\s+cloud\b/m);
  });

  test("`omnesis cloud` is an unknown command, and its help lists no enrollment commands", async () => {
    for (const args of [
      ["cloud"],
      ["cloud", "pair"],
      ["cloud", "connect"],
      ["cloud", "status"],
      ["cloud", "unlink"],
      ["cloud", "trusted-sign-ins"],
      ["cloud", "incidents", "list"],
      ["cloud", "incidents", "ack"],
      ["cloud", "remove-sign-in", "fictional"],
    ]) {
      const run = await cliRun(args, false);
      expect(run.code, args.join(" ")).not.toBe(0);
      expect(run.output, args.join(" ")).toMatch(/unknown command/i);
    }
    // Without the command, its help falls back to the top-level usage.
    const cloudCommands = [
      "Connect this gateway to your Omnesis account with one sign-in",
      "Sign in to your Omnesis account, choose a gateway",
      "Your Omnesis account: connect this gateway and add devices",
    ];
    const help = await cli(["cloud", "--help"], false);
    for (const description of cloudCommands) expect(help).not.toContain(description);
    // With the flag the same command exists and lists them.
    const enabled = await cli(["cloud", "--help"], true);
    for (const description of cloudCommands) expect(enabled).toContain(description);
  });

  test("QR pairing gives a collector its unchanged default scopes", async () => {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "collector", name: "Fictional rack collector" }),
    });
    const redeemed = await fetch(`${harness.gatewayUrl}/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: pairing.pairingCode,
        capabilities: { platform: "linux" },
      }),
    });
    expect(redeemed.status).toBe(200);
    const paired = (await redeemed.json()) as { scopes: string[]; device: Record<string, unknown> };
    expect([...paired.scopes].sort()).toEqual(["read", "write:*"]);
    expect([...paired.scopes].sort()).toEqual([...defaultScopesForDeviceKind("collector")].sort());
    expect(paired.device).not.toHaveProperty("enrollment");
  });
});
