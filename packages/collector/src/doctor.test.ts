// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { CollectorDoctor, type CollectorDoctorDeps } from "./doctor.js";
import type { WsEventPayload } from "@omnesis/core";
import type { GatewayWsClient } from "@omnesis/gateway-client";
import type { ConfigStatusResult, SecurityData, SystemInfoResult } from "@omnesis/core/doctor";

const CONFIG: ConfigStatusResult = {
  ok: true,
  version: 7,
  lastLoadedAt: 1,
  lastWrittenAt: null,
  lastError: null,
};

const SECURITY = {
  configDir: "/tmp",
  fixPermissions: false,
  permissionEntries: [],
  permissionScanTruncated: false,
  diskEncryption: { platform: "linux", status: "on", detail: "encrypted" },
  serviceUnits: [],
  gatewayIsolation: {
    status: "not-applicable",
    detail: "collector report",
    systemUnitPath: null,
  },
  keyringAccess: { readable: true },
  keyring: {
    keyName: "install-root-key-v1",
    store: {
      requestedBackend: "auto",
      backend: "secret-service",
      available: true,
      secure: true,
      detail: "available",
      writeExposure: "stdin",
    },
    present: true,
    valid: true,
  },
  keyringWiring: [],
  recoveryEscrow: { status: "missing", detail: "not exported", path: "/tmp/recovery.json" },
  databaseEncryption: {
    status: "on",
    detail: "collector report",
    required: true,
    stores: [{ keyName: "whatsapp-store", present: true, valid: true, encrypted: true }],
  },
} satisfies SecurityData;

function makeDoctor(options?: {
  security?: () => Promise<SecurityData>;
  getIdentity?: () => ReturnType<GatewayWsClient["getIdentity"]>;
  getSystemInfo?: () => Promise<SystemInfoResult>;
  runTimeoutMs?: number;
  getSourceStatuses?: CollectorDoctorDeps["getSourceStatuses"];
  getReadAccessSources?: CollectorDoctorDeps["getReadAccessSources"];
}) {
  const events: WsEventPayload<"device.doctor.result">[] = [];
  const doctor = new CollectorDoctor({
    configDir: "/tmp",
    getIdentity:
      options?.getIdentity ??
      (() => ({
        deviceId: "dev-collector",
        deviceName: "collector-alpha",
        deviceKind: "collector",
        protocolVersion: 1,
        scopes: ["admin"],
      })),
    getConfigStatus: () => CONFIG,
    getReadAccessSources: options?.getReadAccessSources ?? (() => []),
    getSourceStatuses:
      options?.getSourceStatuses ??
      (() => [
        {
          sourceId: "demo-files:local",
          providerId: "demo-files:local",
          sourceName: "Demo files",
          state: "error",
          lastError: "Access denied",
        },
      ]),
    getProcessVitals: () => ({
      eventLoop: { current: { p50Ms: 1, p95Ms: 2, p99Ms: 3 } },
      memory: { current: { rssBytes: 10, heapUsedBytes: 5, heapTotalBytes: 20 } },
    }),
    getSystemInfo:
      options?.getSystemInfo ??
      (async () => ({
        platform: "linux",
        arch: "x64",
        totalRamGb: 16,
        freeRamGb: 8,
        modelsDir: "/tmp",
        modelsDirFreeGb: 20,
        dataDir: "/tmp",
        dataDirFreeGb: 20,
      })),
    collectSecurity: options?.security ?? (async () => SECURITY),
    runTimeoutMs: options?.runTimeoutMs,
    emitResult: (result) => events.push(result),
  });
  return { doctor, events };
}

