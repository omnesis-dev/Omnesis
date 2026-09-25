// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The fleet update's state machine, driven deterministically.
 *
 * The E2E proves the whole path end to end but cannot interleave two writers
 * on purpose; the orderings that lose state are all here — two operators
 * pressing the same button, a device that reports before its acknowledgement
 * lands, a device that comes back without the build it was told to take, and
 * a device reporting a result nobody asked for.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  getDevice,
  revokeDevice,
  setDeviceUpdateRequest,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { FleetUpdateService } from "./FleetUpdateService.js";
import type { DeviceWsServer } from "../../ws.js";
import type { DeviceId, DeviceKind } from "@omnesis/types";

const TARGET = "9.9.2";
const BEHIND = "9.9.0";
const COMMIT = "a".repeat(40);

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-fleet-update-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

/** A socket server double: records commands and answers from a script. */
function fakeWs(
  answer: (deviceId: string) => Promise<{ accepted: boolean; reason?: string }>,
  online: boolean | ((deviceId: string) => boolean) = true,
): { server: DeviceWsServer; sent: string[]; commands: unknown[] } {
  const sent: string[] = [];
  const commands: unknown[] = [];
  const server = {
    isConnected: (deviceId: string) => (typeof online === "function" ? online(deviceId) : online),
    sendCommand: async (deviceId: string, _type: string, payload: unknown) => {
      sent.push(deviceId);
      commands.push(payload);
      return answer(deviceId);
    },
  } as unknown as DeviceWsServer;
  return { server, sent, commands };
}

function pair(name: string, kind: DeviceKind = "collector", version = BEHIND): DeviceId {
  const device = createDevice(db, { name, kind });
  updateDeviceCapabilities(db, device.id, { version }, 1);
  return device.id;
}

function service(
  ws?: DeviceWsServer,
  writeGate: WriteGate = directWriteGate(db),
  sourceCommit: string | null = COMMIT,
): FleetUpdateService {
  return new FleetUpdateService({
    db,
    writeGate,
    wsServer: () => ws,
    targetVersion: TARGET,
    sourceCommit,
  });
}

const rowOf = (id: DeviceId): ReturnType<typeof getDevice> => getDevice(db, id);

describe("the plan", () => {
  test("names the gateway's own version and one disposition per device", () => {
    const behind = pair("behind-collector");
    const current = pair("current-collector", "collector", TARGET);
    const phone = pair("a-phone", "ios");
    const plan = service().plan();

    expect(plan.targetVersion).toBe(TARGET);
    const byId = new Map(plan.devices.map((d) => [d.id, d.disposition]));
    expect(byId.get(behind)).toEqual({ kind: "update" });
    expect(byId.get(current)).toEqual({ kind: "current" });
    expect(byId.get(phone)).toMatchObject({ kind: "refused", code: "store-managed" });
  });

  test("can preview dispositions against a confirmed future gateway version", () => {
    const current = pair("current-collector", "collector", TARGET);
    const plan = service().plan("9.9.3");

    expect(plan.targetVersion).toBe("9.9.3");
    expect(plan.devices.find((device) => device.id === current)?.disposition).toEqual({
      kind: "update",
    });
  });

  test("an exact-commit plan selects only verified source daemons not already on it", () => {
    const behind = pair("source-collector");
    const current = pair("current-source");
    const packaged = pair("package-collector");
    updateDeviceCapabilities(db, behind, { version: BEHIND, sourceCommit: "b".repeat(40) }, 1);
    updateDeviceCapabilities(db, current, { version: BEHIND, sourceCommit: COMMIT }, 1);

    const plan = service().planCommit(COMMIT);

    expect(plan).toMatchObject({ targetVersion: TARGET, targetCommit: COMMIT });
    const byId = new Map(plan.devices.map((device) => [device.id, device.disposition]));
    expect(byId.get(behind)).toEqual({ kind: "update" });
    expect(byId.get(current)).toEqual({ kind: "current" });
    expect(byId.get(packaged)).toMatchObject({ kind: "refused" });
  });

  test("refuses to plan a commit other than the running gateway checkout", () => {
    expect(() =>
      service(undefined, directWriteGate(db), "b".repeat(40)).planCommit(COMMIT),
    ).toThrow(/running gateway is on commit/i);
    expect(() => service(undefined, directWriteGate(db), null).planCommit(COMMIT)).toThrow(
      /cannot attest an installer-managed source commit/i,
    );
  });
});

