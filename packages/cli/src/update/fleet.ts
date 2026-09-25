// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis update --fleet` — this host first, then the devices it serves.
 *
 * The order is the whole point, and it is enforced twice. Here, because the
 * host update runs to completion before a single device is contacted; and on
 * the gateway, because the version it commands is always its own, so a fleet
 * cannot be sent past the build serving it.
 *
 * Between the two sits the check that makes the guarantee real rather than
 * hopeful: the gateway is asked what it is actually serving. On a machine
 * where the update could not restart the gateway itself — no service manager,
 * a hardened system unit, a daemon started by hand — the new code is on disk
 * and the old build is still answering, and fanning out from there would tell
 * every device to move to a version the gateway does not speak yet. That case
 * stops with an instruction instead.
 *
 * A gateway that did restart drops every device connection with it, and the
 * plan marks a device online only while its connection is live. Planning the
 * moment the new build answers would report the whole fleet offline, so the
 * daemons that were connected before the host update get a bounded window to
 * reconnect first; only the ones still missing after it are reported offline.
 *
 * After the commands go out, the run waits for each commanded device's own
 * account of its update — the result it reports, or its reconnect on the
 * target — and names every device that failed, refused or never answered.
 * Only then does it finish, and it fails when any of them did: a fan-out that
 * reported "dispatched" and exited 0 while a host refused would leave the
 * operator believing the fleet had moved.
 *
 * Pure orchestration: every effect is injected, so the order this file
 * guarantees is what its unit tests assert.
 */

import type { FleetUpdateEntry, FleetUpdateOutcome, FleetUpdatePlan } from "@omnesis/core";

/** How long devices connected before the host update may take to reconnect. */
export const RECONNECT_WAIT_MS = 90_000;

/** How often the plan is re-read while waiting for devices to reconnect. */
export const RECONNECT_POLL_MS = 2_500;

/**
 * How long commanded devices may take to report. A device's own update is
 * bounded by the same budget, so a device still silent past it is not
 * coming back with an answer.
 */
export const RESULT_WAIT_MS = 45 * 60 * 1_000;

/** How often the plan is re-read while waiting for results. */
export const RESULT_POLL_MS = 5_000;

/**
 * How long a device reporting "restart pending" is given to come back on
 * the target anyway. An agent harness can report that and then restart
 * after all — Hermes drains running work first, three minutes by default.
 */
export const RESTART_GRACE_MS = 5 * 60 * 1_000;

