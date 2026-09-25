// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { doctorReportSchema, type DoctorReport } from "@omnesis/core/doctor";
import { SCOPE_WRITE_ALL, type DeviceId, type DeviceKind } from "@omnesis/types";
import { deviceVersionState } from "../../device-version.js";
import { getDevice, listDevices } from "../../data/repositories/DeviceRepository.js";
import {
  getDeviceDoctorRun,
  listDeviceDoctorRuns,
  type DeviceDoctorRun,
} from "../../data/repositories/DeviceDoctorRunRepository.js";
import { WsCommandError, type DeviceWsServer } from "../../ws.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("gateway:http").child("device-doctor");
const ACK_TIMEOUT_MS = 10_000;
const FANOUT_CONCURRENCY = 8;
const RUN_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
const RUN_TIMEOUT_DETAIL =
  "The collector did not return its health report within 90 seconds. Retry the check.";

export type DeviceDoctorViewState =
  | "not-run"
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "not-applicable";

export interface DeviceDoctorEntry {
  deviceId: DeviceId;
  name: string;
  kind: DeviceKind;
  online: boolean;
  state: DeviceDoctorViewState;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detail: string | null;
  report: DoctorReport | null;
}

export interface DeviceDoctorServiceDeps {
  db: Database.Database;
  writeGate: WriteGate;
  wsServer?: () => DeviceWsServer | undefined;
  now?: () => Date;
  newRunId?: () => string;
  /** Internal protocol budgets are overridable only to keep timeout tests fast. */
  runTimeoutMs?: number;
  retryDelayMs?: number;
}

/**
 * Durable orchestration for collector-local health reports. Only evaluated
 * reports cross the device socket; raw host paths and security inventory stay
 * on the collector that gathered them.
 */