describe("requesting an update", () => {
  test("a behind device is claimed, commanded, and left reading dispatched", async () => {
    const id = pair("behind-collector");
    const { server, sent } = fakeWs(async () => ({ accepted: true }));
    const outcomes = await service(server).request([id]);

    expect(outcomes).toEqual([{ id, name: "behind-collector", state: "dispatched" }]);
    expect(sent).toEqual([id]);
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "dispatched" });
  });

  test("an exact commit is dispatched and persisted as a distinct target", async () => {
    const id = pair("source-collector");
    updateDeviceCapabilities(db, id, { version: BEHIND, sourceCommit: "b".repeat(40) }, 1);
    const { server, commands } = fakeWs(async () => ({ accepted: true }));

    const outcomes = await service(server).request([id], { kind: "commit", commit: COMMIT });

    expect(outcomes).toEqual([{ id, name: "source-collector", state: "dispatched" }]);
    expect(commands).toEqual([{ commit: COMMIT }]);
    expect(rowOf(id)).toMatchObject({
      desiredVersion: `commit:${COMMIT}`,
      updateState: "dispatched",
    });
  });

  test("the operator's rewind permission is sent with the command, and only when given", async () => {
    const id = pair("rewind-collector");
    const { server, commands } = fakeWs(async () => ({ accepted: true }));

    await service(server).request(
      [id],
      { kind: "release", version: TARGET },
      { allowRewind: true },
    );
    expect(commands).toEqual([{ version: TARGET, allowRewind: true }]);
    // Persisted like any release target: the permission is not stored.
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "dispatched" });
  });

  test("an ordinary command carries no rewind field for an older device's strict schema", async () => {
    const id = pair("ordinary-collector");
    const { server, commands } = fakeWs(async () => ({ accepted: true }));
    await service(server).request([id]);
    expect(commands).toEqual([{ version: TARGET }]);
  });

  test("an offline device is parked and never contacted", async () => {
    const id = pair("offline-collector");
    const { server, sent } = fakeWs(async () => ({ accepted: true }), false);
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "pending" });
    expect(sent).toEqual([]);
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "pending" });
  });

  test("a device that reconnects while earlier devices are being commanded is sent the update", async () => {
    // After a gateway restart the fleet update starts while devices are still
    // reconnecting, and each acknowledgement is awaited in turn. A device
    // offline when the request began but back by its turn is commanded, not
    // parked for a reconnect that already happened.
    const first = pair("first-collector");
    const late = pair("late-agent", "agent");
    const connected = new Set<string>([first]);
    const { server, sent } = fakeWs(
      async (deviceId) => {
        if (deviceId === first) connected.add(late);
        return { accepted: true };
      },
      (deviceId) => connected.has(deviceId),
    );
    const outcomes = await service(server).request([first, late]);

    expect(outcomes.map((o) => o.state)).toEqual(["dispatched", "dispatched"]);
    expect(sent).toEqual([first, late]);
    expect(rowOf(late)).toMatchObject({ desiredVersion: TARGET, updateState: "dispatched" });
  });

  test("a device whose hello completes while its update is being parked is sent it once", async () => {
    // The hello looked for a parked request before the park was written, so
    // nothing but the request itself can deliver it until the next reconnect.
    const id = pair("harness", "agent");
    // Connected from the moment the park is written.
    const { server, sent } = fakeWs(
      async () => ({ accepted: true }),
      () => rowOf(id)?.updateState != null,
    );
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "dispatched" });
    expect(sent).toEqual([id]);
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "dispatched" });
  });

  test("a device that came back on the target while the request ran is not commanded", async () => {
    const first = pair("first-collector");
    const late = pair("late-agent", "agent");
    const { server, sent } = fakeWs(async (deviceId) => {
      if (deviceId === first) {
        updateDeviceCapabilities(db, late, { version: TARGET }, 1);
      }
      return { accepted: true };
    });
    const outcomes = await service(server).request([first, late]);

    expect(outcomes.map((o) => o.state)).toEqual(["dispatched", "current"]);
    expect(sent).toEqual([first]);
    expect(rowOf(late)?.updateState).toBeNull();
  });

  test("a device whose hello on the target completes while it is being parked is settled installed", async () => {
    const id = pair("harness", "agent");
    const { server, sent } = fakeWs(
      async () => ({ accepted: true }),
      () => {
        if (rowOf(id)?.updateState == null) return false;
        updateDeviceCapabilities(db, id, { version: TARGET }, 1);
        return true;
      },
    );
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "installed" });
    expect(sent).toEqual([]);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
  });

  test("a refusal is re-derived server-side, whatever id the caller sent", async () => {
    // The caller's list may come from a page minutes old, and the refusals
    // are safety rules rather than UI hints.
    const phone = pair("a-phone", "ios");
    const unknown = createDevice(db, { name: "no-version", kind: "collector" }).id;
    const { server, sent } = fakeWs(async () => ({ accepted: true }));
    const outcomes = await service(server).request([phone, unknown]);

    expect(outcomes.map((o) => o.state)).toEqual(["refused", "refused"]);
    expect(sent).toEqual([]);
    expect(rowOf(phone)).toMatchObject({ desiredVersion: null, updateState: null });
    expect(rowOf(unknown)).toMatchObject({ desiredVersion: null, updateState: null });
  });

  test("with no ids, only the devices that are behind and commandable are asked", async () => {
    const behind = pair("behind-collector");
    pair("current-collector", "collector", TARGET);
    pair("a-phone", "ios");
    const { server, sent } = fakeWs(async () => ({ accepted: true }));

    const outcomes = await service(server).request();
    expect(outcomes.map((o) => o.id)).toEqual([behind]);
    expect(sent).toEqual([behind]);
  });

  test("two overlapping requests command the device once", async () => {
    // Two operators pressing "Update all", or one pressing it twice. The
    // second must not rewind a row already claimed by the first.
    const id = pair("behind-collector");
    // A gate the test opens, so the second request is observed while the
    // first is still in flight.
    const gate = Promise.withResolvers<void>();
    const { server, sent } = fakeWs(async () => {
      await gate.promise;
      return { accepted: true };
    });
    const svc = service(server);

    const first = svc.request([id]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await svc.request([id]);
    expect(second[0]).toMatchObject({ state: "dispatched" });
    expect(second[0]?.detail).toContain("already under way");

    gate.resolve();
    await first;
    expect(sent).toEqual([id]);
  });

  test("a device that refuses is recorded as failed with its own reason", async () => {
    const id = pair("busy-collector");
    const { server } = fakeWs(async () => ({
      accepted: false,
      reason: "An update is already running on this host.",
    }));
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "failed" });
    expect(rowOf(id)).toMatchObject({
      desiredVersion: TARGET,
      updateState: "failed",
      updateDetail: "An update is already running on this host.",
    });
  });

  test("a client that does not implement the command is recorded as unsupported, not failed", async () => {
    // Parking it would re-send the command on every reconnect, forever; and
    // nothing failed — the build simply has to be updated on its own machine.
    const id = pair("older-agent", "agent");
    updateDeviceCapabilities(
      db,
      id,
      {
        version: BEHIND,
        agentIntegration: {
          harness: "hermes",
          deliveryProtocolMin: 1,
          deliveryProtocolMax: 1,
          maxConcurrentRuns: 1,
        },
      },
      1,
    );
    const { WsCommandError } = await import("../../ws.js");
    const { server, sent } = fakeWs(async () => {
      throw new WsCommandError("unsupported", "no handler for device.update");
    });
    const svc = service(server);
    const [outcome] = await svc.request([id]);

    expect(outcome).toMatchObject({ state: "unsupported" });
    expect(outcome?.detail).toContain("cannot be updated remotely");
    expect(outcome?.detail).toContain("`omnesis connect hermes --refresh`");
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "unsupported" });

    // The plan no longer offers it, "update all" skips it, and naming it is
    // answered without contacting the device.
    const entry = svc.plan().devices.find((d) => d.id === id);
    expect(entry?.disposition).toMatchObject({ kind: "refused", code: "command-unsupported" });
    expect(await svc.request()).toEqual([]);
    const [again] = await svc.request([id]);
    expect(again).toMatchObject({ state: "refused" });
    expect(sent).toEqual([id]);

    // A reconnect on the same build does not re-send it either.
    await svc.onDeviceConnected(id);
    expect(sent).toEqual([id]);
    expect(rowOf(id)?.updateState).toBe("unsupported");
  });

  test("an unsupported record is cleared once the device reports another build", async () => {
    const id = pair("older-collector");
    const { WsCommandError } = await import("../../ws.js");
    const { server } = fakeWs(async () => {
      throw new WsCommandError("unsupported", "no handler for device.update");
    });
    const svc = service(server);
    await svc.request([id]);
    expect(svc.plan().devices.find((d) => d.id === id)?.disposition.kind).toBe("refused");

    updateDeviceCapabilities(db, id, { version: "9.9.1" }, 1);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: null });
    expect(svc.plan().devices.find((d) => d.id === id)?.disposition).toEqual({ kind: "update" });
  });

  test("a collector built before the command answers its generic fallback, and that is unsupported too", async () => {
    const id = pair("early-collector");
    const { WsCommandError } = await import("../../ws.js");
    const { server } = fakeWs(async () => {
      throw new WsCommandError("handler_error", "Unknown command: device.update");
    });
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "unsupported" });
    expect(outcome?.detail).toContain("`omnesis update`");
    expect(outcome?.detail).not.toContain("--refresh");
    expect(rowOf(id)?.updateState).toBe("unsupported");
  });

  test("any other command error is a failure the device understood and rejected", async () => {
    const id = pair("strict-collector");
    const { WsCommandError } = await import("../../ws.js");
    const { server } = fakeWs(async () => {
      throw new WsCommandError("invalid_payload", "invalid update command");
    });
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "failed" });
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "failed" });
    expect(rowOf(id)?.updateDetail).toContain("invalid_payload");
  });

  test("a socket lost mid-send parks the request instead of failing it", async () => {
    const id = pair("flaky-collector");
    const { server } = fakeWs(async () => {
      throw new Error("device not connected");
    });
    const [outcome] = await service(server).request([id]);

    expect(outcome).toMatchObject({ state: "pending" });
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "pending" });
  });
});