export interface FleetUpdateDeps {
  /** Bring this host to the target. Throws to abort the whole run. */
  updateHost(): Promise<void>;
  /** The version the gateway is serving right now, from `/health`. */
  servedVersion(): Promise<string>;
  /** The version this host was brought to, or null when it cannot be named (`--edge`). */
  hostVersion(): string | null;
  /** Exact source commit this host was brought to, for an advanced commit update. */
  hostCommit?(): string | null;
  plan(): Promise<FleetUpdatePlan>;
  /**
   * Which devices are connected, read before the host update. The release
   * plan, because an exact-commit plan is refused until the gateway runs
   * that commit. Defaults to `plan`.
   */
  connectedPlan?(): Promise<FleetUpdatePlan>;
  command(deviceIds: string[]): Promise<FleetUpdateOutcome[]>;
  /** Resolves true when the operator approved; false cancels that target. */
  approve(message: string): Promise<boolean>;
  log(line: string): void;
  /** Milliseconds on a monotonic-enough clock; only differences are used. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Raised when the fan-out must not happen; the message is for the operator. */
export class FleetUpdateRefused extends Error {}

/** How the devices this run commanded ended up. */
export interface FleetUpdateSummary {
  /** Reached the target. */
  updated: string[];
  /** The build is in place and a restart is owed that the device could not start. */
  restartPending: string[];
  /** Refused, failed or could not run the update, with the device's reason. */
  failed: Array<{ name: string; detail: string }>;
  /** Offline: the update is sent when they reconnect. */
  pending: string[];
  /** Commanded but silent until the wait ran out. */
  unanswered: string[];
}

/** Every commanded device is accounted for and none of them failed. */
export function fleetUpdateSucceeded(summary: FleetUpdateSummary): boolean {
  return summary.failed.length === 0 && summary.unanswered.length === 0;
}

const TERMINAL_FAILURE_STATES = new Set(["failed", "unsupported", "refused"]);

/**
 * Wait until each dispatched device has an outcome. A device is updated once
 * the plan reads it as current — the version it reports is the target — and
 * failed once its row records a failure. A plan read that fails mid-wait is
 * retried on the next poll.
 */
async function awaitResults(
  deps: FleetUpdateDeps,
  dispatched: Map<string, string>,
  summary: FleetUpdateSummary,
): Promise<void> {
  if (dispatched.size === 0) return;
  deps.log(
    `Waiting for ${dispatched.size} ${dispatched.size === 1 ? "device" : "devices"} to report…`,
  );
  const deadline = deps.now() + RESULT_WAIT_MS;
  const waiting = new Map(dispatched);
  // When each device was first seen reporting "restart pending".
  const restartSince = new Map<string, number>();
  for (;;) {
    try {
      const plan = await deps.plan();
      const rows = new Map(plan.devices.map((d) => [d.id, d]));
      for (const [id, name] of waiting) {
        const row = rows.get(id);
        if (!row) continue;
        if (row.disposition.kind === "current") {
          summary.updated.push(name);
          deps.log(`  ${name}: updated`);
          waiting.delete(id);
        } else if (row.updateState === "restart-pending") {
          const since = restartSince.get(id) ?? deps.now();
          restartSince.set(id, since);
          if (deps.now() - since >= RESTART_GRACE_MS) {
            summary.restartPending.push(name);
            deps.log(`  ${name}: restart pending — ${row.updateDetail ?? "restart it to finish"}`);
            waiting.delete(id);
          }
        } else if (row.updateState && TERMINAL_FAILURE_STATES.has(row.updateState)) {
          const detail = row.updateDetail ?? row.updateState;
          summary.failed.push({ name, detail });
          deps.log(`  ${name}: ${row.updateState} — ${detail}`);
          waiting.delete(id);
        }
      }
    } catch {
      // Transient: the gateway answered moments ago. Poll again.
    }
    if (waiting.size === 0) return;
    const remaining = deadline - deps.now();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(RESULT_POLL_MS, remaining));
  }
  for (const name of waiting.values()) {
    summary.unanswered.push(name);
    deps.log(`  ${name}: no result after ${Math.round(RESULT_WAIT_MS / 60_000)} minutes`);
  }
}

/** What the gateway looked like before the host update touched it. */
interface PreUpdateSnapshot {
  servedVersion: string;
  /** Daemons holding a live connection, by id. */
  online: Map<string, string>;
}

/**
 * Collectors and agent plugins are the daemons a restart disconnects and that
 * reconnect on their own. Phones and browsers reconnect when their app is
 * next in use, so waiting for them would only stall the run.
 */
function isDaemon(device: FleetUpdateEntry): boolean {
  return device.kind === "collector" || device.kind === "agent";
}

/**
 * Read the served version and the connected daemons while the old build is
 * still answering. Null when either read fails — a gateway that is down, or
 * one too old to serve the plan — in which case nothing is waited for.
 */
async function snapshotBeforeUpdate(deps: FleetUpdateDeps): Promise<PreUpdateSnapshot | null> {
  try {
    const servedVersion = await deps.servedVersion();
    const plan = await (deps.connectedPlan ?? deps.plan)();
    const online = new Map(
      plan.devices.filter((d) => d.online && isDaemon(d)).map((d) => [d.id, d.name]),
    );
    return { servedVersion, online };
  } catch {
    return null;
  }
}

/**
 * Poll the plan until every device in `expected` is online again or the
 * bound elapses. A device that has left the plan is no longer waited for. A
 * plan read that fails mid-wait is retried on the next poll.
 */
