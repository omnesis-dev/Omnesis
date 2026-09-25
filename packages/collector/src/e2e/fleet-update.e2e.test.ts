// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fleet update E2E.
 *
 * Pseudo-collectors pair against one real gateway and answer `device.update`
 * with the collector's **production** handler — only the updater itself is
 * replaced, by the recording port, so no git remote or build is involved.
 * Everything else on the path is the shipped code: the admin route, the
 * disposition rules, the socket command, the acknowledgement, the result
 * event, the persisted request, and the reconnect that closes the loop.
 *
 * What this proves that a unit test cannot:
 *
 *   - The command reaches the device the operator named and no other.
 *   - A device that was offline when the operator asked keeps the desired
 *     version on its row and takes the command on its next connection.
 *   - The two safety refusals hold at the HTTP boundary, not merely in the
 *     pure function: a device of unknown version, and one below the floor,
 *     are never contacted.
 *   - A result — success or failure — comes back over the socket and lands
 *     on the device's row.
 *   - A reconnect announcing the new version flips the row to `current` and
 *     clears what was owed.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MINIMUM_CLIENT_VERSIONS, compareProductVersions } from "@omnesis/core";
import {
  MultiCollectorHarness,
  sleep,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

/** Old enough to be behind the gateway, new enough to still be supported. */
const BEHIND_VERSION = MINIMUM_CLIENT_VERSIONS.collector;
/** Below any plausible floor. */
const UNSUPPORTED_VERSION = "0.0.1";

interface FleetEntry {
  id: string;
  name: string;
  kind: string;
  version: string | null;
  online: boolean;
  disposition: { kind: string; code?: string; reason?: string };
  desiredVersion: string | null;
  updateState: string | null;
  updateDetail: string | null;
}

interface FleetPlan {
  targetVersion: string;
  devices: FleetEntry[];
}

interface FleetOutcome {
  id: string;
  name: string;
  state: string;
  detail?: string;
}

describe("fleet update (gateway → collector)", () => {
  let harness: MultiCollectorHarness;
  let gatewayVersion = "";

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    gatewayVersion = (await harness.json<{ version: string }>("/health")).version;
    // The bands this suite asserts only exist while the floor sits strictly
    // below the running release; assert the precondition rather than let a
    // raised floor turn the suite into a tautology.
    expect(compareProductVersions(BEHIND_VERSION, gatewayVersion)).toBeLessThan(0);
    expect(compareProductVersions(UNSUPPORTED_VERSION, BEHIND_VERSION)).toBeLessThan(0);
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  const plan = (): Promise<FleetPlan> => harness.json<FleetPlan>("/admin/fleet/update");

  const entryFor = async (collector: PairedCollector): Promise<FleetEntry> => {
    const found = (await plan()).devices.find((d) => d.id === collector.deviceId);
    if (!found) throw new Error(`${collector.name} is not in the fleet plan`);
    return found;
  };

  const command = async (ids?: string[]): Promise<FleetOutcome[]> =>
    (
      await harness.json<{ devices: FleetOutcome[] }>("/admin/fleet/update", {
        method: "POST",
        body: JSON.stringify(ids ? { deviceIds: ids } : {}),
      })
    ).devices;

  test("the plan targets the gateway's own version, never a chosen one", async () => {
    expect((await plan()).targetVersion).toBe(gatewayVersion);
  });

  test("a behind collector is commanded, runs its updater, and reports back", async () => {
    const collector = await harness.addCollector({
      name: "fleet-behind",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    expect(await entryFor(collector)).toMatchObject({
      version: BEHIND_VERSION,
      online: true,
      disposition: { kind: "update" },
    });

    const [outcome] = await command([collector.deviceId]);
    expect(outcome).toMatchObject({ state: "dispatched" });
    // The gateway named the version, and the version is all that crossed.
    expect(collector.updater.calls).toEqual([gatewayVersion]);
    expect(collector.receivedCommands.filter((c) => c.type === "device.update")).toEqual([
      { type: "device.update", payload: { version: gatewayVersion } },
    ]);
    // The production handler hands the process over to its supervisor.
    expect(collector.handedOver).toBe(true);

    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "the update result to land on the device row",
    );
    const row = await entryFor(collector);
    // Installed but not yet seen on the new build: the version is still owed
    // until the device's own hello proves it restarted into it.
    expect(row.desiredVersion).toBe(gatewayVersion);
  });

  test("a reconnect announcing the new version closes the request out", async () => {
    const collector = await harness.addCollector({
      name: "fleet-reconnect",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    await command([collector.deviceId]);
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "the update result",
    );

    // What a real collector does after its supervisor restarts it: come back
    // announcing the build it now runs.
    await harness.reannounceCollector(collector, {
      ...collector.capabilities,
      version: gatewayVersion,
    });

    await waitForCondition(
      async () => (await entryFor(collector)).desiredVersion === null,
      10_000,
      "the desired version to be cleared",
    );
    const row = await entryFor(collector);
    expect(row.version).toBe(gatewayVersion);
    expect(row.disposition.kind).toBe("current");
    // The device list is served from the admin status cache, which refreshes
    // on its own two-second tick and is not bumped by a hello — so this is a
    // wait, not an immediate read.
    const versionState = async (): Promise<string | undefined> =>
      (
        await harness.json<{ items: Array<{ id: string; versionState: string }> }>("/admin/devices")
      ).items.find((d) => d.id === collector.deviceId)?.versionState;
    await waitForCondition(
      async () => (await versionState()) === "current",
      10_000,
      "the device list to read the new version as current",
    );
  });

  test("an offline device holds the desired version and takes it on reconnect", async () => {
    const collector = await harness.addCollector({
      name: "fleet-offline",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    await harness.disconnectCollector(collector);

    const [outcome] = await command([collector.deviceId]);
    expect(outcome).toMatchObject({ state: "pending" });
    expect(collector.updater.calls).toEqual([]);
    expect(await entryFor(collector)).toMatchObject({
      desiredVersion: gatewayVersion,
      updateState: "pending",
      online: false,
    });

    await harness.reconnectCollector(collector);
    await waitForCondition(
      () => collector.updater.calls.length > 0,
      10_000,
      "the parked update to be delivered on reconnect",
    );
    expect(collector.updater.calls).toEqual([gatewayVersion]);
  });

  test("a device of unknown version is refused and never contacted", async () => {
    // A client built before the version ledger reports nothing. The gateway
    // would be telling a build it knows nothing about to replace itself.
    const collector = await harness.addCollector({
      name: "fleet-unknown",
      hostableSourceTypes: [],
    });
    const entry = await entryFor(collector);
    expect(entry.version).toBeNull();
    expect(entry.disposition).toMatchObject({ kind: "refused", code: "version-unknown" });

    const [outcome] = await command([collector.deviceId]);
    expect(outcome).toMatchObject({ state: "refused" });
    expect(outcome.detail).toContain("omnesis update");
    expect(collector.updater.calls).toEqual([]);
    expect(await entryFor(collector)).toMatchObject({ desiredVersion: null, updateState: null });
  });

  test("a device below the supported floor is refused and never contacted", async () => {
    const collector = await harness.addCollector({
      name: "fleet-unsupported",
      hostableSourceTypes: [],
      version: UNSUPPORTED_VERSION,
    });
    expect(await entryFor(collector)).toMatchObject({
      disposition: { kind: "refused", code: "version-unsupported" },
    });

    const [outcome] = await command([collector.deviceId]);
    expect(outcome).toMatchObject({ state: "refused" });
    expect(collector.updater.calls).toEqual([]);
  });

  test("a collector without the command is recorded as unsupported, not offered again, and cleared by a new build", async () => {
    const collector = await harness.addCollector({
      name: "fleet-no-command",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
      selfUpdate: false,
    });
    expect((await entryFor(collector)).disposition).toMatchObject({ kind: "update" });

    const [outcome] = await command([collector.deviceId]);
    expect(outcome).toMatchObject({ state: "unsupported" });
    expect(outcome?.detail).toContain("cannot be updated remotely");
    expect(await entryFor(collector)).toMatchObject({
      updateState: "unsupported",
      desiredVersion: gatewayVersion,
      disposition: { kind: "refused", code: "command-unsupported" },
    });
    const sentUpdates = () =>
      collector.receivedCommands.filter((c) => c.type === "device.update").length;
    expect(sentUpdates()).toBe(1);

    // Neither "update all" nor a reconnect on the same build asks it again.
    const all = await command();
    expect(all.find((o) => o.id === collector.deviceId)).toBeUndefined();
    await harness.reannounceCollector(collector, collector.capabilities);
    expect((await entryFor(collector)).updateState).toBe("unsupported");
    expect(sentUpdates()).toBe(1);

    // The device list carries the same verdict the plan does. It serves the
    // gateway's status cache, which refreshes on a short tick, so it is
    // polled rather than read once.
    type DeviceRow = {
      id: string;
      updateState: string | null;
      updateDisposition: { code?: string };
    };
    const listed = async (): Promise<DeviceRow | undefined> =>
      (await harness.json<{ items: DeviceRow[] }>("/admin/devices")).items.find(
        (d) => d.id === collector.deviceId,
      );
    await waitForCondition(
      async () => (await listed())?.updateState === "unsupported",
      10_000,
      "the device list to carry the unsupported record",
    );
    expect(await listed()).toMatchObject({
      updateState: "unsupported",
      updateDisposition: { code: "command-unsupported" },
    });

    // Updated by hand, it reports another build, and the record clears with
    // the same hello rather than lingering as a notice.
    await harness.reannounceCollector(collector, {
      ...collector.capabilities,
      version: gatewayVersion,
    });
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === null,
      10_000,
      "a new build to clear the unsupported record",
    );
    expect(await entryFor(collector)).toMatchObject({
      desiredVersion: null,
      disposition: { kind: "current" },
    });
    expect(sentUpdates()).toBe(1);
  });

  test("a failed update clears after an independent upgrade without retrying", async () => {
    const collector = await harness.addCollector({
      name: "fleet-failure",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    collector.updater.answer = {
      state: "failed",
      detail: "No release exists on this installation's remote.",
    };

    await command([collector.deviceId]);
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "failed",
      10_000,
      "the failure to land on the device row",
    );
    const row = await entryFor(collector);
    expect(row.updateDetail).toContain("No release exists");
    expect(row.desiredVersion).toBe(gatewayVersion);
    expect(collector.handedOver).toBe(false);
    await harness.reannounceCollector(collector, collector.capabilities);
    expect((await entryFor(collector)).updateState).toBe("failed");
    expect(collector.updater.calls).toHaveLength(1);
    await harness.reannounceCollector(collector, {
      ...collector.capabilities,
      version: gatewayVersion,
    });
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "independent recovery to clear the failed update",
    );
    expect((await entryFor(collector)).desiredVersion).toBeNull();
    expect(collector.updater.calls).toHaveLength(1);
  });

  test("a harness-style restart-pending result is recorded with the command it owes", async () => {
    const collector = await harness.addCollector({
      name: "fleet-restart-pending",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    collector.updater.answer = {
      state: "restart-pending",
      detail: "Installed; restart the harness to load it: openclaw gateway restart",
    };

    await command([collector.deviceId]);
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "restart-pending",
      10_000,
      "the restart-pending result",
    );
    const row = await entryFor(collector);
    expect(row.updateDetail).toContain("openclaw gateway restart");
    expect(row.desiredVersion).toBe(gatewayVersion);
    await harness.reannounceCollector(collector, {
      ...collector.capabilities,
      version: gatewayVersion,
    });
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "the manual restart to clear its notice",
    );
    expect((await entryFor(collector)).desiredVersion).toBeNull();
  });

  test("a host reports a harness plugin refresh as the device itself, and the next hello on that version clears it", async () => {
    const collector = await harness.addCollector({
      name: "fleet-local-refresh",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    const report = (body: unknown, token?: string) =>
      fetch(`${harness.gatewayUrl}/devices/update-result`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const result = {
      version: gatewayVersion,
      state: "restart-pending",
      detail: "Plugin installed; restart owed: openclaw gateway restart",
    };
    // The report is the device's own: no token, no write.
    expect((await report(result)).status).toBe(401);

    const accepted = await report(result, collector.token);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ recorded: true });
    const row = await entryFor(collector);
    expect(row.updateState).toBe("restart-pending");
    expect(row.desiredVersion).toBe(gatewayVersion);
    expect(row.updateDetail).toContain("openclaw gateway restart");

    // The doctor carries it, with the command, until the device is back on the build.
    const doctorCheck = async (id: string) =>
      (
        await harness.json<{ checks: Array<{ id: string; status: string; hint?: string }> }>(
          "/admin/doctor",
        )
      ).checks.find((check) => check.id === id);
    // The doctor reads the device roster through the status cache, which
    // refreshes on its own tick, so the notice follows the write by a moment.
    await waitForCondition(
      async () => (await doctorCheck("fleet.restart-pending"))?.status === "warn",
      10_000,
      "the doctor to carry the restart owed",
    );
    expect((await doctorCheck("fleet.restart-pending"))?.hint).toContain(
      "openclaw gateway restart",
    );

    // A hello on the old build is not recovery.
    await harness.reannounceCollector(collector, {
      ...collector.capabilities,
      version: BEHIND_VERSION,
    });
    expect((await entryFor(collector)).updateState).toBe("restart-pending");

    await harness.reannounceCollector(collector, {
      ...collector.capabilities,
      version: gatewayVersion,
    });
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "the hello on the installed version to clear the notice",
    );
    expect((await entryFor(collector)).desiredVersion).toBeNull();
    await waitForCondition(
      async () => (await doctorCheck("fleet.restart-pending")) === undefined,
      10_000,
      "the doctor to drop the notice",
    );
  });

  test("`update all` commands only the devices that are behind and commandable", async () => {
    const behind = await harness.addCollector({
      name: "fleet-all-behind",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    const current = await harness.addCollector({
      name: "fleet-all-current",
      hostableSourceTypes: [],
      version: gatewayVersion,
    });
    const unknown = await harness.addCollector({
      name: "fleet-all-unknown",
      hostableSourceTypes: [],
    });

    // The fan-out is exactly what the plan calls commandable-and-behind —
    // asserted as a set, because earlier tests left devices in this gateway
    // and an extra one in the fan-out is the failure this guards against.
    const expected = new Set(
      (await plan()).devices.filter((d) => d.disposition.kind === "update").map((d) => d.id),
    );
    expect(expected.has(behind.deviceId)).toBe(true);
    const outcomes = await command();
    expect(new Set(outcomes.map((o) => o.id))).toEqual(expected);

    const byId = new Map(outcomes.map((o) => [o.id, o]));
    expect(byId.get(behind.deviceId)?.state).toBe("dispatched");
    // Neither a current device nor an unknown one is in the fan-out at all.
    expect(byId.has(current.deviceId)).toBe(false);
    expect(byId.has(unknown.deviceId)).toBe(false);
    expect(current.updater.calls).toEqual([]);
    expect(unknown.updater.calls).toEqual([]);
  }, 60_000);

  test("an id for a device already on the target is answered without contacting it", async () => {
    // A stale page can name a device that has since updated. The gateway
    // re-derives the disposition rather than trusting the caller's list, so
    // nothing is sent and nothing is reinstalled.
    const collector = await harness.addCollector({
      name: "fleet-already-current",
      hostableSourceTypes: [],
      version: gatewayVersion,
    });
    const [outcome] = await command([collector.deviceId]);
    expect(outcome).toMatchObject({ state: "current" });
    expect(collector.updater.calls).toEqual([]);
  });

  test("a reconnect for an unrelated reason does not start a second update", async () => {
    // The guard this reddens: a device whose update already ran reconnects
    // (a network blip, a restart) still announcing the old build. Without it
    // every such reconnect starts another update over the first.
    const collector = await harness.addCollector({
      name: "fleet-no-second-update",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    await command([collector.deviceId]);
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "the update result",
    );

    // Back on the same build — a supervisor restart the update did not cause.
    await harness.disconnectCollector(collector);
    await harness.reconnectCollector(collector);
    await sleep(500);
    expect(collector.updater.calls).toEqual([gatewayVersion]);
  }, 60_000);

  test("a device that is already updating refuses a second command", async () => {
    // Two `npm ci` runs in one checkout corrupt each other. The device's own
    // refusal is the last line of defence, and the gateway records it.
    const collector = await harness.addCollector({
      name: "fleet-concurrent",
      hostableSourceTypes: [],
      version: BEHIND_VERSION,
    });
    // Hold the first update open so a second command meets one in flight.
    let release = (): void => {};
    collector.updater.run = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { state: "installed" };
    };

    const first = command([collector.deviceId]);
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "dispatched",
      10_000,
      "the first command to be claimed",
    );
    // A second request while the first is in flight is refused by the
    // gateway's own claim, without reaching the device again.
    const [second] = await command([collector.deviceId]);
    expect(second).toMatchObject({ state: "dispatched" });
    expect(second.detail).toContain("already under way");

    release();
    await first;
    await waitForCondition(
      async () => (await entryFor(collector)).updateState === "installed",
      10_000,
      "the held update to finish",
    );
  }, 60_000);
});