describe("results reported by the device", () => {
  test("a commit request closes only after the reconnect attests that exact commit", async () => {
    const id = pair("source-collector");
    updateDeviceCapabilities(db, id, { version: BEHIND, sourceCommit: "b".repeat(40) }, 1);
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id], { kind: "commit", commit: COMMIT });
    await svc.recordResult(id, { commit: COMMIT, state: "installed" });

    updateDeviceCapabilities(db, id, { version: BEHIND, sourceCommit: "c".repeat(40) }, 1);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({
      desiredVersion: `commit:${COMMIT}`,
      updateState: "installed",
    });

    updateDeviceCapabilities(db, id, { version: BEHIND, sourceCommit: COMMIT }, 1);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
    expect(rowOf(id)?.updateDetail).toBe("Reconnected on commit aaaaaaaaaaaa.");
  });

  test("an installed result keeps the version owed until the device comes back on it", async () => {
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);

    await svc.recordResult(id, { version: TARGET, state: "installed", detail: "Installed." });
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "installed" });
  });

  test("a harness that installs, restarts itself and reconnects on the target closes the row", async () => {
    // The plugin's CLI records the refresh from the host first, the plugin
    // then reports installed and restarts the harness, and the new plugin's
    // hello is what clears the request — nothing owed is left behind.
    const id = pair("restarting-harness", "agent");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);

    await svc.recordLocalResult(id, {
      version: TARGET,
      state: "restart-pending",
      detail: "Plugin installed; restart owed: openclaw gateway restart",
    });
    await svc.recordResult(id, {
      version: TARGET,
      state: "installed",
      detail: "Installed; restarting openclaw now: openclaw gateway restart",
    });
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "installed" });

    updateDeviceCapabilities(db, id, { version: TARGET }, 1);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
    expect(rowOf(id)?.updateDetail).toBe(`Reconnected on ${TARGET}.`);
  });

  test.each(["restart-pending", "failed"] as const)(
    "a late %s result cannot reopen an update after the new client reports the target",
    async (state) => {
      const id = pair("restarted-harness", "agent");
      const { server } = fakeWs(async () => ({ accepted: true }));
      const svc = service(server);
      await svc.request([id]);
      await svc.recordResult(id, { version: TARGET, state: "installed" });

      // A reconnect hello persists the new running version before its hook
      // and the client's queued result is handled. Whichever handler reaches
      // the writer first must leave the same completed state.
      updateDeviceCapabilities(db, id, { version: TARGET }, 1);
      await svc.recordResult(id, { version: TARGET, state, detail: "Earlier attempt" });
      await svc.onDeviceConnected(id);

      expect(rowOf(id)).toMatchObject({
        desiredVersion: null,
        updateState: "installed",
        updateDetail: `Reconnected on ${TARGET}.`,
      });
    },
  );

  test("a reconnect settled first makes a later result harmless", async () => {
    const id = pair("restarted-harness", "agent");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    await svc.recordResult(id, { version: TARGET, state: "installed" });
    updateDeviceCapabilities(db, id, { version: TARGET }, 1);

    await svc.onDeviceConnected(id);
    await svc.recordResult(id, {
      version: TARGET,
      state: "restart-pending",
      detail: "Earlier attempt",
    });

    expect(rowOf(id)).toMatchObject({
      desiredVersion: null,
      updateState: "installed",
      updateDetail: `Reconnected on ${TARGET}.`,
    });
  });

  test.each(["result", "reconnect"] as const)(
    "the %s settlement cannot clear a request after another socket reports an older build",
    async (settlement) => {
      const id = pair("multi-socket-harness", "agent");
      const baseGate = directWriteGate(db);
      let interleaveOlderHello = false;
      const interleavedGate: WriteGate = {
        ...baseGate,
        setDeviceUpdateRequest: async (deviceId, request) => {
          if (interleaveOlderHello && request.desiredVersion === null) {
            interleaveOlderHello = false;
            updateDeviceCapabilities(db, id, { version: BEHIND }, 1);
          }
          return baseGate.setDeviceUpdateRequest(deviceId, request);
        },
      };
      const { server } = fakeWs(async () => ({ accepted: true }));
      const svc = service(server, interleavedGate);
      await svc.request([id]);
      await svc.recordResult(id, { version: TARGET, state: "installed" });
      updateDeviceCapabilities(db, id, { version: TARGET }, 1);
      interleaveOlderHello = true;

      if (settlement === "result") {
        await svc.recordResult(id, {
          version: TARGET,
          state: "restart-pending",
          detail: "Earlier attempt",
        });
      } else {
        await svc.onDeviceConnected(id);
      }

      expect(rowOf(id)).toMatchObject({
        version: BEHIND,
        desiredVersion: TARGET,
        updateState: "installed",
      });
    },
  );

  test("a result that arrives before the acknowledgement is not overwritten by it", async () => {
    // The device starts before it answers. An acknowledgement written
    // unconditionally would replace the outcome with older news.
    const id = pair("fast-collector");
    const svc = service();
    const { server } = fakeWs(async () => {
      await svc.recordResult(id, { version: TARGET, state: "installed" });
      return { accepted: true };
    });
    await service(server).request([id]);

    expect(rowOf(id)).toMatchObject({ updateState: "installed" });
  });

  test("a restart-pending result retains its target and carries the command", async () => {
    const id = pair("harness-plugin", "agent");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);

    await svc.recordResult(id, {
      version: TARGET,
      state: "restart-pending",
      detail: "Restart openclaw to load it: openclaw gateway restart",
    });
    // A manual restart can later confirm the target without another update.
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "restart-pending" });
    expect(rowOf(id)?.updateDetail).toContain("openclaw gateway restart");
  });

  test("a result nobody asked for writes nothing", async () => {
    // Any paired device can emit the event, including kinds this gateway
    // never commands, and the detail it carries is shown to the operator.
    const id = pair("a-phone", "ios");
    await service().recordResult(id, {
      version: TARGET,
      state: "failed",
      detail: "an unsolicited sentence",
    });
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: null });
  });

  test("a result for a version other than the one owed writes nothing", async () => {
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);

    await svc.recordResult(id, { version: "1.2.3", state: "failed", detail: "stale" });
    expect(rowOf(id)).toMatchObject({ updateState: "dispatched" });
  });

  test("a revoked device's result writes nothing", async () => {
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    revokeDevice(db, id);

    await svc.recordResult(id, { version: TARGET, state: "installed" });
    // Revoking cleared the request; a late result must not resurrect it.
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: null });
  });
});

