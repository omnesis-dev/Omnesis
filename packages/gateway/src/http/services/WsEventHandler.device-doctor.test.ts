// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { makeEvent } from "@omnesis/core";
import { SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import { SyncStatusRegistry } from "../../sync-status.js";
import { WsEventHandler } from "./WsEventHandler.js";
import type { AuthFlowRegistry } from "../../auth-flows.js";
import type { DeviceDoctorService } from "./DeviceDoctorService.js";
import type { DeviceConnection } from "../../ws.js";
import type { WriteGate } from "../../write-gate.js";

const DEVICE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as DeviceConnection["deviceId"];
const REPORT = {
  ok: true,
  summary: { errors: 0, warnings: 0 },
  checks: [{ id: "process", section: "Process", status: "pass" as const, message: "Ready" }],
};

function makeHandler() {
  const recordResult = vi.fn(() => Promise.resolve());
  const onDeviceDisconnected = vi.fn(() => Promise.resolve());
  const deviceDoctor = {
    recordResult,
    onDeviceDisconnected,
  } as unknown as DeviceDoctorService;
  const handler = new WsEventHandler({
    db: {} as ConstructorParameters<typeof WsEventHandler>[0]["db"],
    writeGate: {} as WriteGate,
    syncStatus: new SyncStatusRegistry(),
    authFlows: {} as AuthFlowRegistry,
    deviceDoctor,
  });
  return { handler, recordResult, onDeviceDisconnected };
}

function connection(scopes: DeviceConnection["scopes"]): DeviceConnection {
  return { deviceId: DEVICE_ID, scopes };
}

describe("WsEventHandler — device doctor authorization", () => {
  test("only the collector-authorized socket may settle a run", async () => {
    const { handler, recordResult } = makeHandler();
    const event = makeEvent("device.doctor.result", { runId: "run-1", report: REPORT });

    handler.handleEvent(connection([SCOPE_READ]), event);
    expect(recordResult).not.toHaveBeenCalled();

    handler.handleEvent(connection([SCOPE_WRITE_ALL]), event);
    await vi.waitFor(() =>
      expect(recordResult).toHaveBeenCalledWith(DEVICE_ID, { runId: "run-1", report: REPORT }),
    );
  });

  test("only a collector-authorized socket disconnect parks a run", async () => {
    const { handler, onDeviceDisconnected } = makeHandler();

    handler.handleDisconnected(connection([SCOPE_READ]));
    expect(onDeviceDisconnected).not.toHaveBeenCalled();

    handler.handleDisconnected(connection([SCOPE_WRITE_ALL]));
    await vi.waitFor(() => expect(onDeviceDisconnected).toHaveBeenCalledWith(DEVICE_ID));
  });
});
