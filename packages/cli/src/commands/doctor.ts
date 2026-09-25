// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  ensureGatewayTrust,
  holderIsAlive,
  readGatewayLockHolder,
  resolveToken,
  type TlsLifecycleSnapshot,
} from "@omnesis/core";
import {
  collectSecurityData,
  evaluateDoctor,
  PROCESS_VITALS_WINDOW_SECONDS,
} from "@omnesis/core/doctor";
import {
  c,
  gatewayFetch,
  targetsLocalGateway,
  isJSON,
  withSpinner,
  CliError,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  GATEWAY_REQUEST_URL,
} from "../utils.js";
import { renderDoctor } from "./doctor-render.js";
import {
  assertFleetDoctorOk,
  renderFleetDoctor,
  resolveDeviceSelector,
  runFleetDoctor,
  type FleetDoctorDeps,
  type FleetDoctorEntry,
} from "./doctor-fleet.js";
import type {
  DoctorData,
  WhoAmIResult,
  ConfigResult,
  ConfigStatusResult,
  DeviceEntry,
  SourceEntry,
  SyncStatusEntry,
  ModelsResult,
  SystemInfoResult,
  IndexStatsResult,
  OverallStatusResult,
  ProcessVitalsResult,
} from "@omnesis/core/doctor";

interface Page<T> {
  items: T[];
}

/**
 * Fetch+parse one endpoint, returning `null` on any non-OK status or
 * network error. doctor's whole point is to keep running when individual
 * endpoints fail — a missing slot becomes its own diagnostic in the
 * evaluator rather than aborting the command. The optional `onStatus`
 * callback lets a caller observe the raw HTTP status (used to distinguish
 * a 401/403 on /whoami from a generic failure).
 */