describe("results a device's own host reports", () => {
  test("a local result is recorded without any outstanding request, and the version becomes owed", async () => {
    const id = pair("harness-host", "agent");
    const svc = service();
    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "restart-pending",
        detail: "Plugin installed; restart owed: openclaw gateway restart",
      }),
    ).toBe(true);
    const row = rowOf(id);
    expect(row?.updateState).toBe("restart-pending");
    expect(row?.desiredVersion).toBe(TARGET);
    expect(row?.updateDetail).toContain("openclaw gateway restart");
  });

  test("a later local result replaces the earlier one", async () => {
    const id = pair("harness-host", "agent");
    const svc = service();
    await svc.recordLocalResult(id, { version: TARGET, state: "failed", detail: "refresh failed" });
    await svc.recordLocalResult(id, {
      version: TARGET,
      state: "restart-pending",
      detail: "installed",
    });
    expect(rowOf(id)?.updateState).toBe("restart-pending");
  });

  test("the device's next hello on the reported version clears it; one on the old build leaves it", async () => {
    const id = pair("harness-host", "agent");
    const svc = service();
    await svc.recordLocalResult(id, { version: TARGET, state: "restart-pending", detail: "owed" });
    await svc.onDeviceConnected(id);
    expect(rowOf(id)?.updateState).toBe("restart-pending");
    updateDeviceCapabilities(db, id, { hostname: "openclaw", platform: "linux", version: TARGET });
    await svc.onDeviceConnected(id);
    expect(rowOf(id)?.updateState).toBe("installed");
    expect(rowOf(id)?.desiredVersion).toBeNull();
  });

  test("a later host run's restart-pending for a plugin already running that version writes nothing", async () => {
    const id = pair("harness-host", "agent");
    const svc = service();
    await svc.recordLocalResult(id, { version: TARGET, state: "restart-pending", detail: "owed" });
    updateDeviceCapabilities(db, id, { hostname: "openclaw", platform: "linux", version: TARGET });
    await svc.onDeviceConnected(id);
    expect(rowOf(id)?.updateState).toBe("installed");
    // Another update on the same host refreshes the plugin again after the
    // harness already restarted onto it.
    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "restart-pending",
        detail: "Plugin installed; restart owed: openclaw gateway restart",
      }),
    ).toBe(false);
    expect(rowOf(id)?.updateState).toBe("installed");
    expect(rowOf(id)?.desiredVersion).toBeNull();
    // A refresh that failed is still worth recording on the same version.
    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "failed",
        detail: "refresh failed",
      }),
    ).toBe(true);
    expect(rowOf(id)?.updateState).toBe("failed");
  });

  test("a local result does not displace a request this gateway has outstanding for another version", async () => {
    const id = pair("harness-host", "agent");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    expect(rowOf(id)?.updateState).toBe("dispatched");
    expect(
      await svc.recordLocalResult(id, { version: "1.2.3", state: "failed", detail: "unrelated" }),
    ).toBe(false);
    expect(rowOf(id)?.updateState).toBe("dispatched");
    expect(rowOf(id)?.desiredVersion).toBe(TARGET);
    // The commanded run's own host report for the same version is taken.
    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "restart-pending",
        detail: "owed",
      }),
    ).toBe(true);
    expect(rowOf(id)?.updateState).toBe("restart-pending");
  });

  test("a host's restart-pending leaves an update parked for the same version to be sent", async () => {
    // The harness host's own update refreshed the plugin while the harness was
    // disconnected. The parked command is what restarts the harness onto it,
    // so the host's report must not settle the row.
    const id = pair("harness-host", "agent");
    const offline = fakeWs(async () => ({ accepted: true }), false);
    const svc = service(offline.server);
    await svc.request([id]);
    expect(rowOf(id)?.updateState).toBe("pending");

    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "restart-pending",
        detail: "Plugin installed; restart owed: hermes gateway restart",
      }),
    ).toBe(false);
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "pending" });

    const online = fakeWs(async () => ({ accepted: true }));
    await service(online.server).onDeviceConnected(id);
    expect(online.sent).toEqual([id]);
    expect(rowOf(id)?.updateState).toBe("dispatched");
  });

  test("a host's restart-pending sends an update parked while its device is connected", async () => {
    // An acknowledgement that timed out parks the row with the socket still up,
    // and no hello follows to send it.
    const id = pair("harness-host", "agent");
    let answered = false;
    const { server, sent } = fakeWs(async () => {
      if (answered) return { accepted: true };
      answered = true;
      throw new Error("timed out waiting for the acknowledgement");
    });
    const svc = service(server);
    await svc.request([id]);
    expect(rowOf(id)?.updateState).toBe("pending");

    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "restart-pending",
        detail: "Plugin installed; restart owed: hermes gateway restart",
      }),
    ).toBe(false);
    expect(sent).toEqual([id, id]);
    expect(rowOf(id)?.updateState).toBe("dispatched");
  });

  test("a host's failed refresh still settles an update parked for the same version", async () => {
    const id = pair("harness-host", "agent");
    const offline = fakeWs(async () => ({ accepted: true }), false);
    const svc = service(offline.server);
    await svc.request([id]);
    expect(
      await svc.recordLocalResult(id, {
        version: TARGET,
        state: "failed",
        detail: "refresh failed",
      }),
    ).toBe(true);
    expect(rowOf(id)).toMatchObject({ updateState: "failed", updateDetail: "refresh failed" });
  });

  test("a refresh the host reported as failed is not upgraded by the commanded run's own clean exit", async () => {
    const id = pair("harness-host", "agent");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    await svc.recordLocalResult(id, { version: TARGET, state: "failed", detail: "refresh failed" });
    await svc.recordResult(id, { version: TARGET, state: "restart-pending", detail: "Installed" });
    expect(rowOf(id)?.updateState).toBe("failed");
    expect(rowOf(id)?.updateDetail).toBe("refresh failed");
    // A hello on the version is still what clears it.
    updateDeviceCapabilities(db, id, { hostname: "openclaw", platform: "linux", version: TARGET });
    await svc.onDeviceConnected(id);
    expect(rowOf(id)?.updateState).toBe("installed");
  });

  test("a revoked device's local result writes nothing", async () => {
    const id = pair("harness-host", "agent");
    revokeDevice(db, id);
    expect(
      await service().recordLocalResult(id, { version: TARGET, state: "failed", detail: "x" }),
    ).toBe(false);
    expect(rowOf(id)?.updateState).toBeNull();
  });
});