async function awaitReconnect(deps: FleetUpdateDeps, expected: Map<string, string>): Promise<void> {
  const count = expected.size;
  deps.log(
    `Waiting for ${count} ${count === 1 ? "device" : "devices"} to reconnect after the gateway restart…`,
  );
  const deadline = deps.now() + RECONNECT_WAIT_MS;
  let missing = [...expected.keys()];
  for (;;) {
    try {
      const plan = await deps.plan();
      const rows = new Map(plan.devices.map((d) => [d.id, d]));
      missing = missing.filter((id) => {
        const row = rows.get(id);
        return row !== undefined && !row.online;
      });
    } catch {
      // The gateway answered /health moments ago; a transient failure here
      // leaves `missing` as it was and the next poll tries again.
    }
    if (missing.length === 0) return;
    const remaining = deadline - deps.now();
    if (remaining <= 0) break;
    await deps.sleep(Math.min(RECONNECT_POLL_MS, remaining));
  }
  deps.log(
    `Not reconnected after ${Math.round(RECONNECT_WAIT_MS / 1_000)}s: ${missing
      .map((id) => expected.get(id))
      .join(", ")}.`,
  );
}

/**
 * Run the fleet update. Resolves with how every commanded device ended up;
 * throws `FleetUpdateRefused` when the gateway is not yet serving the build
 * the fleet would be sent to.
 */
export async function runFleetUpdate(deps: FleetUpdateDeps): Promise<FleetUpdateSummary> {
  const summary: FleetUpdateSummary = {
    updated: [],
    restartPending: [],
    failed: [],
    pending: [],
    unanswered: [],
  };
  const before = await snapshotBeforeUpdate(deps);

  await deps.updateHost();

  const served = await deps.servedVersion();
  const expected = deps.hostVersion();
  if (expected && served !== expected) {
    throw new FleetUpdateRefused(
      `This host is on ${expected} but its gateway is still serving ${served}. ` +
        `Restart the gateway, then run \`omnesis update --fleet\` again — a device must never ` +
        `be updated past the gateway that serves it.`,
    );
  }
  const expectedCommit = deps.hostCommit?.() ?? null;
  // A served version that changed is a gateway that restarted, and with it
  // every connection the snapshot saw. An exact-commit update restarts the
  // gateway too while usually keeping its version, so it is waited for as
  // well; planning at once would find every daemon offline and park them all.
  if (
    before &&
    (before.servedVersion !== served || expectedCommit !== null) &&
    before.online.size > 0
  ) {
    await awaitReconnect(deps, before.online);
  }

  const plan = await deps.plan();
  if (expectedCommit ? plan.targetCommit !== expectedCommit : plan.targetVersion !== served) {
    throw new FleetUpdateRefused(
      `The gateway's fleet plan does not match the running target. ` + `Restart it and try again.`,
    );
  }

  const targetLabel = plan.targetCommit
    ? `commit ${plan.targetCommit.slice(0, 12)}`
    : plan.targetVersion;

  const behind = plan.devices.filter((d) => d.disposition.kind === "update");
  const refused = plan.devices.flatMap((d) =>
    d.disposition.kind === "refused"
      ? [{ name: d.name, kind: d.kind, reason: d.disposition.reason }]
      : [],
  );

  deps.log(`Gateway is serving ${served}. Fleet target: ${targetLabel}.`);
  if (behind.length === 0) {
    deps.log("No device needs updating.");
  }
  for (const device of behind) {
    deps.log(
      `  ${device.name} (${device.kind}): ${device.version ?? "unknown"} → ${targetLabel}${device.online ? "" : " — offline, sent on reconnect"}`,
    );
  }
  // Named, not silently dropped. A device the gateway will not command is one
  // the operator has to update themselves, and this is where they learn it.
  for (const device of refused) {
    deps.log(`  ${device.name} (${device.kind}): not commanded — ${device.reason}`);
  }

  const approved: string[] = [];
  for (const device of behind) {
    if (
      await deps.approve(
        `Tell ${device.name} to update itself from ${device.version ?? "unknown"} to ${targetLabel}?`,
      )
    ) {
      approved.push(device.id);
    } else {
      deps.log(`  Skipped ${device.name}.`);
    }
  }
  if (approved.length === 0) return summary;

  const dispatched = new Map<string, string>();
  for (const outcome of await deps.command(approved)) {
    deps.log(`  ${outcome.name}: ${outcome.state}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
    if (outcome.state === "dispatched") dispatched.set(outcome.id, outcome.name);
    else if (outcome.state === "current") summary.updated.push(outcome.name);
    else if (outcome.state === "pending") summary.pending.push(outcome.name);
    else summary.failed.push({ name: outcome.name, detail: outcome.detail ?? outcome.state });
  }
  await awaitResults(deps, dispatched, summary);
  return summary;
}