export class DeviceDoctorService {
  private readonly db: Database.Database;
  private readonly w: WriteGate;
  private readonly resolveWsServer: () => DeviceWsServer | undefined;
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly runTimeoutMs: number;
  private readonly retryDelayMs: number;
  private activeDispatches = 0;
  private readonly dispatchQueue: Array<{
    deviceId: DeviceId;
    runId: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly dispatchTasks = new Map<string, Promise<void>>();
  private readonly deadlineTimers = new Map<
    DeviceId,
    { runId: string; deadlineAt: string; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly retryTimers = new Map<
    DeviceId,
    { runId: string; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly retryAttempts = new Map<DeviceId, { runId: string; attempt: number }>();

  constructor(deps: DeviceDoctorServiceDeps) {
    this.db = deps.db;
    this.w = deps.writeGate;
    this.resolveWsServer = deps.wsServer ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
    this.newRunId = deps.newRunId ?? randomUUID;
    this.runTimeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  }

  list(): { devices: DeviceDoctorEntry[] } {
    const runs = new Map(listDeviceDoctorRuns(this.db).map((run) => [run.deviceId, run]));
    const wsServer = this.resolveWsServer();
    return {
      devices: listDevices(this.db).map((device) =>
        this.toEntry(
          device,
          runs.get(device.id),
          wsServer?.isConnected(device.id, SCOPE_WRITE_ALL) ?? false,
        ),
      ),
    };
  }

  async request(deviceIds?: readonly DeviceId[]): Promise<{ devices: DeviceDoctorEntry[] }> {
    const devices = listDevices(this.db);
    const known = new Set(devices.map((device) => device.id));
    for (const deviceId of deviceIds ?? []) {
      if (!known.has(deviceId)) throw new Error(`No such device: ${deviceId}`);
    }

    const wanted = deviceIds ? new Set<DeviceId>(deviceIds) : null;
    const targets = devices.filter(
      (device) => (!wanted || wanted.has(device.id)) && this.notApplicableReason(device) === null,
    );

    const dispatchable: Array<{ deviceId: DeviceId; runId: string }> = [];
    for (const device of targets) {
      const current = getDeviceDoctorRun(this.db, device.id);
      if (current && this.isTimedOut(current)) {
        await this.fail(device.id, current.runId, this.runTimeoutDetail());
      }
      const runId = this.newRunId();
      const began = await this.w.beginDeviceDoctorRun({
        deviceId: device.id,
        runId,
        requestedAt: this.now().toISOString(),
      });
      if (began) dispatchable.push({ deviceId: device.id, runId });
    }
    const response = this.list();
    // Receipts are deliberately asynchronous. At the 500-id HTTP boundary,
    // awaiting eight ten-second acknowledgements at a time could hold the
    // request for more than ten minutes. The durable pending rows are the
    // response; polling observes each bounded dispatch as it advances.
    for (const { deviceId, runId } of dispatchable) {
      void this.dispatchBounded(deviceId, runId).catch((err: unknown) => {
        log.warn(
          `Could not dispatch device doctor run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return response;
  }

  /** Redeliver a queued/in-flight run after its collector authenticates. */
  async onDeviceConnected(deviceId: DeviceId): Promise<void> {
    const run = getDeviceDoctorRun(this.db, deviceId);
    if (!run || (run.state !== "pending" && run.state !== "running")) return;
    const device = getDevice(this.db, deviceId);
    if (!device || this.notApplicableReason(device) !== null) {
      const requeued = await this.w.requeueDeviceDoctorRun({
        deviceId,
        runId: run.runId,
        detail: "Waiting for a collector that advertises remote diagnostics.",
        resetDeadline: true,
      });
      if (requeued) this.clearRunTimers(deviceId, run.runId);
      return;
    }
    const requeued = await this.w.requeueDeviceDoctorRun({
      deviceId,
      runId: run.runId,
      detail: "Collector connected; resuming the same health-check run.",
      resetDeadline: true,
    });
    if (!requeued) return;
    this.clearRunTimers(deviceId, run.runId);
    await this.dispatchAfterCurrent(deviceId, run.runId);
  }

  /** Park an in-flight run when its last collector-authorized socket closes. */
  async onDeviceDisconnected(deviceId: DeviceId): Promise<void> {
    if (this.resolveWsServer()?.isConnected(deviceId, SCOPE_WRITE_ALL)) return;
    const run = getDeviceDoctorRun(this.db, deviceId);
    if (!run || run.state !== "running") return;
    const requeued = await this.w.requeueDeviceDoctorRun({
      deviceId,
      runId: run.runId,
      detail: "Offline. This check will resume when the collector reconnects.",
      resetDeadline: true,
    });
    if (requeued) this.clearRunTimers(deviceId, run.runId);
  }

  /** Accept only the correlated result for the run this device currently owns. */
  async recordResult(
    deviceId: DeviceId,
    result: { runId: string; report: DoctorReport } | { runId: string; error: string },
  ): Promise<void> {
    if ("error" in result) {
      const changed = await this.w.failDeviceDoctorRun({
        deviceId,
        runId: result.runId,
        completedAt: this.now().toISOString(),
        detail: result.error,
      });
      if (changed) this.clearRunTimers(deviceId, result.runId);
      return;
    }
    const parsed = doctorReportSchema.safeParse(result.report);
    if (!parsed.success) {
      const changed = await this.w.failDeviceDoctorRun({
        deviceId,
        runId: result.runId,
        completedAt: this.now().toISOString(),
        detail: "The collector returned a malformed health report.",
      });
      if (changed) this.clearRunTimers(deviceId, result.runId);
      return;
    }
    const changed = await this.w.completeDeviceDoctorRun({
      deviceId,
      runId: result.runId,
      completedAt: this.now().toISOString(),
      reportJson: JSON.stringify(parsed.data),
    });
    if (changed) this.clearRunTimers(deviceId, result.runId);
  }

  /** Share one bounded dispatch lane across initial sends, reconnects and retries. */
  private dispatchBounded(deviceId: DeviceId, runId: string): Promise<void> {
    const key = `${deviceId}:${runId}`;
    const existing = this.dispatchTasks.get(key);
    if (existing) return existing;
    const task = new Promise<void>((resolve, reject) => {
      this.dispatchQueue.push({ deviceId, runId, resolve, reject });
    });
    this.dispatchTasks.set(key, task);
    const cleanup = () => {
      if (this.dispatchTasks.get(key) === task) this.dispatchTasks.delete(key);
    };
    void task.then(cleanup, cleanup);
    this.drainDispatchQueue();
    return task;
  }

  /** Reconnects arriving during socket-failure cleanup redeliver afterwards. */
  private dispatchAfterCurrent(deviceId: DeviceId, runId: string): Promise<void> {
    const current = this.dispatchTasks.get(`${deviceId}:${runId}`);
    return current
      ? current.then(() => this.dispatchBounded(deviceId, runId))
      : this.dispatchBounded(deviceId, runId);
  }

  private drainDispatchQueue(): void {
    while (this.activeDispatches < FANOUT_CONCURRENCY) {
      const next = this.dispatchQueue.shift();
      if (!next) return;
      this.activeDispatches += 1;
      void this.dispatch(next.deviceId, next.runId)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.activeDispatches -= 1;
          this.drainDispatchQueue();
        });
    }
  }

  private async dispatch(deviceId: DeviceId, runId: string): Promise<void> {
    const wsServer = this.resolveWsServer();
    if (!wsServer?.isConnected(deviceId, SCOPE_WRITE_ALL)) return;
    const run = getDeviceDoctorRun(this.db, deviceId);
    if (!run || run.runId !== runId || run.state !== "pending") return;
    if (this.isTimedOut(run)) {
      await this.fail(deviceId, runId, this.runTimeoutDetail());
      return;
    }
    const deadlineAt =
      run.deadlineAt ?? new Date(this.now().getTime() + this.runTimeoutMs).toISOString();
    const started = await this.w.startDeviceDoctorRun({
      deviceId,
      runId,
      startedAt: this.now().toISOString(),
      deadlineAt,
    });
    if (!started) return;
    this.scheduleDeadline(deviceId, runId, deadlineAt);

    try {
      const ack = await wsServer.sendCommand(
        deviceId,
        "device.doctor",
        { runId },
        ACK_TIMEOUT_MS,
        SCOPE_WRITE_ALL,
      );
      if (ack.accepted) {
        this.clearRetry(deviceId, runId);
        return;
      }
      await this.fail(deviceId, runId, ack.reason ?? "The collector refused the health check.");
    } catch (err) {
      if (err instanceof WsCommandError) {
        await this.fail(
          deviceId,
          runId,
          `This collector does not accept health-check commands (${err.code}).`,
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const stillOnline = wsServer.isConnected(deviceId, SCOPE_WRITE_ALL);
      const requeued = await this.w.requeueDeviceDoctorRun({
        deviceId,
        runId,
        detail: "The collector went offline; this check will resume when it reconnects.",
        resetDeadline: !stillOnline,
      });
      log.warn(`Could not deliver device doctor run ${runId}: ${message}`);
      if (requeued && stillOnline) this.scheduleRetry(deviceId, runId, deadlineAt);
    }
  }

  private async fail(
    deviceId: DeviceId,
    runId: string,
    detail: string,
    expectedDeadlineAt?: string,
  ): Promise<void> {
    const changed = await this.w.failDeviceDoctorRun({
      deviceId,
      runId,
      completedAt: this.now().toISOString(),
      detail,
      expectedDeadlineAt,
    });
    if (changed) this.clearRunTimers(deviceId, runId);
  }

  private scheduleRetry(deviceId: DeviceId, runId: string, deadlineAt: string): void {
    const existing = this.retryTimers.get(deviceId);
    if (existing?.runId === runId) return;
    if (existing) clearTimeout(existing.timer);
    const remaining = this.remainingMs(deadlineAt);
    if (remaining <= 0) {
      void this.expireActiveRun(deviceId, runId, deadlineAt);
      return;
    }
    const previous = this.retryAttempts.get(deviceId);
    const attempt = previous?.runId === runId ? previous.attempt + 1 : 1;
    this.retryAttempts.set(deviceId, { runId, attempt });
    const backoff = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    const timer = setTimeout(
      () => {
        const current = this.retryTimers.get(deviceId);
        if (current?.runId === runId && current.timer === timer) {
          this.retryTimers.delete(deviceId);
        }
        void this.dispatchBounded(deviceId, runId).catch((err: unknown) => {
          log.warn(
            `Could not retry device doctor run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      Math.min(backoff, remaining),
    );
    timer.unref();
    this.retryTimers.set(deviceId, { runId, timer });
  }

  private scheduleDeadline(deviceId: DeviceId, runId: string, deadlineAt: string): void {
    const existing = this.deadlineTimers.get(deviceId);
    if (existing?.runId === runId && existing.deadlineAt === deadlineAt) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(
      () => {
        const current = this.deadlineTimers.get(deviceId);
        if (
          current?.runId === runId &&
          current.deadlineAt === deadlineAt &&
          current.timer === timer
        ) {
          this.deadlineTimers.delete(deviceId);
        }
        void this.expireActiveRun(deviceId, runId, deadlineAt).catch((err: unknown) => {
          log.warn(
            `Could not expire device doctor run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      Math.max(0, this.remainingMs(deadlineAt)),
    );
    timer.unref();
    this.deadlineTimers.set(deviceId, { runId, deadlineAt, timer });
  }

  private async expireActiveRun(
    deviceId: DeviceId,
    runId: string,
    expectedDeadlineAt: string,
  ): Promise<void> {
    // An interrupted run stays pending while the collector is offline; a new
    // deadline starts when its collector-authorized socket reconnects.
    if (!this.resolveWsServer()?.isConnected(deviceId, SCOPE_WRITE_ALL)) return;
    try {
      await this.fail(deviceId, runId, this.runTimeoutDetail(), expectedDeadlineAt);
    } catch {
      // The owning gateway (or a focused test database) has shut down.
      return;
    }
  }

  private clearRetry(deviceId: DeviceId, runId: string): void {
    const retry = this.retryTimers.get(deviceId);
    if (retry?.runId === runId) {
      clearTimeout(retry.timer);
      this.retryTimers.delete(deviceId);
    }
    const attempt = this.retryAttempts.get(deviceId);
    if (attempt?.runId === runId) this.retryAttempts.delete(deviceId);
  }

  private clearRunTimers(deviceId: DeviceId, runId: string): void {
    this.clearRetry(deviceId, runId);
    const deadline = this.deadlineTimers.get(deviceId);
    if (deadline?.runId === runId) {
      clearTimeout(deadline.timer);
      this.deadlineTimers.delete(deviceId);
    }
  }

  private remainingMs(deadlineAt: string): number {
    const deadline = Date.parse(deadlineAt);
    return Number.isFinite(deadline) ? deadline - this.now().getTime() : 0;
  }

  private isTimedOut(run: DeviceDoctorRun): boolean {
    return (
      (run.state === "pending" || run.state === "running") &&
      run.deadlineAt !== null &&
      this.remainingMs(run.deadlineAt) <= 0
    );
  }

  private runTimeoutDetail(): string {
    return this.runTimeoutMs === RUN_TIMEOUT_MS
      ? RUN_TIMEOUT_DETAIL
      : `The collector did not return its health report within ${this.runTimeoutMs}ms. Retry the check.`;
  }

  private toEntry(
    device: ReturnType<typeof listDevices>[number],
    run: DeviceDoctorRun | undefined,
    online: boolean,
  ): DeviceDoctorEntry {
    const notApplicable = this.notApplicableReason(device);
    if (notApplicable) {
      return {
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        online,
        state: "not-applicable",
        requestedAt: null,
        startedAt: null,
        completedAt: null,
        detail: notApplicable,
        report: null,
      };
    }
    if (!run) {
      return {
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        online,
        state: "not-run",
        requestedAt: null,
        startedAt: null,
        completedAt: null,
        detail: null,
        report: null,
      };
    }
    // A disconnected collector pauses its active-time budget. This also
    // covers a gateway restart: the persisted deadline may be in the past,
    // but the same run remains queued until a collector-authorized socket
    // reconnects and gives it a fresh deadline.
    if (online && this.isTimedOut(run)) {
      return {
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        online,
        state: "failed",
        requestedAt: run.requestedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        detail: this.runTimeoutDetail(),
        report: null,
      };
    }
    let parsed: ReturnType<typeof doctorReportSchema.safeParse> | null = null;
    if (run.reportJson) {
      try {
        parsed = doctorReportSchema.safeParse(JSON.parse(run.reportJson));
      } catch {
        parsed = doctorReportSchema.safeParse(null);
      }
    }
    const malformed = parsed && !parsed.success;
    return {
      deviceId: device.id,
      name: device.name,
      kind: device.kind,
      online,
      state: malformed ? "failed" : run.state === "running" && !online ? "pending" : run.state,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      detail:
        run.detail ??
        (malformed
          ? "The stored health report is malformed. Run the check again."
          : (run.state === "pending" || run.state === "running") && !online
            ? "Offline. This check will run when the collector reconnects."
            : null),
      report: parsed?.success ? parsed.data : null,
    };
  }

  private notApplicableReason(device: ReturnType<typeof listDevices>[number]): string | null {
    if (device.revokedAt !== null) return "This device is revoked.";
    if (device.kind !== "collector") return "This device does not run collector diagnostics.";
    const version = deviceVersionState(device);
    if (version === "unknown") return "This collector has not reported a compatible build yet.";
    if (version === "unsupported") {
      return "This collector is too old for remote diagnostics. Update it on its host first.";
    }
    if (device.capabilities.deviceDoctor !== true) {
      return "This collector does not advertise remote diagnostics. Update it on its host first.";
    }
    return null;
  }
}