async function tryJson<T>(path: string, onStatus?: (status: number) => void): Promise<T | null> {
  try {
    const res = await gatewayFetch(path);
    onStatus?.(res.status);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Probe `GET /health` — public, unauthenticated liveness, and the one place
 * the gateway's own product version is readable without a token.
 */
async function probeHealth(): Promise<{ reachable: boolean; version?: string | null }> {
  try {
    const url = `${GATEWAY_REQUEST_URL}/health`;
    const res = await fetch(url, { headers: { "User-Agent": "omnesis" } });
    if (!res.ok) return { reachable: false };
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
    return {
      reachable: true,
      version: typeof body?.version === "string" ? body.version : null,
    };
  } catch {
    return { reachable: false };
  }
}

/** Fetch every endpoint in parallel and fold into the doctor bundle. */
async function collect(): Promise<DoctorData> {
  let authError = false;
  const noteWhoamiStatus = (status: number) => {
    if (status === 401 || status === 403) authError = true;
  };

  const [
    health,
    whoami,
    config,
    configStatus,
    devicesPage,
    sourcesPage,
    syncStatusPage,
    models,
    systemInfo,
    indexStats,
    overall,
    tls,
    processVitals,
    sweeps,
  ] = await Promise.all([
    probeHealth(),
    tryJson<WhoAmIResult>("/whoami", noteWhoamiStatus),
    tryJson<ConfigResult>("/config"),
    tryJson<ConfigStatusResult>("/admin/config/status"),
    tryJson<Page<DeviceEntry>>("/admin/devices"),
    tryJson<Page<SourceEntry>>("/admin/sources"),
    tryJson<Page<SyncStatusEntry>>("/admin/sync/status"),
    tryJson<ModelsResult>("/admin/models"),
    tryJson<SystemInfoResult>("/admin/system-info"),
    tryJson<IndexStatsResult>("/index/stats"),
    tryJson<OverallStatusResult>("/status"),
    // 404s on a gateway that predates the certificate lifecycle: no section.
    tryJson<TlsLifecycleSnapshot>("/admin/tls"),
    tryJson<ProcessVitalsResult>(`/admin/process-vitals?window=${PROCESS_VITALS_WINDOW_SECONDS}`),
    // 404s whenever the briefs feature is inactive — an absent section, not a
    // fault, which is exactly what a null slot means to the evaluator.
    tryJson<SweepsListResult>("/admin/brain/sweeps"),
  ]);

  return {
    target: "gateway",
    operationalChecks: true,
    health,
    authError,
    whoami,
    config,
    configStatus,
    devices: devicesPage?.items ?? null,
    sources: sourcesPage?.items ?? null,
    syncStatus: syncStatusPage?.items ?? null,
    models,
    systemInfo,
    indexStats,
    overall: overall ? { ...overall, tls: tls ?? null } : null,
    processVitals,
    sweeps: sweeps
      ? {
          laneEnabled: sweeps.laneEnabled,
          enabledCount: sweeps.items.filter((i) => i.enabled).length,
          issues: sweeps.issues,
          digestWindowConflicts: sweeps.digestWindowConflicts,
        }
      : null,
    security: null,
  };
}

/** The slice of `GET /admin/brain/sweeps` the doctor reads. */
interface SweepsListResult {
  laneEnabled: boolean;
  items: { enabled: boolean }[];
  issues: { id: string; file: string; message: string }[];
  digestWindowConflicts: { id: string; at: string }[];
}

/**
 * The gateway that owns this config dir, if any. Only meaningful when the
 * doctor targets a gateway on this machine: a lock beside a remote gateway's
 * URL belongs to some other gateway and says nothing about the one probed.
 */
function readGatewayLock(configDir: string): DoctorData["gatewayLock"] {
  if (!targetsLocalGateway()) return undefined;
  const holder = readGatewayLockHolder(configDir);
  if (!holder) return null;
  return { pid: holder.pid, startedAt: holder.startedAt, alive: holderIsAlive(holder) };
}

function emptyOperationalData(security: DoctorData["security"]): DoctorData {
  return {
    target: "gateway",
    operationalChecks: false,
    health: { reachable: false },
    authError: false,
    whoami: null,
    config: null,
    configStatus: null,
    devices: null,
    sources: null,
    syncStatus: null,
    models: null,
    systemInfo: null,
    indexStats: null,
    overall: null,
    processVitals: null,
    sweeps: null,
    security,
  };
}

/**
 * Whether to run the local security-posture checks. They're shown by default —
 * "is my data actually protected?" is a first-class question `doctor` should
 * answer without a flag, and the checks are local + read-only + fault-tolerant,
 * so they run even when the gateway is down. `--no-security` opts out (e.g. a
 * script that only wants the operational health of the gateway).
 * `--fix-permissions` implies them (it repairs the same local state). The
 * `--security` flag is accepted for back-compat but is now redundant.
 */
export function resolveIncludeSecurity(args: {
  "no-security"?: unknown;
  // What citty actually produces for `--no-security`: a negation of a
  // flag named `security`, not the key the flag is declared under.
  security?: unknown;
  "fix-permissions"?: unknown;
}): boolean {
  if (args["fix-permissions"]) return true;
  // citty parses `--no-security` as a negation of `security`, so the flag
  // never arrives under the key it is declared as. Read both: the negated
  // key is what a command line produces, the declared key what a
  // programmatic caller passes.
  if (args["no-security"] === true || args.security === false) return false;
  return true;
}

/** Pin or verify the gateway's certificate the way every other command does before talking to it. */
async function trustGateway(configDir: string): Promise<void> {
  try {
    const tofu = await ensureGatewayTrust({ gatewayUrl: GATEWAY_REQUEST_URL, configDir });
    if (tofu.action === "insecure-mode") {
      process.stderr.write(
        "Warning: OMNESIS_INSECURE_TLS is set — TLS certificate verification disabled\n",
      );
    }
  } catch (err) {
    throw new CliError(
      `TLS trust failed: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_FAILURE,
    );
  }
}

/**
 * `--device` / `--fleet`: the gateway runs the checks on the collectors and
 * this side waits and prints. Both flags need a reachable gateway and an
 * admin token; the local security posture of this host is not part of it.
 */
async function runFleetFromCli(device: unknown, fleet: boolean): Promise<void> {
  if (device !== undefined && fleet) {
    throw new CliError("Pass either --device <name|id> or --fleet, not both.", EXIT_USER_ERROR);
  }
  if (device !== undefined && (typeof device !== "string" || device.trim() === "")) {
    throw new CliError("--device takes a device name or id.", EXIT_USER_ERROR);
  }
  const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  await trustGateway(configDir);
  const deps: FleetDoctorDeps = {
    async listDevices() {
      const res = await gatewayFetch("/admin/devices");
      if (!res.ok) throw new CliError(`Could not list devices: HTTP ${res.status}`, EXIT_FAILURE);
      const page = (await res.json()) as Page<{ id: string; name: string }>;
      return page.items.map((entry) => ({ id: entry.id, name: entry.name }));
    },
    async request(deviceIds) {
      const res = await gatewayFetch("/admin/fleet/doctor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deviceIds ? { deviceIds } : {}),
      });
      if (!res.ok) {
        throw new CliError(`Could not request health checks: HTTP ${res.status}`, EXIT_FAILURE);
      }
      return ((await res.json()) as { devices: FleetDoctorEntry[] }).devices;
    },
    async list() {
      const res = await gatewayFetch("/admin/fleet/doctor");
      if (!res.ok)
        throw new CliError(`Could not read health checks: HTTP ${res.status}`, EXIT_FAILURE);
      return ((await res.json()) as { devices: FleetDoctorEntry[] }).devices;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  const ids = device ? [resolveDeviceSelector(await deps.listDevices(), device)] : undefined;
  const entries = await withSpinner(
    device ? `Running health checks on ${device}` : "Running health checks across the fleet",
    () => runFleetDoctor(deps, ids),
  );
  if (isJSON) {
    console.log(JSON.stringify({ devices: entries }, null, 2));
  } else {
    renderFleetDoctor(entries);
  }
  assertFleetDoctorOk(entries);
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose the health and security posture of your Omnesis setup (read-only)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
    "no-security": {
      type: "boolean",
      description: "Skip the local security posture checks (shown by default)",
    },
    security: {
      type: "boolean",
      description: "Deprecated — security posture is shown by default; this flag is a no-op",
    },
    "fix-permissions": {
      type: "boolean",
      description: "Repair owner-only modes under the Omnesis config directory",
    },
    device: {
      type: "string",
      description:
        "Run the health check on one paired collector (by name or id) and print its report",
    },
    fleet: {
      type: "boolean",
      description: "Run the health check on every paired collector and print their reports",
    },
  },
  async run(ctx) {
    if (ctx.args.device !== undefined || ctx.args.fleet) {
      await runFleetFromCli(ctx.args.device, Boolean(ctx.args.fleet));
      return;
    }
    const includeSecurity = resolveIncludeSecurity(ctx.args);
    const fixPermissions = Boolean(ctx.args["fix-permissions"]);
    const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
    const token = resolveToken();

    // A token is required for the admin/read endpoints. Fail early with a
    // clear message rather than reporting every authed check as "could
    // not read".
    if (!token && !includeSecurity) {
      const msg =
        "No auth token found. Start the gateway first or set OMNESIS_TOKEN — or drop --no-security to review the local security posture, which needs no gateway.";
      throw new CliError(isJSON ? msg : `${c.red}${msg}${c.reset}`, EXIT_FAILURE);
    }
    if (token) await trustGateway(configDir);

    const data = await withSpinner("Running diagnostics", async () => {
      const security = includeSecurity
        ? await collectSecurityData({ configDir, fixPermissions })
        : null;
      const operational = token ? await collect() : emptyOperationalData(security);
      return { ...operational, security, gatewayLock: readGatewayLock(configDir) };
    });
    const report = evaluateDoctor(data);

    if (isJSON) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      renderDoctor(report);
    }

    // Exit non-zero only when at least one check FAILED. Warnings keep a
    // clean (0) exit so scripts can distinguish "broken" from "degraded".
    if (!report.ok) {
      throw new CliError("", EXIT_FAILURE);
    }
  },
});
