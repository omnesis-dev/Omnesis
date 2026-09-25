// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";

import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import {
  beginDeviceDoctorRun,
  completeDeviceDoctorRun,
  failDeviceDoctorRun,
  getDeviceDoctorRun,
  listDeviceDoctorRuns,
  requeueDeviceDoctorRun,
  startDeviceDoctorRun,
} from "./DeviceDoctorRunRepository.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const device = createDevice(db, { name: "Fictional phone", kind: "ios" });
  return { db, device };
}

describe("device doctor run persistence", () => {
  test("begins, gets, and lists pending runs", () => {
    const { db, device } = fixture();
    const other = createDevice(db, { name: "Fictional laptop", kind: "collector" });

    expect(
      beginDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-phone",
        requestedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      beginDeviceDoctorRun(db, {
        deviceId: other.id,
        runId: "run-laptop",
        requestedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe(true);

    expect(getDeviceDoctorRun(db, device.id)).toEqual({
      deviceId: device.id,
      runId: "run-phone",
      state: "pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      deadlineAt: null,
      completedAt: null,
      detail: null,
      reportJson: null,
    });
    expect(listDeviceDoctorRuns(db).map((run) => run.runId)).toEqual(["run-laptop", "run-phone"]);
  });

  test("does not replace a pending or running run and clears settled data for a new run", () => {
    const { db, device } = fixture();
    const first = {
      deviceId: device.id,
      runId: "run-first",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(beginDeviceDoctorRun(db, first)).toBe(true);
    expect(
      beginDeviceDoctorRun(db, {
        ...first,
        runId: "run-second",
        requestedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      startDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: first.runId,
        startedAt: "2026-01-01T00:00:01.000Z",
        deadlineAt: "2026-01-01T00:01:31.000Z",
      }),
    ).toBe(true);
    expect(
      beginDeviceDoctorRun(db, {
        ...first,
        runId: "run-second",
        requestedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      completeDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: first.runId,
        completedAt: "2026-01-01T00:00:02.000Z",
        detail: "Checks complete",
        reportJson: '{"status":"healthy"}',
      }),
    ).toBe(true);

    expect(beginDeviceDoctorRun(db, first)).toBe(false);
    expect(
      beginDeviceDoctorRun(db, {
        ...first,
        runId: "run-second",
        requestedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      runId: "run-second",
      state: "pending",
      requestedAt: "2026-01-02T00:00:00.000Z",
      startedAt: null,
      deadlineAt: null,
      completedAt: null,
      detail: null,
      reportJson: null,
    });
  });

  test("compare-and-sets running and pending retry transitions", () => {
    const { db, device } = fixture();
    beginDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-1",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    const start = {
      deviceId: device.id,
      runId: "run-1",
      startedAt: "2026-01-01T00:00:01.000Z",
      deadlineAt: "2026-01-01T00:01:31.000Z",
    };

    expect(startDeviceDoctorRun(db, start)).toBe(true);
    expect(startDeviceDoctorRun(db, start)).toBe(false);
    expect(
      requeueDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-1",
        detail: "Device disconnected",
      }),
    ).toBe(true);
    expect(requeueDeviceDoctorRun(db, { deviceId: device.id, runId: "run-1" })).toBe(false);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      state: "pending",
      startedAt: null,
      deadlineAt: "2026-01-01T00:01:31.000Z",
      detail: "Device disconnected",
    });
    expect(
      completeDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-1",
        completedAt: "2026-01-01T00:00:02.000Z",
        reportJson: '{"status":"healthy"}',
      }),
    ).toBe(true);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      state: "complete",
      reportJson: '{"status":"healthy"}',
    });
  });

  test("can claim a requeued run again when no late result arrives", () => {
    const { db, device } = fixture();
    beginDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-1",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    const start = {
      deviceId: device.id,
      runId: "run-1",
      startedAt: "2026-01-01T00:00:01.000Z",
      deadlineAt: "2026-01-01T00:01:31.000Z",
    };
    expect(startDeviceDoctorRun(db, start)).toBe(true);
    expect(
      requeueDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-1",
        resetDeadline: true,
      }),
    ).toBe(true);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({ deadlineAt: null });
    expect(startDeviceDoctorRun(db, start)).toBe(true);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      state: "running",
      deadlineAt: "2026-01-01T00:01:31.000Z",
      detail: null,
    });
  });

  test("fences every transition and final report by run id", () => {
    const { db, device } = fixture();
    beginDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-current",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      startDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-stale",
        startedAt: "2026-01-01T00:00:01.000Z",
        deadlineAt: "2026-01-01T00:01:31.000Z",
      }),
    ).toBe(false);
    expect(
      failDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-stale",
        completedAt: "2026-01-01T00:00:02.000Z",
        detail: "Late failure",
      }),
    ).toBe(false);
    expect(
      completeDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-stale",
        completedAt: "2026-01-01T00:00:02.000Z",
        reportJson: '{"status":"stale"}',
      }),
    ).toBe(false);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      runId: "run-current",
      state: "pending",
      completedAt: null,
      reportJson: null,
    });
  });

  test("fails either a pending or running run", () => {
    const { db, device } = fixture();
    beginDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-pending",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      failDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-pending",
        completedAt: "2026-01-01T00:00:02.000Z",
        detail: "Unsupported protocol",
      }),
    ).toBe(true);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      state: "failed",
      completedAt: "2026-01-01T00:00:02.000Z",
      detail: "Unsupported protocol",
      reportJson: null,
    });

    beginDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-running",
      requestedAt: "2026-01-02T00:00:00.000Z",
    });
    startDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-running",
      startedAt: "2026-01-02T00:00:01.000Z",
      deadlineAt: "2026-01-02T00:01:31.000Z",
    });
    expect(
      failDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-running",
        completedAt: "2026-01-02T00:00:02.000Z",
        detail: "Collector refused",
      }),
    ).toBe(true);
  });

  test("an old deadline cannot expire the same run after its offline budget resets", () => {
    const { db, device } = fixture();
    beginDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-resumed",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    startDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-resumed",
      startedAt: "2026-01-01T00:00:01.000Z",
      deadlineAt: "2026-01-01T00:01:31.000Z",
    });
    requeueDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-resumed",
      resetDeadline: true,
    });
    startDeviceDoctorRun(db, {
      deviceId: device.id,
      runId: "run-resumed",
      startedAt: "2026-01-01T00:00:20.000Z",
      deadlineAt: "2026-01-01T00:01:50.000Z",
    });

    expect(
      failDeviceDoctorRun(db, {
        deviceId: device.id,
        runId: "run-resumed",
        completedAt: "2026-01-01T00:01:31.000Z",
        detail: "Old timer fired",
        expectedDeadlineAt: "2026-01-01T00:01:31.000Z",
      }),
    ).toBe(false);
    expect(getDeviceDoctorRun(db, device.id)).toMatchObject({
      state: "running",
      deadlineAt: "2026-01-01T00:01:50.000Z",
    });
  });
});