describe("what a reconnect settles", () => {
  test("a known target is not replaced by the gateway's current version", async () => {
    const id = pair("newer-target-collector", "collector", TARGET);
    setDeviceUpdateRequest(db, id, {
      desiredVersion: "9.9.3",
      state: "failed",
      detail: "The newer build did not install.",
    });
    await service().onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: "9.9.3", updateState: "failed" });
  });

  test("an independent upgrade beyond the target also clears the failure", async () => {
    const id = pair("newer-build-collector", "collector", "9.9.3");
    setDeviceUpdateRequest(db, id, { desiredVersion: TARGET, state: "failed" });
    await service().onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
  });

  test.each(["failed", "restart-pending"] as const)(
    "%s clears only after a hello proves the target, without retrying the command",
    async (state) => {
      const id = pair("recovering-agent", "agent");
      const { server, sent } = fakeWs(async () => ({ accepted: true }));
      const svc = service(server);
      await svc.request([id]);
      await svc.recordResult(id, { version: TARGET, state, detail: "Earlier attempt" });
      await svc.onDeviceConnected(id);
      expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: state });
      expect(sent).toEqual([id]);
      updateDeviceCapabilities(db, id, { version: TARGET }, 1);
      await svc.onDeviceConnected(id);
      expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
      expect(sent).toEqual([id]);
    },
  );

  test("a refused command clears after an independent upgrade", async () => {
    const id = pair("repaired-collector");
    const { server, sent } = fakeWs(async () => ({ accepted: false, reason: "Unmanaged" }));
    const svc = service(server);
    await svc.request([id]);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)?.updateState).toBe("failed");
    updateDeviceCapabilities(db, id, { version: TARGET }, 1);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
    expect(sent).toEqual([id]);
  });

  test.each(["failed", "restart-pending"] as const)(
    "a legacy %s result with no target clears only on a current build",
    async (state) => {
      const id = pair("legacy-agent", "agent");
      setDeviceUpdateRequest(db, id, { desiredVersion: null, state, detail: "Earlier attempt" });
      const { server, sent } = fakeWs(async () => ({ accepted: true }));
      const svc = service(server);
      await svc.onDeviceConnected(id);
      expect(rowOf(id)?.updateState).toBe(state);
      updateDeviceCapabilities(db, id, { version: TARGET }, 1);
      await svc.onDeviceConnected(id);
      expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
      expect(rowOf(id)?.updateDetail).toContain("Earlier attempt");
      expect(sent).toEqual([]);
    },
  );

  test("a device back on the target closes the request out", async () => {
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    await svc.recordResult(id, { version: TARGET, state: "installed" });

    updateDeviceCapabilities(db, id, { version: TARGET }, 1);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
  });

  test("a reconnect while the update is still running changes nothing", async () => {
    // The update is minutes of `npm ci` and a build; a socket that blinks in
    // that window reconnects on the old build simply because the new one is
    // not loaded yet. Concluding failure there would call a successful update
    // a failed one.
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);

    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "dispatched" });
  });

  test("a device still on the old build long after the command is recorded as failed", async () => {
    // Past the device's own budget the update is not coming back, and a row
    // reading "dispatched" forever is indistinguishable from one still
    // running. The version stays owed, so a late result or a hello on the new
    // build can still correct the record.
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    // Age the dispatch past the stale window.
    db.prepare("UPDATE devices SET update_state_at = ? WHERE id = ?").run(
      Date.now() - 3 * 60 * 60 * 1_000,
      id,
    );

    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: TARGET, updateState: "failed" });
    expect(rowOf(id)?.updateDetail).toContain("did not land");

    // And the record is still correctable: the device comes back on the new
    // build and the row closes out honestly.
    updateDeviceCapabilities(db, id, { version: TARGET }, 1);
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
  });

  test("a stale reconnect cannot record failure after another socket reports the target commit", async () => {
    const id = pair("multi-socket-source");
    updateDeviceCapabilities(db, id, { version: BEHIND, sourceCommit: "b".repeat(40) }, 1);
    const { server } = fakeWs(async () => ({ accepted: true }));
    const baseGate = directWriteGate(db);
    let interleaveTargetHello = true;
    const interleavedGate: WriteGate = {
      ...baseGate,
      setDeviceUpdateRequest: async (deviceId, request) => {
        if (interleaveTargetHello && request.state === "failed") {
          interleaveTargetHello = false;
          updateDeviceCapabilities(db, id, { version: BEHIND, sourceCommit: COMMIT }, 1);
        }
        return baseGate.setDeviceUpdateRequest(deviceId, request);
      },
    };
    const svc = service(server, interleavedGate);
    await svc.request([id], { kind: "commit", commit: COMMIT });
    db.prepare("UPDATE devices SET update_state_at = ? WHERE id = ?").run(
      Date.now() - 3 * 60 * 60 * 1_000,
      id,
    );

    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({
      desiredVersion: `commit:${COMMIT}`,
      updateState: "dispatched",
    });
    await svc.onDeviceConnected(id);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: "installed" });
  });

  test("a parked request is delivered on the next connection", async () => {
    const id = pair("offline-collector");
    const offline = fakeWs(async () => ({ accepted: true }), false);
    await service(offline.server).request([id]);

    const online = fakeWs(async () => ({ accepted: true }));
    await service(online.server).onDeviceConnected(id);
    expect(online.sent).toEqual([id]);
    expect(rowOf(id)).toMatchObject({ updateState: "dispatched" });
  });

  test("a reconnect with nothing owed commands nothing", async () => {
    const id = pair("behind-collector");
    const { server, sent } = fakeWs(async () => ({ accepted: true }));
    await service(server).onDeviceConnected(id);
    expect(sent).toEqual([]);
  });

  test("a device that reports a result and reconnects for another reason is not re-commanded", async () => {
    // The update is running on the device; a reconnect it made for an
    // unrelated reason must not start a second one over the first.
    const id = pair("behind-collector");
    const { server, sent } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    await svc.request([id]);
    await svc.recordResult(id, { version: TARGET, state: "installed" });

    await svc.onDeviceConnected(id);
    expect(sent).toEqual([id]);
  });
});

