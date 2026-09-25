// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis doctor --device <name|id>` and `--fleet`: ask the gateway to run
 * a health check on one or every paired collector and print the reports
 * here. The gateway dispatches the run over the device socket, the
 * collector audits its own host and answers with the evaluated report, and
 * this side only waits for the entries to settle and renders them — the
 * same view the portal shows under Settings → Devices, reachable from a
 * terminal so the remedies the reports name can be acted on where they say.
 */

import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import { renderDoctor } from "./doctor-render.js";
import type { DoctorReport } from "@omnesis/core/doctor";

/** One device's row in `GET /admin/fleet/doctor`. */
export interface FleetDoctorEntry {
  deviceId: string;
  name: string;
  kind: string;
  online: boolean;
  state: "not-run" | "pending" | "running" | "complete" | "failed" | "not-applicable";
  detail: string | null;
  report: DoctorReport | null;
}

export interface FleetDoctorDeps {
  /** `GET /admin/devices` — id and name of every device, for selectors. */
  listDevices(): Promise<Array<{ id: string; name: string }>>;
  /** `POST /admin/fleet/doctor` — request runs; omitted ids means every device. */
  request(deviceIds?: string[]): Promise<FleetDoctorEntry[]>;
  /** `GET /admin/fleet/doctor` — the current entries. */
  list(): Promise<FleetDoctorEntry[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const SETTLE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

const TERMINAL = new Set<FleetDoctorEntry["state"]>(["complete", "failed", "not-applicable"]);

/**
 * Resolve `--device` to one device id: an exact id, else an exact name
 * (case-insensitive). Two devices with the same name is a question the
 * operator has to answer by id.
 */
export function resolveDeviceSelector(
  devices: ReadonlyArray<{ id: string; name: string }>,
  selector: string,
): string {
  const byId = devices.find((device) => device.id === selector);
  if (byId) return byId.id;
  const wanted = selector.trim().toLowerCase();
  const byName = devices.filter((device) => device.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new CliError(
      `${byName.length} devices are named "${selector}"; pick one by id: ${byName.map((device) => device.id).join(", ")}`,
      EXIT_USER_ERROR,
    );
  }
  throw new CliError(
    `No device named "${selector}". Run \`omnesis devices list\` to see the paired devices.`,
    EXIT_USER_ERROR,
  );
}

/**
 * Request runs for the selected devices (every device when none is given)
 * and wait until each has settled. An entry the gateway marks
 * not-applicable — a phone, a browser — settles at once.
 */
export async function runFleetDoctor(
  deps: FleetDoctorDeps,
  deviceIds?: string[],
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<FleetDoctorEntry[]> {
  const requested = await deps.request(deviceIds);
  const wanted = new Set(deviceIds ?? requested.map((entry) => entry.deviceId));
  const settled = (entries: FleetDoctorEntry[]) =>
    entries.filter((entry) => wanted.has(entry.deviceId));
  let latest = settled(requested);
  const deadline = deps.now() + timeoutMs;
  while (!latest.every((entry) => TERMINAL.has(entry.state))) {
    if (deps.now() >= deadline) break;
    await deps.sleep(POLL_INTERVAL_MS);
    latest = settled(await deps.list());
  }
  return latest;
}

/** True when every settled report is clean; a run that failed or never settled is not. */
export function fleetDoctorOk(entries: readonly FleetDoctorEntry[]): boolean {
  return entries.every(
    (entry) =>
      entry.state === "not-applicable" || (entry.state === "complete" && entry.report?.ok === true),
  );
}

export function renderFleetDoctor(entries: readonly FleetDoctorEntry[]): void {
  if (entries.length === 0) {
    console.log(`${c.dim}No devices to check.${c.reset}`);
    return;
  }
  for (const entry of entries) {
    console.log();
    console.log(
      `${c.bold}${entry.name}${c.reset} ${c.dim}(${entry.kind}, ${entry.online ? "online" : "offline"})${c.reset}`,
    );
    if (entry.state === "complete" && entry.report) {
      renderDoctor(entry.report);
      continue;
    }
    if (entry.state === "not-applicable") {
      console.log(
        `  ${c.dim}N/A — ${entry.detail ?? "health checks do not apply to this device"}${c.reset}`,
      );
    } else if (entry.state === "failed") {
      console.log(`  ${c.red}✖ ${entry.detail ?? "the health check failed"}${c.reset}`);
    } else {
      console.log(
        `  ${c.yellow}… ${entry.state}${c.reset}${c.dim} — ${
          entry.online
            ? "the collector has not answered yet; run again in a moment"
            : "the collector is offline; it runs the check when it reconnects"
        }${c.reset}`,
      );
    }
  }
  console.log();
}

/** Exit non-zero when a report failed or a run did not settle, as `doctor` does locally. */
export function assertFleetDoctorOk(entries: readonly FleetDoctorEntry[]): void {
  if (!fleetDoctorOk(entries)) throw new CliError("", EXIT_FAILURE);
}
