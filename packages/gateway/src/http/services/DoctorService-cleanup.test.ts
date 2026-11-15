// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi } from "vitest";
import { DoctorService, type DoctorServiceDeps } from "./DoctorService.js";
import type { SecurityData } from "@omnesis/core/doctor";

const fixture = vi.hoisted(() => ({
  result: Promise.resolve({}) as Promise<SecurityData>,
  closing: Promise.resolve(),
  receipt: undefined as unknown,
  collect: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@omnesis/core/doctor", async (original) => {
  const actual = await original<typeof import("@omnesis/core/doctor")>();
  return {
    ...actual,
    collectSecurityDataInWorker: () => {
      fixture.collect();
      return fixture.result;
    },
    DoctorSecurityScanner: class {
      collect() {
        fixture.collect();
        return fixture.result;
      }
      cleanupFailure() {
        return fixture.receipt;
      }
      close() {
        fixture.close();
        return fixture.closing;
      }
    },
  };
});
function service() {
  return new DoctorService({
    configDir: "invented-config",
    statusCache: { sourceHostingDeviceIds: new Set(), listDevices: [] },
    sourceService: { listSourcesForAdmin: () => [], listSyncStatuses: () => [] },
    indexStats: { db: undefined },
  } as unknown as DoctorServiceDeps) as DoctorService & {
    cleanupFailure?(): unknown;
    close?(): Promise<void>;
  };
}
const identity = { tokenId: null, deviceId: null, deviceName: null, scopes: [] };
beforeEach(() => {
  vi.clearAllMocks();
  fixture.receipt = undefined;
  fixture.closing = Promise.resolve();
});

test("report conversion retains an explicit undefined receipt and refuses fresh scans", async () => {
  const failure = Object.assign(new Error("Invented unjoined Native audit"), {
    cleanupFailure: undefined,
  });
  fixture.result = Promise.reject(failure);
  void fixture.result.catch(() => {});
  fixture.receipt = failure;
  fixture.closing = Promise.reject(failure);
  void fixture.closing.catch(() => {});
  const owner = service();
  await owner.report(identity);
  expect(owner.cleanupFailure?.()).toBe(failure);
  await owner.report(identity);
  expect(fixture.collect).toHaveBeenCalledTimes(0);
  const closing = owner.close?.();
  expect(owner.close?.()).toBe(closing);
  await expect(closing).rejects.toBe(failure);
  expect(fixture.close).toHaveBeenCalledOnce();
});

test("a prompt failed observation cannot replace the retained late join on close", async () => {
  fixture.result = Promise.reject(new Error("Invented timed-out observation"));
  void fixture.result.catch(() => {});
  fixture.receipt = Object.assign(new Error("Invented active scanner"), {
    cleanupFailure: undefined,
    cleanupPending: true,
  });
  let release!: () => void;
  fixture.closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = service();
  const report = await owner.report(identity);
  expect(report).toHaveProperty("checks");
  let closed = false;
  const closing = owner.close?.();
  void closing?.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(owner.cleanupFailure?.()).toMatchObject({ cleanupPending: true });
  fixture.receipt = undefined;
  release();
  await closing;
  expect(owner.cleanupFailure?.()).toBeUndefined();
  const scans = fixture.collect.mock.calls.length;
  await expect(owner.report(identity)).rejects.toThrow("closed");
  expect(fixture.collect).toHaveBeenCalledTimes(scans);
});

test("an ordinary joined unavailable audit remains reportable and retryable", async () => {
  fixture.result = Promise.reject(new Error("Invented joined unavailable audit"));
  void fixture.result.catch(() => {});
  const owner = service();
  await owner.report(identity);
  await owner.report(identity);
  expect(fixture.collect).toHaveBeenCalledTimes(2);
  expect(owner.cleanupFailure?.()).toBeUndefined();
  await owner.close?.();
});
