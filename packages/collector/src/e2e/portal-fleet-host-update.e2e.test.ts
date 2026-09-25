// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Gateway restart and fleet dispatch through the portal's durable host operation. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { atomicWriteFileSync, MINIMUM_CLIENT_VERSIONS, type FleetUpdatePlan } from "@omnesis/core";
import {
  readPortalFleetUpdateOperation,
  type PortalFleetUpdateOperation,
} from "@omnesis/core/portal-fleet-update";
import { loginPortal, type PortalSession } from "./mcp-oauth-helper.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";

interface HostUpdateSnapshot {
  plan: FleetUpdatePlan & {
    id: string;
    currentVersion: string;
    targetVersion: string;
    supported: boolean;
  };
  operation: PortalFleetUpdateOperation | null;
}

describe("portal gateway-first fleet update", () => {
  let harness: MultiCollectorHarness;
  let portal: PortalSession;

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      extraGatewayEnv: {
        OMNESIS_SYNTHETIC: "1",
        OMNESIS_E2E_PORTAL_FLEET_UPDATE: "1",
        OMNESIS_E2E_PORTAL_FLEET_UPDATE_CLI_ENTRY: join(
          import.meta.dirname,
          "../../../cli/src/index.ts",
        ),
      },
    });
    await harness.start();
    portal = await loginPortal({
      gatewayUrl: harness.gatewayUrl,
      apiKey: harness.bootstrapToken,
    });
  }, 180_000);

  afterAll(async () => {
    if (harness) {
      atomicWriteFileSync(
        join(harness.gatewayConfigDir, "portal-updates", "e2e-host-updated"),
        "continue\n",
        { ensureDir: true, mode: 0o600 },
      );
    }
    await harness?.destroy();
  });

  async function portalJson<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(`${harness.gatewayUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Cookie: portal.cookie,
        "X-Omnesis-CSRF": portal.csrfToken,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  test("persists before launch, recovers after restart, then dispatches the existing fleet plan", async () => {
    const collector = await harness.addCollector({
      name: "portal-fleet-collector",
      hostableSourceTypes: [],
      version: MINIMUM_CLIENT_VERSIONS.collector,
    });
    const reviewed = await portalJson<HostUpdateSnapshot>("/admin/fleet/host-update");
    expect(reviewed.plan).toMatchObject({ supported: true });
    expect(reviewed.plan.currentVersion).not.toBe(reviewed.plan.targetVersion);
    expect(reviewed.plan.devices).toContainEqual(
      expect.objectContaining({
        id: collector.deviceId,
        disposition: { kind: "update" },
      }),
    );

    const started = await portalJson<{ operation: PortalFleetUpdateOperation }>(
      "/admin/fleet/host-update",
      { method: "POST", body: { planId: reviewed.plan.id } },
    );
    const launchPath = join(harness.gatewayConfigDir, "portal-updates", "e2e-launch.json");
    await waitForCondition(() => existsSync(launchPath), 10_000, "the independent launch record");
    const launch = JSON.parse(readFileSync(launchPath, "utf8")) as {
      operation: PortalFleetUpdateOperation;
    };
    expect(launch.operation).toMatchObject({
      id: started.operation.id,
      targetVersion: reviewed.plan.targetVersion,
      state: "queued",
    });
    expect(collector.updater.calls).toEqual([]);
    const readyPath = join(harness.gatewayConfigDir, "portal-updates", "e2e-updater-ready.json");
    await waitForCondition(() => existsSync(readyPath), 10_000, "the independent updater");
    const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
      operationId: string;
      args: string[];
    };
    expect(ready).toMatchObject({ operationId: started.operation.id });
    expect(ready.args.slice(-4)).toEqual([
      "update",
      "--yes",
      "--fleet",
      `--target-version=${reviewed.plan.targetVersion}`,
    ]);

    expect(collector.updater.calls).toEqual([]);
    await harness.restartGateway();
    const recovered = await portalJson<HostUpdateSnapshot>("/admin/fleet/host-update");
    expect(recovered.operation).toMatchObject({ id: started.operation.id, state: "running" });
    expect(collector.updater.calls).toEqual([]);

    atomicWriteFileSync(
      join(harness.gatewayConfigDir, "portal-updates", "e2e-host-updated"),
      "continue\n",
      { ensureDir: true, mode: 0o600 },
    );
    await waitForCondition(
      () => collector.updater.calls.length === 1,
      10_000,
      "fleet dispatch after the gateway restart",
    );
    expect(collector.updater.calls).toEqual([reviewed.plan.targetVersion]);
    await waitForCondition(
      () => readPortalFleetUpdateOperation(harness.gatewayConfigDir)?.state === "succeeded",
      10_000,
      "the independent updater's terminal operation",
    );
    expect(await portalJson<HostUpdateSnapshot>("/admin/fleet/host-update")).toMatchObject({
      operation: { id: started.operation.id, state: "succeeded" },
    });
  }, 180_000);
});