describe("guards that only matter under a race", () => {
  test("a result that lands while a refusal is being recorded is not overwritten", async () => {
    // The device refused, and reported something about an earlier attempt on
    // the same socket. The refusal is written only from the state this
    // attempt claimed, so a result that already settled the row stands.
    const id = pair("behind-collector");
    const svc = service();
    const { server } = fakeWs(async () => {
      await svc.recordResult(id, { version: TARGET, state: "installed" });
      return { accepted: false, reason: "An update is already running on this host." };
    });
    await service(server).request([id]);
    expect(rowOf(id)).toMatchObject({ updateState: "installed" });
  });

  test("a result that lands while a lost socket is being parked is not overwritten", async () => {
    const id = pair("behind-collector");
    const svc = service();
    const { server } = fakeWs(async () => {
      await svc.recordResult(id, { version: TARGET, state: "installed" });
      throw new Error("device not connected");
    });
    await service(server).request([id]);
    expect(rowOf(id)).toMatchObject({ updateState: "installed" });
  });

  test("a request that raced a revoke leaves nothing owed to a revoked device", async () => {
    // The plan was read before the revoke and the claim written after it.
    // Nothing runs on a revoked device, so a version owed to one would
    // outlive the clear the revoke performed.
    const id = pair("behind-collector");
    const { server } = fakeWs(async () => ({ accepted: true }));
    const svc = service(server);
    const entries = svc.plan().devices;
    expect(entries.some((d) => d.id === id)).toBe(true);
    revokeDevice(db, id);

    await svc.request([id]);
    expect(rowOf(id)).toMatchObject({ desiredVersion: null, updateState: null });
  });
});