describe("CollectorDoctor", () => {
  test("carries what its sources found on disk, and names itself in the remedies", async () => {
    const { doctor, events } = makeDoctor({
      getReadAccessSources: () => [
        {
          sourceId: "whatsapp:+15550100001",
          instance: {
            sync: vi.fn(),
            probeLocalStores: async () => [
              { keyName: "whatsapp-store", label: "WhatsApp message archive", state: "plaintext" },
            ],
          },
        },
      ],
    });
    doctor.start("stores");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const first = events[0]!;
    if (!("report" in first)) throw new Error(`run failed: ${first.error}`);
    const encryption = first.report.checks.find(
      (check) => check.id === "security.database-encryption",
    );
    expect(encryption).toMatchObject({
      status: "warn",
      message:
        "1 store is still plaintext on disk: WhatsApp message archive (whatsapp:+15550100001)",
    });
    // The remedy runs on this collector, which the fleet knows by its device name.
    expect(encryption?.hint).toContain("restart the collector on collector-alpha");
  });

  test("reports fresh permission loss between syncs and leaves cached sync state untouched", async () => {
    let status: "readable" | "denied" = "readable";
    const sync = vi.fn();
    const probeReadAccess = vi.fn(async () => ({ status }));
    const cached = [
      {
        sourceId: "demo-files:local",
        providerId: "demo-files:local",
        sourceName: "Demo files",
        state: "idle" as const,
        lastSyncAt: "2026-01-01T00:00:00Z",
      },
    ];
    const before = structuredClone(cached);
    const { doctor, events } = makeDoctor({
      getSourceStatuses: () => cached,
      getReadAccessSources: () => [
        { sourceId: "demo-files:local", instance: { probeReadAccess, sync } },
      ],
    });
    doctor.start("access-first");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    status = "denied";
    doctor.start("access-revoked");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    status = "readable";
    doctor.start("access-restored");
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(
      events.map((event) => {
        if (!("report" in event)) throw new Error("expected report");
        return event.report.checks.find(
          (check) => check.id === "sources.read-access.demo-files:local",
        )?.status;
      }),
    ).toEqual(["pass", "warn", "pass"]);
    expect(probeReadAccess).toHaveBeenCalledTimes(3);
    expect(sync).not.toHaveBeenCalled();
    expect(cached).toEqual(before);
  });

  test("acknowledges immediately and emits an evaluated collector report", async () => {
    const { doctor, events } = makeDoctor();

    expect(doctor.start("run-1")).toEqual({ accepted: true });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({ runId: "run-1" });
    if (!("report" in events[0]!)) throw new Error("expected a report");
    expect(events[0].report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gateway.not-applicable", status: "not-applicable" }),
        expect.objectContaining({ id: "storage.disk", status: "pass" }),
        expect.objectContaining({ id: "sources.error.demo-files:local", status: "warn" }),
      ]),
    );
  });

  test("deduplicates an active run and refuses a different one", async () => {
    const gate = Promise.withResolvers<SecurityData>();
    const { doctor } = makeDoctor({ security: () => gate.promise });

    expect(doctor.start("run-1")).toEqual({ accepted: true });
    expect(doctor.start("run-1")).toEqual({ accepted: true });
    expect(doctor.start("run-2")).toMatchObject({ accepted: false });
    gate.resolve(SECURITY);
  });

  test("replays a completed result when the same durable run is redelivered", async () => {
    const { doctor, events } = makeDoctor();
    doctor.start("run-1");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(doctor.start("run-1")).toEqual({ accepted: true });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual(events[0]);
  });

  test("degrades a security-worker failure into a visible partial report", async () => {
    const { doctor, events } = makeDoctor({
      security: async () => {
        throw new Error("worker unavailable");
      },
    });
    doctor.start("run-1");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    if (!("report" in events[0]!)) throw new Error("expected a report");
    expect(events[0].report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "security.unavailable", status: "warn" }),
      ]),
    );
  });

  test("keeps the authenticated identity captured before a mid-scan disconnect", async () => {
    const gate = Promise.withResolvers<SecurityData>();
    let identity: ReturnType<GatewayWsClient["getIdentity"]> = {
      deviceId: "dev-collector",
      deviceName: "collector-alpha",
      deviceKind: "collector",
      protocolVersion: 1,
      scopes: ["write:*"],
    };
    const { doctor, events } = makeDoctor({
      security: () => gate.promise,
      getIdentity: () => identity,
    });

    doctor.start("run-identity");
    identity = null;
    gate.resolve(SECURITY);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    if (!("report" in events[0]!)) throw new Error("expected a report");
    expect(events[0].report.checks).toContainEqual(
      expect.objectContaining({ id: "auth.token", status: "pass" }),
    );
  });

  test("keeps a storage probe failure local and returns the remaining report", async () => {
    const { doctor, events } = makeDoctor({
      getSystemInfo: async () => {
        throw new Error("statfs /private/operator/path failed");
      },
    });

    doctor.start("run-storage");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    if (!("report" in events[0]!)) throw new Error("expected a report");
    expect(events[0].report.checks).toContainEqual(
      expect.objectContaining({ id: "storage.disk-unavailable", status: "warn" }),
    );
    expect(JSON.stringify(events[0])).not.toContain("/private/operator/path");
  });

  test("redacts absolute paths from evaluated security findings", async () => {
    const { doctor, events } = makeDoctor({
      security: async () => ({
        ...SECURITY,
        keyringAccess: {
          readable: false,
          path: "/private/operator/keyring",
          detail: "cannot read /private/operator/keyring",
        },
      }),
    });

    doctor.start("run-redacted");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(JSON.stringify(events[0])).not.toContain("/private/operator");
  });

  test("redacts a source remediation executable before emitting the report", async () => {
    const executable = "/private/example/bin/collector";
    const { doctor, events } = makeDoctor({
      getSourceStatuses: () => [
        {
          sourceId: "demo-files:local",
          providerId: "demo-files:local",
          sourceName: "Demo files",
          state: "error",
          remediation: {
            summary: `Grant access to ${executable}`,
            steps: [`Select ${executable} in system settings.`],
            executable,
            restartRequired: true,
          },
        },
      ],
    });

    doctor.start("run-remediation");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(JSON.stringify(events[0])).not.toContain(executable);
    expect(JSON.stringify(events[0])).toContain("<collector-executable>");
  });

  test("an outer run timeout aborts the provider probe without overlapping a retry", async () => {
    const pending = Promise.withResolvers<{ status: "readable" }>();
    let signal: AbortSignal | undefined;
    const instance = {
      probeReadAccess: vi.fn((options: { signal: AbortSignal }) => {
        signal = options.signal;
        return pending.promise;
      }),
    };
    const { doctor, events } = makeDoctor({
      runTimeoutMs: 20,
      getReadAccessSources: () => [{ sourceId: "demo-files:local", instance }],
    });
    expect(doctor.start("run-probe-timeout")).toEqual({ accepted: true });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ runId: "run-probe-timeout", error: expect.any(String) });
    expect(signal?.aborted).toBe(true);
    expect(doctor.start("run-probe-retry")).toEqual({ accepted: true });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(instance.probeReadAccess).toHaveBeenCalledTimes(1);
    expect(events[1]).toMatchObject({
      report: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "sources.read-access.demo-files:local",
            status: "warn",
          }),
        ]),
      },
    });
    pending.resolve({ status: "readable" });
  });

  test("releases a timed-out run so a later health check can start", async () => {
    const stuck = Promise.withResolvers<SystemInfoResult>();
    let probes = 0;
    const { doctor, events } = makeDoctor({
      runTimeoutMs: 20,
      getSystemInfo: async () => {
        probes += 1;
        if (probes === 1) return stuck.promise;
        return {
          platform: "linux",
          arch: "x64",
          totalRamGb: 16,
          freeRamGb: 8,
          modelsDir: "/tmp",
          modelsDirFreeGb: 20,
          dataDir: "/tmp",
          dataDirFreeGb: 20,
        };
      },
    });

    expect(doctor.start("run-stuck")).toEqual({ accepted: true });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ runId: "run-stuck", error: expect.any(String) });

    expect(doctor.start("run-next")).toEqual({ accepted: true });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ runId: "run-next", report: expect.any(Object) });
  });
});
