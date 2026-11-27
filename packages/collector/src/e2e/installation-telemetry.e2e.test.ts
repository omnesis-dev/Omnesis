// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { AddressInfo } from "node:net";

interface Report {
  schemaVersion: number;
  installationId: string;
  gatewayVersion: string;
  gitCommit: string;
  os: string;
  arch: string;
  period: string;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("installation census through a real isolated gateway and fake HTTP ingestion", () => {
  let server: Server;
  let harness: MultiCollectorHarness;
  const reports: Report[] = [];
  const env: NodeJS.ProcessEnv = { OMNESIS_RUNTIME_MODE: "test", OMNESIS_TELEMETRY: "on" };
  let reject = false;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Report);
      response.writeHead(reject ? 503 : 204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.OMNESIS_E2E_TELEMETRY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/heartbeat`;
    harness = new MultiCollectorHarness({
      extraGatewayEnv: env,
      gatewayConfig: { telemetry: { enabled: true, acknowledged: false } },
    });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    await new Promise<void>((resolve, rejectClose) => {
      server?.close((error) => (error ? rejectClose(error) : resolve()));
      server?.closeAllConnections();
    });
  }, 60_000);

  const patch = (telemetry: Record<string, boolean>) =>
    harness.json("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ telemetry }),
    });

  test("displaying the notice admits only the seven fields; opt-out, restart and failures stay isolated", async () => {
    await pause(600);
    expect(reports).toHaveLength(0);
    await patch({ noticeShown: true });
    await waitForCondition(
      () => reports.length > 0,
      10_000,
      "a local census report after the notice is displayed",
    );
    const first = reports[0]!;
    expect(Object.keys(first).sort()).toEqual(
      [
        "schemaVersion",
        "installationId",
        "gatewayVersion",
        "gitCommit",
        "os",
        "arch",
        "period",
      ].sort(),
    );
    expect(first.installationId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.period).toBe(new Date().toISOString().slice(0, 7));
    expect(first.gitCommit).toBe("custom");
    const secret = readFileSync(
      join(harness.gatewayConfigDir, "telemetry-secret-v1"),
      "utf8",
    ).trim();
    expect(JSON.stringify(first)).not.toContain(secret);

    await patch({ acknowledged: true });
    await patch({ enabled: false });
    await pause(150);
    const stoppedAt = reports.length;
    await pause(750);
    expect(reports).toHaveLength(stoppedAt);
    await harness.restartGateway();
    await pause(500);
    expect(reports).toHaveLength(stoppedAt);
    const { config } = await harness.json<{
      config: { telemetry: { enabled: boolean; acknowledged: boolean } };
    }>("/admin/config");
    expect(config.telemetry).toMatchObject({ enabled: false, acknowledged: true });
    await patch({ enabled: true });
    await waitForCondition(
      () => reports.length > stoppedAt,
      10_000,
      "a re-enabled local census report",
    );
    expect(reports.at(-1)!.installationId).toBe(first.installationId);
    expect(readFileSync(join(harness.gatewayConfigDir, "telemetry-secret-v1"), "utf8").trim()).toBe(
      secret,
    );

    reject = true;
    const beforeFailure = reports.length;
    await waitForCondition(() => reports.length > beforeFailure, 10_000, "an ingestion rejection");
    expect(await harness.json("/health")).toMatchObject({ status: "ok" });
    reject = false;
    await patch({ enabled: false });

    env.OMNESIS_TELEMETRY = "off";
    await patch({ enabled: true });
    await harness.restartGateway();
    const forcedOffAt = reports.length;
    await pause(750);
    expect(reports).toHaveLength(forcedOffAt);
    expect(await harness.json("/admin/telemetry")).toMatchObject({
      forcedDisabled: true,
      enabled: false,
    });
  }, 120_000);
});

describe("test gateways cannot acquire a production telemetry transport", () => {
  test("enabled and acknowledged config plus inherited production mode still reports nothing", async () => {
    const harness = new MultiCollectorHarness({
      extraGatewayEnv: { OMNESIS_RUNTIME_MODE: "production", OMNESIS_TELEMETRY: "on" },
      gatewayConfig: { telemetry: { enabled: true, acknowledged: true } },
    });
    try {
      await harness.start();
      expect(await harness.json("/admin/telemetry")).toMatchObject({
        configuredEnabled: true,
        acknowledged: true,
        runtimeAllowed: false,
        enabled: false,
      });
      await pause(500);
      // The production service is never constructed, so it cannot even create its secret.
      expect(existsSync(join(harness.gatewayConfigDir, "telemetry-secret-v1"))).toBe(false);
      expect(existsSync(join(harness.gatewayConfigDir, "telemetry-last-attempt-v1"))).toBe(false);
    } finally {
      await harness.destroy();
    }
  }, 240_000);
});
