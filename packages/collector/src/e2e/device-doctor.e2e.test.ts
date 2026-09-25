// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { DoctorReport } from "@omnesis/core/doctor";

interface FleetDoctorResponse {
  devices: Array<{
    deviceId: string;
    state: "not-run" | "pending" | "running" | "complete" | "failed" | "not-applicable";
    requestedAt: string | null;
    detail: string | null;
    report: DoctorReport | null;
  }>;
}

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "../../../..");

/**
 * The real CLI against this gateway: `omnesis doctor --device` and `--fleet`
 * go through the same fleet routes the portal uses, so the terminal gets
 * the collectors' own reports rather than a probe of the gateway host.
 */
async function runDoctorCli(
  harness: MultiCollectorHarness,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "packages/cli/src/index.ts", "doctor", ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          OMNESIS_GATEWAY_URL: harness.gatewayUrl,
          OMNESIS_TOKEN: harness.bootstrapToken,
          OMNESIS_CONFIG_DIR: harness.gatewayConfigDir,
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          NO_COLOR: "1",
          CI: "1",
        },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { stdout, exitCode: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

const healthyReport = (message: string): DoctorReport => ({
  ok: true,
  summary: { errors: 0, warnings: 0 },
  checks: [
    {
      id: "gateway.not-applicable",
      section: "Gateway",
      status: "not-applicable",
      message: "Evaluated only on the gateway host",
    },
    { id: "process.event-loop", section: "Process", status: "pass", message },
  ],
});

describe("device doctor fleet orchestration", () => {
  const harness = new MultiCollectorHarness();
  let gatewayVersion = "";

  beforeAll(async () => {
    await harness.start();
    gatewayVersion = (await harness.json<{ version: string }>("/health")).version;
  }, 30_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("the CLI asks for one collector's report by name and prints what that collector answered", async () => {
    const attic = await harness.addCollector({
      name: "attic-mini",
      hostableSourceTypes: [],
      version: gatewayVersion,
      doctorReport: healthyReport("attic-mini process is responsive"),
    });
    const byName = await runDoctorCli(harness, ["--device", "attic-mini", "--json"]);
    expect(byName.exitCode).toBe(0);
    const parsed = JSON.parse(byName.stdout) as {
      devices: Array<{ deviceId: string; state: string; report: DoctorReport | null }>;
    };
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]).toMatchObject({ deviceId: attic.deviceId, state: "complete" });
    expect(parsed.devices[0]?.report?.checks).toContainEqual(
      expect.objectContaining({ message: "attic-mini process is responsive" }),
    );

    const rendered = await runDoctorCli(harness, ["--device", attic.deviceId]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain("attic-mini");
    expect(rendered.stdout).toContain("attic-mini process is responsive");

    const unknown = await runDoctorCli(harness, ["--device", "no-such-device"]);
    expect(unknown.exitCode).not.toBe(0);
  }, 90_000);

  test("fans out and keeps each collector's correlated report distinct", async () => {
    const studio = await harness.addCollector({
      name: "collector-alpha",
      hostableSourceTypes: [],
      version: gatewayVersion,
      doctorReport: healthyReport("collector-alpha process is responsive"),
    });
    const workshop = await harness.addCollector({
      name: "Riverside collector",
      hostableSourceTypes: [],
      version: gatewayVersion,
      doctorReport: healthyReport("Riverside process is responsive"),
    });

    await harness.json<FleetDoctorResponse>("/admin/fleet/doctor", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [studio.deviceId, workshop.deviceId] }),
    });
    const settled = await waitForFleet(harness, [studio.deviceId, workshop.deviceId], "complete");

    expect(reportFor(settled, studio.deviceId)?.checks).toContainEqual(
      expect.objectContaining({ message: "collector-alpha process is responsive" }),
    );
    expect(reportFor(settled, workshop.deviceId)?.checks).toContainEqual(
      expect.objectContaining({ message: "Riverside process is responsive" }),
    );
    expect(reportFor(settled, studio.deviceId)?.checks).toContainEqual(
      expect.objectContaining({ id: "gateway.not-applicable", status: "not-applicable" }),
    );
  });

  test("an offline request stays pending and completes after reconnect", async () => {
    const traveller = await harness.addCollector({
      name: "Trailhead collector",
      hostableSourceTypes: [],
      version: gatewayVersion,
      doctorReport: healthyReport("Trailhead process is responsive"),
    });
    await harness.disconnectCollector(traveller);

    const pending = await harness.json<FleetDoctorResponse>("/admin/fleet/doctor", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [traveller.deviceId] }),
    });
    expect(entryFor(pending, traveller.deviceId)).toMatchObject({ state: "pending" });

    await harness.reconnectCollector(traveller);
    const settled = await waitForFleet(harness, [traveller.deviceId], "complete");
    expect(reportFor(settled, traveller.deviceId)?.checks).toContainEqual(
      expect.objectContaining({ message: "Trailhead process is responsive" }),
    );
  });

  test("one collector can refuse without failing the fleet HTTP request", async () => {
    const refusing = await harness.addCollector({
      name: "Archive collector",
      hostableSourceTypes: [],
      version: gatewayVersion,
      doctorResponse: { accepted: false, reason: "Diagnostics are busy." },
    });

    await harness.json<FleetDoctorResponse>("/admin/fleet/doctor", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [refusing.deviceId] }),
    });
    const response = await waitForFleet(harness, [refusing.deviceId], "failed");

    expect(entryFor(response, refusing.deviceId)).toMatchObject({
      state: "failed",
      detail: "Diagnostics are busy.",
    });
  });

  test("parks an acknowledged run across disconnect and resumes that same run", async () => {
    const field = await harness.addCollector({
      name: "Field collector",
      hostableSourceTypes: [],
      version: gatewayVersion,
      doctorReport: healthyReport("Field process is responsive"),
      doctorResultDelayMs: 1_000,
    });

    await harness.json<FleetDoctorResponse>("/admin/fleet/doctor", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [field.deviceId] }),
    });
    const running = await waitForFleet(harness, [field.deviceId], "running");
    const requestedAt = entryFor(running, field.deviceId)?.requestedAt;

    await harness.disconnectCollector(field);
    const parked = await waitForFleet(harness, [field.deviceId], "pending");
    expect(entryFor(parked, field.deviceId)).toMatchObject({ requestedAt, report: null });

    await harness.reconnectCollector(field);
    const settled = await waitForFleet(harness, [field.deviceId], "complete");
    expect(entryFor(settled, field.deviceId)).toMatchObject({ requestedAt });
    expect(reportFor(settled, field.deviceId)?.checks).toContainEqual(
      expect.objectContaining({ message: "Field process is responsive" }),
    );
  });

  test("does not command a legacy collector that lacks the explicit capability", async () => {
    const legacy = await harness.addCollector({
      name: "Legacy collector",
      hostableSourceTypes: [],
      version: gatewayVersion,
      deviceDoctor: false,
    });

    const response = await harness.json<FleetDoctorResponse>("/admin/fleet/doctor", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [legacy.deviceId] }),
    });

    expect(entryFor(response, legacy.deviceId)).toMatchObject({
      state: "not-applicable",
      detail: expect.stringContaining("does not advertise"),
    });
    expect(legacy.receivedCommands.some((command) => command.type === "device.doctor")).toBe(false);
  });
});

function entryFor(response: FleetDoctorResponse, deviceId: string) {
  return response.devices.find((entry) => entry.deviceId === deviceId);
}

function reportFor(
  response: FleetDoctorResponse,
  deviceId: string,
): DoctorReport | null | undefined {
  return entryFor(response, deviceId)?.report;
}

async function waitForFleet(
  harness: MultiCollectorHarness,
  deviceIds: string[],
  state: FleetDoctorResponse["devices"][number]["state"],
): Promise<FleetDoctorResponse> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await harness.json<FleetDoctorResponse>("/admin/fleet/doctor");
    if (deviceIds.every((id) => entryFor(response, id)?.state === state)) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fleet doctor did not reach ${state}`);
}
