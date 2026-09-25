// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_WRITE_ALL, type DeviceId, type DeviceKind, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import { getDeviceDoctorRun } from "../../data/repositories/DeviceDoctorRunRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { WsCommandError, type DeviceWsServer } from "../../ws.js";
import { DeviceDoctorService } from "./DeviceDoctorService.js";
import type { DoctorReport } from "@omnesis/core/doctor";

const REPORT: DoctorReport = {
  ok: true,
  summary: { errors: 0, warnings: 0 },
  checks: [
    {
      id: "gateway.not-applicable",
      section: "Gateway",
      status: "not-applicable",
      message: "Evaluated only on the gateway host",
    },
    { id: "process.event-loop", section: "Process", status: "pass", message: "Responsive" },
  ],
};

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-device-doctor-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function pair(
  name: string,
  kind: DeviceKind = "collector",
  deviceDoctor = kind === "collector",
): DeviceId {
  const device = createDevice(db, { name, kind });
  updateDeviceCapabilities(
    db,
    device.id,
    { version: "99.0.0", ...(deviceDoctor ? { deviceDoctor: true } : {}) },
    1,
  );
  return device.id;
}

function fakeWs(options?: {
  online?: (id: DeviceId) => boolean;
  collectorScoped?: boolean;
  answer?: (id: DeviceId, runId: string) => Promise<{ accepted: boolean; reason?: string }>;
}): { server: DeviceWsServer; sent: Array<{ id: DeviceId; runId: string; scope?: Scope }> } {
  const sent: Array<{ id: DeviceId; runId: string; scope?: Scope }> = [];
  const server = {
    isConnected: (id: DeviceId, requiredScope?: Scope) =>
      (options?.online?.(id) ?? true) &&
      (!requiredScope || requiredScope !== SCOPE_WRITE_ALL || options?.collectorScoped !== false),
    sendCommand: async (
      id: DeviceId,
      _type: string,
      payload: { runId: string },
      _timeout: number,
      scope?: Scope,
    ) => {
      sent.push({ id, runId: payload.runId, scope });
      return options?.answer?.(id, payload.runId) ?? { accepted: true };
    },
  } as unknown as DeviceWsServer;
  return { server, sent };
}

function service(
  server?: DeviceWsServer,
  options?: {
    now?: () => Date;
    newRunId?: () => string;
    runTimeoutMs?: number;
    retryDelayMs?: number;
  },
): DeviceDoctorService {
  let sequence = 0;
  return new DeviceDoctorService({
    db,
    writeGate: directWriteGate(db),
    wsServer: () => server,
    now: options?.now ?? (() => new Date("2026-09-07T08:00:00.000Z")),
    newRunId: options?.newRunId ?? (() => `run-${++sequence}`),
    runTimeoutMs: options?.runTimeoutMs,
    retryDelayMs: options?.retryDelayMs,
  });
}

describe("DeviceDoctorService", () => {
  test("fans out to online collectors and records correlated reports", async () => {
    const first = pair("Studio collector");
    const second = pair("Workshop collector");
    const phone = pair("Test phone", "ios");
    const ws = fakeWs();
    const svc = service(ws.server);

    const requested = await svc.request();

    await vi.waitFor(() => expect(ws.sent.map((entry) => entry.id)).toEqual([first, second]));
    expect(ws.sent.every((entry) => entry.scope === SCOPE_WRITE_ALL)).toBe(true);
    expect(requested.devices.find((entry) => entry.deviceId === phone)?.state).toBe(
      "not-applicable",
    );
    const run = getDeviceDoctorRun(db, first)!;
    await svc.recordResult(first, { runId: run.runId, report: REPORT });
    expect(svc.list().devices.find((entry) => entry.deviceId === first)).toMatchObject({
      state: "complete",
      report: REPORT,
    });
  });

  test("keeps an offline collector pending and dispatches it on reconnect", async () => {
    const id = pair("Travel collector");
    let online = false;
    const ws = fakeWs({ online: () => online });
    const svc = service(ws.server);

    await svc.request([id]);
    expect(svc.list().devices[0]).toMatchObject({ state: "pending", online: false });
    expect(ws.sent).toEqual([]);

    online = true;
    await svc.onDeviceConnected(id);
    expect(ws.sent).toHaveLength(1);
    expect(svc.list().devices[0]?.state).toBe("running");
  });

  test("waits for a reconnect that still advertises the doctor capability", async () => {
    const id = pair("Roaming collector");
    let online = true;
    const ws = fakeWs({ online: () => online });
    const svc = service(ws.server);

    await svc.request([id]);
    await vi.waitFor(() => expect(getDeviceDoctorRun(db, id)).toMatchObject({ state: "running" }));
    const runId = getDeviceDoctorRun(db, id)!.runId;
    online = false;
    await svc.onDeviceDisconnected(id);
    updateDeviceCapabilities(db, id, { version: "99.0.0" }, 1);
    online = true;
    await svc.onDeviceConnected(id);

    expect(ws.sent).toHaveLength(1);
    expect(getDeviceDoctorRun(db, id)).toMatchObject({ runId, state: "pending" });
    expect(svc.list().devices[0]).toMatchObject({ state: "not-applicable" });

    updateDeviceCapabilities(db, id, { version: "99.0.0", deviceDoctor: true }, 1);
    await svc.onDeviceConnected(id);

    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[1]).toMatchObject({ id, runId });
    expect(getDeviceDoctorRun(db, id)).toMatchObject({ runId, state: "running" });
  });

  test("a command refusal settles only that collector as failed", async () => {
    const refused = pair("Old collector");
    const healthy = pair("Current collector");
    const ws = fakeWs({
      answer: async (id) => {
        if (id === refused) throw new WsCommandError("unsupported", "no handler");
        return { accepted: true };
      },
    });

    const svc = service(ws.server);
    await svc.request();

    await vi.waitFor(() => {
      const result = svc.list();
      expect(result.devices.find((entry) => entry.deviceId === refused)?.state).toBe("failed");
      expect(result.devices.find((entry) => entry.deviceId === healthy)?.state).toBe("running");
    });
  });

  test("a stale result cannot overwrite the current run", async () => {
    const id = pair("Desk collector");
    const ws = fakeWs();
    const svc = service(ws.server);
    await svc.request([id]);
    const first = getDeviceDoctorRun(db, id)!;
    await svc.recordResult(id, { runId: first.runId, report: REPORT });
    await svc.request([id]);

    await svc.recordResult(id, { runId: first.runId, error: "late failure" });

    expect(getDeviceDoctorRun(db, id)).toMatchObject({ runId: "run-2", state: "running" });
  });

  test("treats a collector without the explicit doctor capability as not applicable", async () => {
    const id = pair("Legacy collector", "collector", false);
    const ws = fakeWs();
    const svc = service(ws.server);

    const result = await svc.request([id]);

    expect(result.devices[0]).toMatchObject({
      state: "not-applicable",
      detail: expect.stringContaining("does not advertise"),
    });
    expect(ws.sent).toEqual([]);
  });

  test("a lower-scope socket neither makes the collector online nor receives the command", async () => {
    const id = pair("Scoped collector");
    const ws = fakeWs({ collectorScoped: false });
    const svc = service(ws.server);

    await svc.request([id]);

    expect(svc.list().devices[0]).toMatchObject({ state: "pending", online: false });
    expect(ws.sent).toEqual([]);
  });

  test("parks a running check when the last collector socket disconnects", async () => {
    const id = pair("Field collector");
    let online = true;
    const ws = fakeWs({ online: () => online });
    const svc = service(ws.server);
    await svc.request([id]);
    await vi.waitFor(() => expect(svc.list().devices[0]?.state).toBe("running"));

    online = false;
    await svc.onDeviceDisconnected(id);

    expect(svc.list().devices[0]).toMatchObject({ state: "pending", online: false });
  });

  test("expires an accepted run that never returns and fences its late result", async () => {
    const id = pair("Quiet collector");
    const ws = fakeWs();
    const svc = service(ws.server, { runTimeoutMs: 20 });
    await svc.request([id]);
    const run = getDeviceDoctorRun(db, id)!;

    await vi.waitFor(() => expect(svc.list().devices[0]?.state).toBe("failed"));
    await svc.recordResult(id, { runId: run.runId, report: REPORT });

    expect(getDeviceDoctorRun(db, id)).toMatchObject({ state: "failed", reportJson: null });
  });

  test("retries an acknowledgement failure while the scoped socket stays connected", async () => {
    const id = pair("Retry collector");
    const ws = fakeWs({
      answer: async () => {
        throw new Error("receipt timed out");
      },
    });
    const svc = service(ws.server, { runTimeoutMs: 30, retryDelayMs: 1 });
    await svc.request([id]);

    await vi.waitFor(() => expect(svc.list().devices[0]?.state).toBe("failed"));
    expect(ws.sent.length).toBeGreaterThan(1);
  });

  test("returns pending without awaiting acknowledgements and caps every dispatch lane", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => pair(`Collector ${index + 1}`));
    const receipts = new Map(ids.map((id) => [id, Promise.withResolvers<{ accepted: boolean }>()]));
    const ws = fakeWs({ answer: async (id) => receipts.get(id)!.promise });
    const svc = service(ws.server);

    const response = await svc.request(ids);

    expect(response.devices.filter((entry) => ids.includes(entry.deviceId))).toEqual(
      expect.arrayContaining(
        ids.map((deviceId) => expect.objectContaining({ deviceId, state: "pending" })),
      ),
    );
    await vi.waitFor(() => expect(ws.sent).toHaveLength(8));
    receipts.get(ws.sent[0]!.id)!.resolve({ accepted: true });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(9));

    for (const receipt of receipts.values()) receipt.resolve({ accepted: true });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(10));
    for (const id of ids) {
      const run = getDeviceDoctorRun(db, id)!;
      await svc.recordResult(id, { runId: run.runId, report: REPORT });
    }
  });

  test("a reconnect deadline is not expired by the run's old timer", async () => {
    vi.useFakeTimers();
    try {
      const id = pair("Resumed collector");
      let online = true;
      let nowMs = Date.parse("2026-09-07T08:00:00.000Z");
      const ws = fakeWs({ online: () => online });
      const svc = service(ws.server, {
        now: () => new Date(nowMs),
        runTimeoutMs: 30_000,
      });

      await svc.request([id]);
      await vi.advanceTimersByTimeAsync(0);
      expect(getDeviceDoctorRun(db, id)).toMatchObject({ state: "running" });

      online = false;
      await svc.onDeviceDisconnected(id);
      nowMs += 10_000;
      online = true;
      await svc.onDeviceConnected(id);
      expect(getDeviceDoctorRun(db, id)).toMatchObject({
        state: "running",
        deadlineAt: "2026-09-07T08:00:40.000Z",
      });

      nowMs += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getDeviceDoctorRun(db, id)).toMatchObject({ state: "running" });

      const run = getDeviceDoctorRun(db, id)!;
      await svc.recordResult(id, { runId: run.runId, report: REPORT });
    } finally {
      vi.useRealTimers();
    }
  });

  test("reclaims a stale persisted run after a gateway service restart", async () => {
    const id = pair("Restart collector");
    let now = new Date("2026-09-07T08:00:00.000Z");
    const ws = fakeWs();
    await service(ws.server, {
      now: () => now,
      newRunId: () => "run-before-restart",
      runTimeoutMs: 10_000,
    }).request([id]);
    await vi.waitFor(() => expect(getDeviceDoctorRun(db, id)?.state).toBe("running"));
    expect(getDeviceDoctorRun(db, id)).toMatchObject({
      runId: "run-before-restart",
      state: "running",
    });

    now = new Date("2026-09-07T08:00:20.000Z");
    const restarted = service(ws.server, {
      now: () => now,
      newRunId: () => "run-after-restart",
      runTimeoutMs: 10_000,
    });
    await restarted.request([id]);
    await vi.waitFor(() => expect(getDeviceDoctorRun(db, id)?.state).toBe("running"));

    expect(getDeviceDoctorRun(db, id)).toMatchObject({
      runId: "run-after-restart",
      state: "running",
    });
    expect(restarted.list().devices[0]?.state).toBe("running");
  });
});
