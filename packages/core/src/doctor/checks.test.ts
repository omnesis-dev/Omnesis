// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Doctor evaluator tests. All classification lives in the pure
 * `evaluateDoctor()`, so these tests feed hand-built `DoctorData` fixtures
 * straight into it and assert on the resulting JSON-shaped report — no
 * live gateway, no HTTP mocking needed. Both the `omnesis doctor` CLI and
 * the gateway's `/admin/doctor` route run this same evaluator, so these
 * assertions bind the verdicts both surfaces show.
 *
 * Fixture data is fictional per the repo's privacy rule (no corpus-derived
 * names, emails, or scenarios).
 */

import { describe, test, expect } from "vitest";
import { evaluateDoctor } from "./checks.js";
import { doctorReportSchema, MAX_DOCTOR_CHECKS } from "./schema.js";
import type { DoctorData, DoctorCheck } from "./types.js";
import type { InferenceOverview } from "../models/backends.js";

function findCheck(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((c) => c.id === id);
}

/** A fully-healthy inference overview: every required role available. */
function healthyInference(): InferenceOverview {
  return {
    backends: {},
    assignments: {
      embedder: {
        role: "embedder",
        kind: "local",
        catalogId: "nomic-embed-text-v1.5.Q8_0",
        modelPath: "/models/nomic-embed-text-v1.5.Q8_0.gguf",
        available: true,
      },
      agent: {
        role: "agent",
        kind: "anthropic",
        catalogId: "anthropic/claude-haiku",
        apiModelId: "claude-haiku-4-5",
        allowRemoteInference: true,
        available: true,
      },
      "privacy-reviewer": { role: "privacy-reviewer", kind: "disabled" },
      transcriber: { role: "transcriber", kind: "disabled" },
      ocr: { role: "ocr", kind: "disabled" },
      "background-agent": { role: "background-agent", kind: "disabled" },
      "watch-judge": { role: "watch-judge", kind: "disabled" },
      "entailment-verifier": { role: "entailment-verifier", kind: "disabled" },
      "brief-judge": { role: "brief-judge", kind: "disabled" },
    },
  };
}

/** Baseline fully-healthy bundle. Tests clone + mutate this. */
function healthyData(): DoctorData {
  return {
    target: "gateway",
    operationalChecks: true,
    health: { reachable: true },
    authError: false,
    whoami: {
      tokenId: "tok-0001",
      deviceId: "dev-cli",
      deviceName: "workstation-cli",
      scopes: ["admin", "read"],
    },
    config: { version: 7 },
    configStatus: { ok: true, version: 7, lastLoadedAt: 1, lastWrittenAt: 1, lastError: null },
    devices: [
      { id: "dev-cli", name: "workstation-cli", kind: "cli", online: false },
      { id: "dev-collector", name: "Studio collector", kind: "collector", online: true },
    ],
    sources: [
      {
        id: "demo-mail:user@example.com",
        type: "demo-mail",
        accountId: "user@example.com",
        deviceId: "dev-collector",
        enabled: true,
        lastSyncedAt: "2026-06-04T10:00:00.000Z",
      },
    ],
    syncStatus: [
      {
        sourceId: "demo-mail:user@example.com",
        state: "synced",
        lastSyncAt: "2026-06-04T10:00:00.000Z",
      },
    ],
    models: { inference: healthyInference() },
    systemInfo: {
      platform: "linux",
      arch: "arm64",
      totalRamGb: 120,
      freeRamGb: 80,
      modelsDir: "/models",
      modelsDirFreeGb: 200,
    },
    indexStats: {
      enabled: true,
      state: "running",
      model: { present: true, name: "nomic" },
      totalIndexed: 1000,
      totalChunks: 4000,
      totalGatewayDocs: 1000,
      watermark: "2026-06-04T10:00:00.000Z",
      bySource: {
        "demo-mail:user@example.com": {
          indexedDocs: 1000,
          gatewayDocs: 1000,
          chunks: 4000,
          percentIndexed: 100,
          earliestIndexedDate: "2026-01-01T00:00:00.000Z",
          latestIndexedDate: "2026-06-04T10:00:00.000Z",
        },
      },
    },
    overall: { dbSizeBytes: 1024 * 1024 * 50 },
    processVitals: {
      eventLoop: { current: { p50Ms: 2, p95Ms: 8, p99Ms: 20 } },
      memory: {
        current: {
          rssBytes: 1024 * 1024 * 400,
          heapUsedBytes: 1024 * 1024 * 200,
          heapTotalBytes: 1024 * 1024 * 400,
        },
      },
    },
    // Absent by default: a gateway without a sweep store reports no Sweeps
    // section at all, which is what most of these cases exercise.
    sweeps: null,
    security: null,
  };
}

test("successful syncs retain actionable nonfatal enumeration warnings", () => {
  const data = healthyData();
  data.syncStatus![0]!.issues = [
    {
      code: "snapshot-withheld",
      scope: "partition",
      kind: "unknown",
      count: 1,
      message: "Example enumeration incomplete",
      since: 1000,
      remediation: {
        summary: "Restore access",
        steps: ["Check the example folder permission."],
        restartRequired: false,
      },
    },
  ];
  const check = findCheck(
    evaluateDoctor(data).checks,
    "sources.sync-issue.demo-mail:user@example.com.0",
  );
  expect(check).toMatchObject({ status: "warn" });
  expect(JSON.stringify(check)).toContain("Example enumeration incomplete");
  expect(JSON.stringify(check)).toContain("1970-01-01T00:00:01.000Z");
  expect(JSON.stringify(check)).toContain("Check the example folder permission.");
  expect(data.syncStatus![0]!.state).toBe("synced");
});

describe("evaluateDoctor — unreachable gateway and the config dir's lock", () => {
  test("names a live owner and points at the service logs", () => {
    const data = healthyData();
    data.health = { reachable: false };
    data.gatewayLock = { pid: 4242, startedAt: "2026-03-01T08:00:00.000Z", alive: true };
    const reach = findCheck(evaluateDoctor(data).checks, "gateway.reachable");
    expect(reach?.status).toBe("fail");
    expect(reach?.message).toContain("PID 4242");
    expect(reach?.hint).toMatch(/service logs gateway/);
  });

  test("a stale lock reads as an absent gateway", () => {
    const data = healthyData();
    data.health = { reachable: false };
    data.gatewayLock = { pid: 4242, startedAt: "2026-03-01T08:00:00.000Z", alive: false };
    const reach = findCheck(evaluateDoctor(data).checks, "gateway.reachable");
    expect(reach?.status).toBe("fail");
    expect(reach?.message).toBe("Gateway is not reachable");
    expect(reach?.hint).toContain("A LAN address does not work away from home");
    expect(reach?.hint).toContain("tests only from the machine where it runs");
  });
});

function healthySecurityKeyring(): NonNullable<DoctorData["security"]>["keyring"] {
  return {
    keyName: "install-root-key-v1",
    store: {
      requestedBackend: "auto",
      backend: "secret-service",
      available: true,
      secure: true,
      detail: "secret service is available through `secret-tool`.",
      writeExposure: "stdin",
    },
    present: true,
    valid: true,
  };
}

function databaseEncryption(
  status: NonNullable<DoctorData["security"]>["databaseEncryption"]["status"] = "off",
): NonNullable<DoctorData["security"]>["databaseEncryption"] {
  return {
    status,
    detail:
      status === "on"
        ? "Wrapped storage keys exist for gateway, index, analytics, and provider stores."
        : "No wrapped live-storage keys are present.",
    required: status === "on",
    stores: ["main-db", "index-db", "analytics-db", "whatsapp-store"].map((keyName) => ({
      keyName,
      present: status === "on",
      valid: status === "on",
      encrypted: status === "on",
    })),
  };
}

function recoveryEscrow(
  status: NonNullable<DoctorData["security"]>["recoveryEscrow"]["status"] = "exported",
): NonNullable<DoctorData["security"]>["recoveryEscrow"] {
  return {
    status,
    detail:
      status === "exported"
        ? "A recovery escrow is present and well-formed."
        : status === "missing"
          ? "No recovery escrow has been exported."
          : "The recovery envelope is not a well-formed v1 escrow.",
    path: "/home/maya/.config/omnesis/keyring/recovery-envelope.json",
  };
}

function gatewayIsolation(
  status: NonNullable<DoctorData["security"]>["gatewayIsolation"]["status"] = "dedicated-user",
): NonNullable<DoctorData["security"]>["gatewayIsolation"] {
  return {
    status,
    detail:
      status === "dedicated-user"
        ? "The system-level gateway unit uses DynamicUser= (/etc/systemd/system/omnesis-gateway.service)."
        : status === "login-user"
          ? "The gateway runs from a user-level systemd unit, i.e. as the login user."
          : "No gateway service unit was found.",
    systemUnitPath: "/etc/systemd/system/omnesis-gateway.service",
  };
}

/** Central healthy SecurityData fixture; tests override the slice under test. */
function securityData(
  overrides: Partial<NonNullable<DoctorData["security"]>> = {},
): NonNullable<DoctorData["security"]> {
  return {
    configDir: "/home/maya/.config/omnesis",
    fixPermissions: false,
    permissionScanTruncated: false,
    permissionEntries: [],
    diskEncryption: { platform: "linux", status: "on", detail: "Encrypted-looking mount" },
    serviceUnits: [],
    gatewayIsolation: gatewayIsolation(),
    keyring: healthySecurityKeyring(),
    keyringAccess: { readable: true },
    keyringWiring: [],
    recoveryEscrow: recoveryEscrow(),
    databaseEncryption: databaseEncryption(),
    ...overrides,
  };
}

describe("evaluateDoctor — healthy setup", () => {
  test("yields ok:true with zero errors", () => {
    const report = evaluateDoctor(healthyData());
    expect(report.ok).toBe(true);
    expect(report.summary.errors).toBe(0);
  });

  test("has no warnings for a pristine setup", () => {
    const report = evaluateDoctor(healthyData());
    expect(report.summary.warnings).toBe(0);
    // Every check passes.
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("passing checks carry no remediation hint", () => {
    const report = evaluateDoctor(healthyData());
    for (const c of report.checks) {
      if (c.status === "pass") expect(c.hint).toBeUndefined();
    }
  });
});

describe("evaluateDoctor — the served certificate", () => {
  const tls = {
    checkedAt: "2026-09-14T00:00:00.000Z",
    ownership: "self-signed" as const,
    certPath: "/srv/omnesis/tls/cert.pem",
    keyPath: "/srv/omnesis/tls/key.pem",
    served: {
      state: "expired" as const,
      fingerprintSha256: "ab".repeat(32),
      subject: "CN=gateway (self-signed)",
      issuer: "CN=gateway (self-signed)",
      selfSigned: true,
      notBefore: "2016-09-01T00:00:00.000Z",
      notAfter: "2026-09-01T00:00:00.000Z",
      daysRemaining: -13,
      names: ["localhost"],
      uncoveredHosts: [],
    },
    pendingReplacement: null,
    renewal: {
      mode: "automatic" as const,
      renewBeforeDays: 30,
      lastAttemptAt: "2026-09-14T03:00:00.000Z",
      lastError: "openssl is not installed",
      lastRenewedAt: null,
    },
    rotation: null,
  };

  test("an expired certificate the gateway could not renew fails the report on the gateway target", () => {
    const report = evaluateDoctor({
      ...healthyData(),
      overall: { dbSizeBytes: null, tls },
    });
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.id === "gateway.tls");
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/expired 13 days ago/u);
    expect(check?.hint).toMatch(/openssl is not installed/u);
  });

  test("a failed renewal beside an expired certificate is one failing check, not two", () => {
    const report = evaluateDoctor({ ...healthyData(), overall: { dbSizeBytes: null, tls } });
    expect(report.checks.filter((c) => c.id.startsWith("gateway.tls")).map((c) => c.id)).toEqual([
      "gateway.tls",
    ]);
  });

  test("a phone paired before a self-signed rotation and silent since is named for repair", () => {
    const rotatedAt = "2026-09-10T00:00:00.000Z";
    const report = evaluateDoctor({
      ...healthyData(),
      devices: [
        {
          id: "dev-phone",
          name: "old-phone",
          kind: "ios",
          online: false,
          pairedAt: Date.parse(rotatedAt) - 1000,
          lastSeenAt: null,
        },
      ],
      overall: {
        dbSizeBytes: null,
        tls: {
          ...tls,
          served: { ...tls.served, state: "valid" as const, daysRemaining: 3000 },
          renewal: { ...tls.renewal, lastError: null },
          rotation: { previousFingerprintSha256: "cd".repeat(32), rotatedAt },
        },
      },
    });
    const repair = report.checks.find((c) => c.id === "fleet.tls-pin-repair");
    expect(repair?.status).toBe("warn");
    expect(repair?.hint).toMatch(/omnesis devices repair old-phone/u);
  });

  test("a gateway that predates the lifecycle adds no certificate check", () => {
    const report = evaluateDoctor({ ...healthyData(), overall: { dbSizeBytes: null } });
    expect(report.checks.some((c) => c.id.startsWith("gateway.tls"))).toBe(false);
  });

  test("a collector's report never evaluates the gateway's certificate", () => {
    const report = evaluateDoctor({
      ...healthyData(),
      target: "collector",
      overall: { dbSizeBytes: null, tls },
    });
    expect(report.checks.some((c) => c.id.startsWith("gateway.tls"))).toBe(false);
  });
});

describe("evaluateDoctor — collector host", () => {
  function collectorData(): DoctorData {
    const base = healthyData();
    return {
      ...base,
      target: "collector",
      sourceReadAccess: [],
      operationalChecks: true,
      health: { reachable: false },
      sources: null,
      devices: null,
      models: null,
      indexStats: null,
      overall: null,
      sweeps: null,
      systemInfo: {
        ...base.systemInfo!,
        dataDir: "/home/maya/.config/omnesis",
        dataDirFreeGb: 200,
      },
      security: securityData({
        serviceUnits: [],
        gatewayIsolation: {
          status: "not-applicable",
          detail: "Gateway process isolation is outside a collector host audit.",
          systemUnitPath: null,
        },
        databaseEncryption: {
          status: "on",
          detail: "Wrapped storage keys exist for every store this host opens.",
          required: true,
          stores: [
            { keyName: "whatsapp-store", present: true, valid: true, encrypted: true },
            { keyName: "imessage-transcripts", present: true, valid: true, encrypted: true },
          ],
        },
      }),
      localStores: [
        {
          sourceId: "whatsapp:+15550100001",
          keyName: "whatsapp-store",
          label: "WhatsApp message archive",
          state: "encrypted",
        },
      ],
      host: "studio-mini",
    };
  }

  test("runs local checks and marks gateway-only concerns not applicable", () => {
    const report = evaluateDoctor(collectorData());

    expect(findCheck(report.checks, "auth.token")?.status).toBe("pass");
    expect(findCheck(report.checks, "config.load")?.status).toBe("pass");
    expect(findCheck(report.checks, "process.eventloop")?.status).toBe("pass");
    expect(findCheck(report.checks, "sources.healthy")?.status).toBe("pass");
    expect(findCheck(report.checks, "storage.disk")?.status).toBe("pass");
    expect(findCheck(report.checks, "storage.db")?.status).toBe("not-applicable");
    expect(findCheck(report.checks, "security.gateway-isolation")?.status).toBe("not-applicable");
    expect(findCheck(report.checks, "security.database-encryption")).toMatchObject({
      status: "pass",
      message: "Collector provider-store encryption is enabled (1 encrypted store verified)",
    });
    expect(findCheck(report.checks, "gateway.reachable")).toBeUndefined();
    expect(findCheck(report.checks, "sources.device-inventory-unavailable")).toBeUndefined();
    expect(report.summary).toEqual({ errors: 0, warnings: 0 });
    expect(report.ok).toBe(true);
    expect(
      report.checks
        .filter((check) => check.status === "not-applicable")
        .every((check) => !check.hint),
    ).toBe(true);
  });

  test("a collector's remedies name the host they run on", () => {
    const data = collectorData();
    data.security!.permissionEntries = [
      {
        path: "token",
        relativePath: "token",
        kind: "file",
        expectedMode: 0o600,
        actualMode: 0o644,
        ok: false,
        fixed: false,
      },
    ];
    data.security!.recoveryEscrow = { status: "missing", detail: "not exported", path: "x" };
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.permissions")?.hint).toContain(
      "`omnesis doctor --fix-permissions` on studio-mini",
    );
    const escrow = findCheck(report.checks, "security.recovery-escrow");
    expect(escrow?.hint).toContain("this collector's encrypted provider stores");
    expect(escrow?.hint).toContain("export-recovery` on studio-mini");
    expect(escrow?.hint).not.toContain("encrypted backup");
  });

  test("a collector store still in plaintext beside its key is a finding, not a green inventory", () => {
    const data = collectorData();
    data.localStores = [
      {
        sourceId: "whatsapp:+15550100001",
        keyName: "whatsapp-store",
        label: "WhatsApp message archive",
        state: "plaintext",
      },
    ];
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.database-encryption")).toMatchObject({
      status: "warn",
      message:
        "1 store is still plaintext on disk: WhatsApp message archive (whatsapp:+15550100001)",
    });
    expect(findCheck(report.checks, "security.database-encryption")?.hint).toContain(
      "restart the collector on studio-mini",
    );
  });

  test("a collector store that does not open with the host's key fails the check", () => {
    const data = collectorData();
    data.localStores = [
      {
        sourceId: "apple-imessage",
        keyName: "imessage-transcripts",
        label: "iMessage transcript cache",
        state: "unverifiable",
        detail: "It did not open with this host's key.",
      },
    ];
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.database-encryption")).toMatchObject({
      status: "fail",
      message:
        "1 encrypted store did not open with this host's key: iMessage transcript cache (apple-imessage)",
    });
    expect(report.ok).toBe(false);
  });

  test("a collector whose root key is unavailable is blocked, never green", () => {
    const data = collectorData();
    data.security!.databaseEncryption = {
      status: "blocked",
      detail: "Live storage encryption is required, but the install root key is unavailable.",
      required: true,
      stores: [],
    };
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.database-encryption")).toMatchObject({
      status: "fail",
      message: "Collector provider-store encryption is required but the root key is unavailable",
    });
  });

  test("a collector without encryption names the collector-side remedy", () => {
    const data = collectorData();
    data.security!.databaseEncryption = {
      status: "off",
      detail: "No wrapped live-storage keys are present.",
      required: false,
      stores: [],
    };
    data.localStores = [
      {
        sourceId: "whatsapp:+15550100001",
        keyName: "whatsapp-store",
        label: "WhatsApp message archive",
        state: "plaintext",
      },
    ];
    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "security.database-encryption");
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe("Collector provider-store encryption is not enabled");
    expect(check?.hint).toContain("1 store is plaintext on disk");
    expect(check?.hint).toContain(
      "`omnesis keyring init` on studio-mini and restart the collector",
    );
  });

  test("keeps fresh access evidence separate from cached sync results", () => {
    const data = collectorData();
    data.sourceReadAccess = [
      { sourceId: "demo-files:readable", status: "readable" },
      { sourceId: "demo-files:denied", status: "denied" },
      { sourceId: "demo-files:missing", status: "unavailable" },
      { sourceId: "demo-cloud:local", status: "unsupported" },
    ];
    const checks = evaluateDoctor(data).checks;
    expect(findCheck(checks, "sources.healthy")?.message).not.toContain("healthy");
    expect(findCheck(checks, "sources.read-access.demo-files:readable")?.status).toBe("pass");
    expect(findCheck(checks, "sources.read-access.demo-files:denied")?.status).toBe("warn");
    expect(findCheck(checks, "sources.read-access.demo-files:missing")?.status).toBe("warn");
    expect(findCheck(checks, "sources.read-access.demo-cloud:local")?.status).toBe(
      "not-applicable",
    );
    delete data.sourceReadAccess;
    expect(findCheck(evaluateDoctor(data).checks, "sources.read-access-unavailable")?.status).toBe(
      "warn",
    );
  });

  test("reports local source and disk failures without inventing gateway findings", () => {
    const data = collectorData();
    data.syncStatus = [
      {
        sourceId: "demo-files:local",
        state: "error",
        lastSyncAt: null,
        errorMessage: "fixture directory unavailable",
      },
    ];
    data.systemInfo = { ...data.systemInfo!, dataDirFreeGb: 1 };

    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "sources.error.demo-files:local")?.status).toBe("warn");
    expect(findCheck(report.checks, "storage.disk")?.status).toBe("warn");
    expect(findCheck(report.checks, "models.not-applicable")?.status).toBe("not-applicable");
    expect(report.summary).toEqual({ errors: 0, warnings: 2 });
  });

  test("bounds a large local report without hiding the omitted severity", () => {
    const data = collectorData();
    data.syncStatus = Array.from({ length: 600 }, (_, index) => ({
      sourceId: `demo-files:fixture-${index}`,
      state: "error" as const,
      lastSyncAt: null,
      errorMessage: "fixture directory unavailable",
    }));

    const report = evaluateDoctor(data);
    expect(report.checks).toHaveLength(MAX_DOCTOR_CHECKS);
    expect(report.checks.at(-1)).toMatchObject({ id: "doctor.truncated", status: "warn" });
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(doctorReportSchema.safeParse(report).success).toBe(true);
  });

  test("normalizes line separators and bidi controls from local findings", () => {
    const data = collectorData();
    data.syncStatus = [
      {
        sourceId: "demo-files:\u2028fixture\u061c",
        state: "error",
        lastSyncAt: null,
        errorMessage: "unavailable\u200f",
      },
    ];

    const report = evaluateDoctor(data);
    expect(doctorReportSchema.safeParse(report).success).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/[\p{Zl}\p{Zp}\p{Bidi_Control}]/u);
  });
});

describe("evaluateDoctor — fleet versions", () => {
  test("reports the fleet without faulting anything when every device is current", () => {
    const data = healthyData();
    data.health = { reachable: true, version: "1.4.0" };
    data.devices = [
      { id: "d1", name: "workstation-cli", kind: "cli", online: false, versionState: "current" },
      {
        id: "d2",
        name: "Studio collector",
        kind: "collector",
        online: true,
        versionState: "current",
      },
    ];
    const check = findCheck(evaluateDoctor(data).checks, "fleet.versions");
    expect(check?.status).toBe("pass");
    expect(check?.section).toBe("Fleet");
    expect(check?.message).toContain("2 current");
  });

  test("a behind device is informational and named, never a failure", () => {
    const data = healthyData();
    data.devices = [
      { id: "d1", name: "workstation-cli", kind: "cli", online: false, versionState: "current" },
      {
        id: "d2",
        name: "Maya's phone",
        kind: "ios",
        online: true,
        version: "1.3.0",
        versionState: "behind",
      },
    ];
    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "fleet.versions");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("Maya's phone (1.3.0)");
    // Nothing about a lagging build may be a warning of its own.
    expect(check?.hint).toBeUndefined();
    expect(report.summary.errors).toBe(0);
  });

  test("an unsupported device fails and says which build has to move", () => {
    const data = healthyData();
    data.devices = [
      { id: "d1", name: "workstation-cli", kind: "cli", online: false, versionState: "current" },
      {
        id: "d2",
        name: "Attic collector",
        kind: "collector",
        online: false,
        version: "0.9.0",
        versionState: "unsupported",
      },
    ];
    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "fleet.versions");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("Attic collector (0.9.0)");
    expect(check?.hint).toBeTruthy();
    expect(report.ok).toBe(false);
  });

  test("a device that never reported a version is counted, never faulted", () => {
    const data = healthyData();
    data.devices = [
      { id: "d1", name: "workstation-cli", kind: "cli", online: false, versionState: "unknown" },
      // A gateway that predates the ledger serves no state at all; an absent
      // reading must land in the same neutral bucket as an explicit unknown.
      { id: "d2", name: "Legacy host", kind: "collector", online: false },
    ];
    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "fleet.versions");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("2 unknown");
    expect(report.summary.errors).toBe(0);
  });

  test("a revoked device's stale reading is left out of the count", () => {
    const data = healthyData();
    data.devices = [
      { id: "d1", name: "workstation-cli", kind: "cli", online: false, versionState: "current" },
      {
        id: "d2",
        name: "Retired laptop",
        kind: "collector",
        online: false,
        revokedAt: 1,
        version: "0.9.0",
        versionState: "unsupported",
      },
    ];
    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "fleet.versions");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("1 current");
    expect(report.ok).toBe(true);
  });

  test("says nothing at all when the device list could not be read", () => {
    const data = healthyData();
    data.devices = null;
    expect(findCheck(evaluateDoctor(data).checks, "fleet.versions")).toBeUndefined();
  });
});

describe("evaluateDoctor — the gateway's two version numbers", () => {
  test("the config revision and the product version are separate checks", () => {
    const data = healthyData();
    data.health = { reachable: true, version: "1.4.0" };
    const checks = evaluateDoctor(data).checks;

    // The old id conflated the two; nothing may still answer to it.
    expect(findCheck(checks, "gateway.version")).toBeUndefined();
    expect(findCheck(checks, "gateway.config-revision")?.message).toContain("revision 7");
    expect(findCheck(checks, "gateway.product-version")?.message).toContain("1.4.0");
  });

  test("omits the product version when the gateway did not report one", () => {
    const data = healthyData();
    expect(findCheck(evaluateDoctor(data).checks, "gateway.product-version")).toBeUndefined();
  });

  test("warns when the last successful release check found a newer version", () => {
    const data = healthyData();
    data.overall!.release = {
      currentVersion: "1.4.0",
      latestVersion: "1.5.0",
      installMethod: "source",
      checkedAt: "2026-09-07T12:00:00.000Z",
      updateAvailable: true,
    };

    const check = findCheck(evaluateDoctor(data).checks, "gateway.release");
    expect(check).toMatchObject({
      status: "warn",
      message: "Omnesis 1.5.0 is available (gateway runs 1.4.0)",
      hint: "Run `omnesis update` on the gateway host when you are ready.",
    });
  });

  test("passes when the last successful release check found no newer version", () => {
    const data = healthyData();
    data.overall!.release = {
      currentVersion: "1.5.0",
      latestVersion: "1.5.0",
      installMethod: "npm-global",
      checkedAt: "2026-09-07T12:00:00.000Z",
      updateAvailable: false,
    };

    const check = findCheck(evaluateDoctor(data).checks, "gateway.release");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("latest stable release");
  });

  test("omits missing or internally inconsistent release-check data", () => {
    const missing = healthyData();
    missing.overall!.release = null;
    expect(findCheck(evaluateDoctor(missing).checks, "gateway.release")).toBeUndefined();

    const inconsistent = healthyData();
    inconsistent.overall!.release = {
      currentVersion: "1.4.0",
      latestVersion: "1.5.0",
      installMethod: "docker",
      checkedAt: "2026-09-07T12:00:00.000Z",
      updateAvailable: false,
    };
    expect(findCheck(evaluateDoctor(inconsistent).checks, "gateway.release")).toBeUndefined();
  });
});

describe("evaluateDoctor — invalid token", () => {
  test("token rejection (401/403) is a FAIL and short-circuits the auth section", () => {
    const data = healthyData();
    data.authError = true;
    data.whoami = null;
    const report = evaluateDoctor(data);

    const authCheck = findCheck(report.checks, "auth.token");
    expect(authCheck?.status).toBe("fail");
    expect(authCheck?.hint).toBeTruthy();
    expect(report.ok).toBe(false);
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);
  });

  test("gateway unreachable fails fast and emits no post-gateway checks", () => {
    const data = healthyData();
    data.health = { reachable: false };
    const report = evaluateDoctor(data);

    expect(report.ok).toBe(false);
    const reach = findCheck(report.checks, "gateway.reachable");
    expect(reach?.status).toBe("fail");
    // No auth/model/etc. checks once the gateway is down.
    expect(findCheck(report.checks, "auth.token")).toBeUndefined();
    expect(findCheck(report.checks, "models.embedder")).toBeUndefined();
  });
});

describe("evaluateDoctor — device identity", () => {
  test("reports an offline CLI caller without inferring health from its WebSocket presence", () => {
    const report = evaluateDoctor(healthyData());

    expect(findCheck(report.checks, "auth.device")?.status).toBe("pass");
    expect(findCheck(report.checks, "auth.device.online")).toBeUndefined();
    expect(findCheck(report.checks, "sources.healthy")?.status).toBe("pass");
  });

  test("does not infer source health from a collector WebSocket snapshot", () => {
    const data = healthyData();
    data.devices!.find((device) => device.kind === "collector")!.online = false;

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.healthy")?.status).toBe("pass");
  });

  test("reports never-synced work even when its collector socket is disconnected", () => {
    const data = healthyData();
    data.devices!.find((device) => device.kind === "collector")!.online = false;
    data.sources![0].lastSyncedAt = null;
    data.syncStatus![0].lastSyncAt = null;

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.never-synced")?.status).toBe("warn");
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
  });

  test("does not require a live socket for push-only work", () => {
    const data = healthyData();
    data.devices!.find((device) => device.kind === "collector")!.online = false;
    data.sources![0].pushBased = true;

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.healthy")?.status).toBe("pass");
  });

  test("reports unknown device inventory instead of assuming pull-work hosts are valid", () => {
    const data = healthyData();
    data.devices = null;

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.device-inventory-unavailable")).toMatchObject({
      status: "warn",
    });
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
  });

  test("warns when an enabled pull source is assigned to a non-collector device", () => {
    const data = healthyData();
    data.sources![0].deviceId = "dev-cli";

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.collector-host-invalid.dev-cli")).toMatchObject({
      status: "warn",
    });
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
  });

  test("warns when an enabled pull source references a missing device", () => {
    const data = healthyData();
    data.sources![0].deviceId = "dev-missing";

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.collector-host-missing.dev-missing")).toMatchObject({
      status: "warn",
    });
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
  });
});

describe("evaluateDoctor — missing embedder", () => {
  test("unavailable embedder is a FAIL, agent unavailability is a WARN, and transcriber is ignored", () => {
    const data = healthyData();
    const inf = data.models!.inference;
    inf.assignments.embedder = {
      role: "embedder",
      kind: "local",
      catalogId: "nomic-embed-text-v1.5.Q8_0",
      modelPath: "/models/nomic-embed-text-v1.5.Q8_0.gguf",
      available: false,
      reason: "model file missing",
    };
    inf.assignments.transcriber = { role: "transcriber", kind: "disabled" };
    inf.assignments.agent = { role: "agent", kind: "disabled" };

    const report = evaluateDoctor(data);

    const emb = findCheck(report.checks, "models.embedder");
    expect(emb?.status).toBe("fail");
    expect(emb?.message).toContain("not available");

    expect(findCheck(report.checks, "models.transcriber")).toBeUndefined();
    expect(findCheck(report.checks, "models.agent")?.status).toBe("warn");

    expect(report.ok).toBe(false);
    expect(report.summary.errors).toBe(1);
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
  });
});

describe("evaluateDoctor — Codex runtime maintenance", () => {
  test("warns with the gateway update command when a tested runtime is available", () => {
    const data = healthyData();
    data.models!.inference.codex = {
      type: "codex",
      configured: true,
      status: "ok",
      loggedIn: true,
      models: ["gpt-example-frontier"],
      runtimeUpdate: {
        state: "update-available",
        action: "update",
        currentVersion: "0.142.4",
        targetVersion: "0.151.0",
        canUpdate: true,
        preservesLogin: true,
        preservesAssignments: true,
        requiresGatewayRestart: false,
      },
    };

    expect(findCheck(evaluateDoctor(data).checks, "models.codex-runtime")).toMatchObject({
      status: "warn",
      hint: "Install the tested runtime with `omnesis codex update --yes`.",
    });
  });

  test("reports an override as externally managed without offering a gateway mutation", () => {
    const data = healthyData();
    data.models!.inference.codex = {
      type: "codex",
      configured: true,
      status: "ok",
      loggedIn: true,
      models: ["gpt-example-frontier"],
      runtimeUpdate: {
        state: "externally-managed",
        action: "external",
        currentVersion: "0.151.0",
        targetVersion: "0.151.0",
        canUpdate: false,
        preservesLogin: true,
        preservesAssignments: true,
        requiresGatewayRestart: false,
      },
    };

    expect(findCheck(evaluateDoctor(data).checks, "models.codex-runtime")).toMatchObject({
      status: "pass",
      message: "Codex runtime is managed outside Omnesis",
    });
  });

  test("distinguishes a repair from an ordinary runtime update", () => {
    const data = healthyData();
    data.models!.inference.codex = {
      type: "codex",
      configured: true,
      status: "unreachable",
      loggedIn: false,
      models: [],
      runtimeUpdate: {
        state: "repair-needed",
        action: "repair",
        targetVersion: "0.151.0",
        canUpdate: true,
        preservesLogin: true,
        preservesAssignments: true,
        requiresGatewayRestart: false,
        reason: "The selected generation is missing.",
      },
    };

    expect(findCheck(evaluateDoctor(data).checks, "models.codex-runtime")).toMatchObject({
      status: "warn",
      message: "Codex runtime needs repair",
      hint: "Repair the gateway-owned runtime with `omnesis codex update --yes`.",
    });
  });
});

describe("evaluateDoctor — sources needing re-auth", () => {
  test("warns with the capability remediation for degraded phone permissions", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "fictional-mobile:local",
        state: "background-access-missing",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
        permissionHealth: {
          state: "background-access-missing",
          reportStale: false,
          validUntil: Date.now() + 60_000,
          capabilities: [
            {
              id: "background-access",
              label: "Background access",
              state: "background-access-missing",
              requirement: "required",
              impact: "Collection stops while closed.",
              remediation: "Enable background access in system Settings.",
              repairAction: "open-system-settings",
            },
          ],
        },
      },
    ];
    const check = findCheck(
      evaluateDoctor(data).checks,
      "sources.permission.fictional-mobile:local",
    );
    expect(check).toMatchObject({
      status: "warn",
      hint: "Enable background access in system Settings.",
    });
  });

  test("warns when a phone permission report is overdue without treating it as degradation", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "fictional-mobile:local",
        state: "synced",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
        permissionHealth: {
          state: "unknown",
          reportStale: true,
          validUntil: 1,
          capabilities: [],
        },
      },
    ];
    const checks = evaluateDoctor(data).checks;
    expect(findCheck(checks, "sources.permission-overdue.fictional-mobile:local")?.status).toBe(
      "warn",
    );
    expect(findCheck(checks, "sources.permission.fictional-mobile:local")).toBeUndefined();
  });

  test("a needs-auth source is a WARN with a reauth hint and does not flip ok", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "demo-mail:user@example.com",
        state: "needs-auth",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
        errorMessage: "token expired",
      },
    ];
    const report = evaluateDoctor(data);

    const reauth = findCheck(report.checks, "sources.needs-auth");
    expect(reauth?.status).toBe("warn");
    expect(reauth?.hint?.toLowerCase()).toContain("reauth");
    // Warning only — core functionality still works.
    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
  });

  // `auth-expiring` is forward-looking: the source is still syncing, but
  // consent lapses soon. Reported apart from `needs-auth` because acting on
  // it prevents an outage rather than recovering from one.
  test("an auth-expiring source warns separately from needs-auth", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "demo-mail:user@example.com",
        state: "auth-expiring",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    const report = evaluateDoctor(data);

    const expiring = findCheck(report.checks, "sources.auth-expiring");
    expect(expiring?.status).toBe("warn");
    expect(expiring?.message).toContain("demo-mail:user@example.com");
    expect(expiring?.hint?.toLowerCase()).toContain("before the deadline");
    // Not the reactive check — the source is not broken yet.
    expect(findCheck(report.checks, "sources.needs-auth")).toBeUndefined();
    // And it withholds the all-clear.
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  test("a stale source warns without also receiving the all-clear", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "demo-mail:user@example.com",
        state: "stale",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
        staleHint: "Open the local data app to resume updates.",
      },
    ];

    const report = evaluateDoctor(data);

    const stale = findCheck(report.checks, "sources.stale.demo-mail:user@example.com");
    expect(stale?.status).toBe("warn");
    expect(stale?.hint).toBe("Open the local data app to resume updates.");
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  test("a replicated source with deletions in dispute warns, names the count, and withholds the all-clear", () => {
    const data = healthyData();
    data.sources![0]!.disputedDeletions = 2;

    const report = evaluateDoctor(data);

    const dispute = findCheck(report.checks, "sources.replica-dispute.demo-mail:user@example.com");
    expect(dispute?.status).toBe("warn");
    expect(dispute?.message).toContain("2 item(s)");
    expect(dispute?.hint).toContain("delete the item from the corpus");
    expect(findCheck(report.checks, "sources.healthy")).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  test("a rate-limited source is throttled, not unhealthy", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "demo-mail:user@example.com",
        state: "rate-limited",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "sources.healthy")?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  test("a source in error state warns and surfaces the error message", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "demo-mail:user@example.com",
        state: "error",
        lastSyncAt: "2026-06-01T00:00:00.000Z",
        errorMessage: "connection refused",
      },
    ];
    const report = evaluateDoctor(data);
    const err = findCheck(report.checks, "sources.error.demo-mail:user@example.com");
    expect(err?.status).toBe("warn");
    expect(err?.message).toContain("connection refused");
    expect(report.ok).toBe(true);
  });

  test("a source whose error names its remedy is reported as that remedy", () => {
    const data = healthyData();
    data.syncStatus = [
      {
        sourceId: "demo-notes:local",
        state: "error",
        lastSyncAt: null,
        errorMessage: "Cannot open the database — disk access is required.",
        remediation: {
          summary: "Disk access is required",
          steps: ["Open the pane.", "Add the executable."],
          executable: "/opt/example/bin/node",
          restartRequired: true,
        },
      },
    ];
    const report = evaluateDoctor(data);
    const err = findCheck(report.checks, "sources.error.demo-notes:local");
    expect(err?.status).toBe("warn");
    expect(err?.message).toContain("Disk access is required");
    expect(err?.hint).toContain("/opt/example/bin/node");
    expect(err?.hint).toContain("restart the collector");
    expect(err?.hint).not.toContain("sources debug");
  });
});

describe("evaluateDoctor — sources that have never synced", () => {
  test("does not warn for an enabled push-based source", () => {
    const data = healthyData();
    data.sources = [
      {
        id: "push-capture",
        type: "push-capture",
        accountId: "local",
        deviceId: "dev-collector",
        enabled: true,
        pushBased: true,
        lastSyncedAt: null,
      },
    ];
    data.syncStatus = [];

    const report = evaluateDoctor(data);

    expect(findCheck(report.checks, "sources.never-synced")).toBeUndefined();
    expect(findCheck(report.checks, "sources.healthy")?.status).toBe("pass");
  });

  test("still warns for an enabled pull source while excluding push-based sources", () => {
    const data = healthyData();
    data.sources = [
      {
        id: "pull-mail:user@example.com",
        type: "pull-mail",
        accountId: "user@example.com",
        deviceId: "dev-collector",
        enabled: true,
        pushBased: false,
        lastSyncedAt: null,
      },
      {
        id: "push-capture",
        type: "push-capture",
        accountId: "local",
        deviceId: "dev-0001",
        enabled: true,
        pushBased: true,
        lastSyncedAt: null,
      },
    ];
    data.syncStatus = [];

    const check = findCheck(evaluateDoctor(data).checks, "sources.never-synced");

    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("1 enabled source(s) have never synced");
    expect(check?.message).toContain("pull-mail:user@example.com");
    expect(check?.message).not.toContain("push-capture");
  });
});

describe("evaluateDoctor — index + storage + config + process thresholds", () => {
  test("index backlog over 20% warns", () => {
    const data = healthyData();
    data.indexStats!.totalIndexed = 500;
    data.indexStats!.totalGatewayDocs = 1000; // 50% backlog
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "index.backlog")?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  test("missing index model file is a FAIL", () => {
    const data = healthyData();
    data.indexStats = { enabled: false, state: "model-missing", model: { present: false } };
    const report = evaluateDoctor(data);
    const m = findCheck(report.checks, "index.model");
    expect(m?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  test("low models-dir free space warns", () => {
    const data = healthyData();
    data.systemInfo!.modelsDirFreeGb = 2;
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "storage.disk")?.status).toBe("warn");
  });

  test("config load error is a FAIL", () => {
    const data = healthyData();
    data.configStatus = {
      ok: false,
      version: 7,
      lastLoadedAt: 1,
      lastWrittenAt: 1,
      lastError: { at: 2, message: "invalid JSON: unexpected token" },
    };
    const report = evaluateDoctor(data);
    const cfg = findCheck(report.checks, "config.load");
    expect(cfg?.status).toBe("fail");
    expect(cfg?.message).toContain("invalid JSON");
    expect(report.ok).toBe(false);
  });

  test("high event-loop lag warns", () => {
    const data = healthyData();
    data.processVitals!.eventLoop = { current: { p50Ms: 50, p95Ms: 500, p99Ms: 900 } };
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "process.eventloop")?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  test("heap pressure warns", () => {
    const data = healthyData();
    data.processVitals!.memory = {
      current: {
        rssBytes: 1024 * 1024 * 900,
        heapUsedBytes: 1024 * 1024 * 950,
        heapTotalBytes: 1024 * 1024 * 1000,
      },
    };
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "process.memory")?.status).toBe("warn");
  });
});

describe("evaluateDoctor — graceful degradation when endpoints are missing", () => {
  test("missing admin slots warn but do not crash or flip ok on their own", () => {
    const data = healthyData();
    data.models = null;
    data.sources = null;
    data.indexStats = null;
    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "models.unavailable")?.status).toBe("warn");
    expect(findCheck(report.checks, "sources.unavailable")?.status).toBe("warn");
    expect(findCheck(report.checks, "index.unavailable")?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });
});

describe("evaluateDoctor — local security posture", () => {
  test("security-only data does not emit gateway/auth checks", () => {
    const data = healthyData();
    data.operationalChecks = false;
    data.security = securityData({
      permissionEntries: [
        {
          path: "/home/maya/.config/omnesis",
          relativePath: ".",
          kind: "directory",
          expectedMode: 0o700,
          actualMode: 0o700,
          ok: true,
          fixed: false,
        },
      ],
      serviceUnits: [
        {
          component: "gateway",
          platform: "linux",
          path: "/home/maya/.config/systemd/user/omnesis-gateway.service",
          installed: true,
          directives: [{ key: "UMask", expected: "0077", actual: "0077", ok: true }],
        },
      ],
    });

    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "gateway.reachable")).toBeUndefined();
    expect(findCheck(report.checks, "auth.token")).toBeUndefined();
    expect(findCheck(report.checks, "security.permissions")?.status).toBe("pass");
    expect(findCheck(report.checks, "security.database-encryption")?.status).toBe("warn");
  });

  test("over-broad permissions are a FAIL with fix hint", () => {
    const data = healthyData();
    data.security = securityData({
      permissionEntries: [
        {
          path: "/home/maya/.config/omnesis/token",
          relativePath: "token",
          kind: "file",
          expectedMode: 0o600,
          actualMode: 0o644,
          ok: false,
          fixed: false,
        },
      ],
      diskEncryption: { platform: "linux", status: "unknown", detail: "not obviously LUKS" },
    });

    const report = evaluateDoctor(data);
    const perm = findCheck(report.checks, "security.permissions");
    expect(perm?.status).toBe("fail");
    expect(perm?.hint).toContain("--fix-permissions");
    expect(report.ok).toBe(false);
  });

  test("shows special permission bits rather than reporting identical actual and expected modes", () => {
    const data = healthyData();
    data.security = securityData({
      permissionEntries: [
        {
          path: "/tmp/omnesis-doctor-fixture/codex-home/.tmp/plugins/plugins/example/bin/tool",
          relativePath: "codex-home/.tmp/plugins/plugins/example/bin/tool",
          kind: "file",
          expectedMode: 0o700,
          actualMode: 0o4700,
          ok: false,
          fixed: false,
        },
      ],
    });
    const check = findCheck(evaluateDoctor(data).checks, "security.permissions");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("04700, expected 0700");
  });

  test("fixed permission entries pass and mention repairs", () => {
    const data = healthyData();
    data.security = securityData({
      fixPermissions: true,
      permissionEntries: [
        {
          path: "/home/maya/.config/omnesis/token",
          relativePath: "token",
          kind: "file",
          expectedMode: 0o600,
          actualMode: 0o600,
          ok: true,
          fixed: true,
        },
      ],
      diskEncryption: { platform: "darwin", status: "off", detail: "FileVault is off." },
    });

    const report = evaluateDoctor(data);
    const perm = findCheck(report.checks, "security.permissions");
    expect(perm?.status).toBe("pass");
    expect(perm?.message).toContain("repaired 1 mode");
    expect(findCheck(report.checks, "security.full-disk-encryption")?.status).toBe("warn");
  });

  test("missing service units warn in source/foreground mode", () => {
    const data = healthyData();
    data.security = securityData({
      serviceUnits: [
        {
          component: "gateway",
          platform: "linux",
          path: "/home/maya/.config/systemd/user/omnesis-gateway.service",
          installed: false,
          directives: [{ key: "UMask", expected: "0077", actual: null, ok: false }],
        },
      ],
      gatewayIsolation: gatewayIsolation("not-installed"),
    });

    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "security.service-hardening");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("omnesis service install");
    expect(check?.message).not.toContain("hardened system unit");
  });

  test("hardened-only box: the no-user-units warn does not contradict the isolation pass", () => {
    // The gateway runs from the hardened system unit; only the collector can
    // still be missing its user unit, so the generic "run service install"
    // message must not suggest reinstalling the gateway as a user service.
    const data = healthyData();
    data.security = securityData({
      serviceUnits: [
        {
          component: "gateway",
          platform: "linux",
          path: "/home/maya/.config/systemd/user/omnesis-gateway.service",
          installed: false,
          directives: [{ key: "UMask", expected: "0077", actual: null, ok: false }],
        },
        {
          component: "collector",
          platform: "linux",
          path: "/home/maya/.config/systemd/user/omnesis-collector.service",
          installed: false,
          directives: [{ key: "UMask", expected: "0077", actual: null, ok: false }],
        },
      ],
      gatewayIsolation: gatewayIsolation("dedicated-user"),
    });

    const report = evaluateDoctor(data);
    const hardening = findCheck(report.checks, "security.service-hardening");
    expect(hardening?.status).toBe("warn");
    expect(hardening?.message).toContain("hardened system unit");
    expect(hardening?.hint).toContain("omnesis service install collector");
    expect(findCheck(report.checks, "security.gateway-isolation")?.status).toBe("pass");
  });

  test("initialized OS keyring root key passes", () => {
    const data = healthyData();
    data.security = securityData();

    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.keyring")?.status).toBe("pass");
  });

  test("an unreadable keyring fails, and says the rest of the report understates", () => {
    // Every other keyring reading answers "not there" for material it may not
    // look at, so this finding has to travel with the caveat: without it, an
    // armed install reads as one that was never armed.
    const data = healthyData();
    data.security = securityData({
      keyringAccess: {
        readable: false,
        path: "/var/lib/omnesis-gateway/keyring/storage-encryption-required",
        detail: "Cannot determine whether it exists: EACCES: permission denied",
      },
    });

    const check = findCheck(evaluateDoctor(data).checks, "security.keyring-readable");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toMatch(/understates/);
  });

  test("a readable keyring says nothing", () => {
    const report = evaluateDoctor(healthyData());
    expect(findCheck(report.checks, "security.keyring-readable")).toBeUndefined();
  });

  test("a unit naming the passphrase backend with no passphrase source warns", () => {
    // The install-time and boot-time halves of the wiring are written and read
    // by different code, so a unit that names a backend it cannot open starts
    // clean and fails later on an unrelated-looking error. This is the only
    // place that compares the two.
    const data = healthyData();
    data.security = securityData({
      keyringWiring: [
        {
          component: "gateway",
          scope: "user",
          path: "/home/maya/.config/systemd/user/omnesis-gateway.service",
          backend: "passphrase",
          passphraseSource: null,
        },
        {
          component: "gateway",
          scope: "system",
          path: "/etc/systemd/system/omnesis-gateway.service",
          backend: "passphrase",
          passphraseSource: null,
        },
      ],
    });

    const checks = evaluateDoctor(data).checks;
    const user = findCheck(checks, "security.keyring-wiring.user.gateway");
    const system = findCheck(checks, "security.keyring-wiring.system.gateway");
    expect(user?.status).toBe("warn");
    expect(user?.hint).toMatch(/--keyring-passphrase-credential/);
    // A host can carry both units, so the two findings must stay distinct —
    // and the hardened one must not be told to use the file form it refuses.
    expect(system?.status).toBe("warn");
    expect(system?.hint).toMatch(/--hardened/);
    expect(system?.hint).not.toMatch(/--keyring-passphrase-file/);
  });

  test("a wired unit, or one naming no backend, says nothing", () => {
    const data = healthyData();
    data.security = securityData({
      keyringWiring: [
        {
          component: "gateway",
          scope: "user",
          path: "/home/maya/.config/systemd/user/omnesis-gateway.service",
          backend: "passphrase",
          passphraseSource: "credential",
        },
        {
          component: "collector",
          scope: "user",
          path: "/home/maya/.config/systemd/user/omnesis-collector.service",
          backend: null,
          passphraseSource: null,
        },
      ],
    });

    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.keyring-wiring.user.gateway")).toBeUndefined();
    expect(findCheck(report.checks, "security.keyring-wiring.user.collector")).toBeUndefined();
  });

  test("available keyring without root key warns with init hint", () => {
    const data = healthyData();
    data.security = securityData({
      keyring: { ...healthySecurityKeyring(), present: false, valid: false },
    });

    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "security.keyring");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("omnesis keyring init");
  });

  test("file fallback keyring warns even with a valid root key", () => {
    const data = healthyData();
    data.security = securityData({
      keyring: {
        keyName: "install-root-key-v1",
        store: {
          requestedBackend: "file",
          backend: "file",
          available: true,
          secure: false,
          detail: "Owner-only file fallback is enabled.",
          writeExposure: "owner-only-file",
        },
        present: true,
        valid: true,
      },
    });

    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.keyring")?.status).toBe("warn");
  });

  test("live storage encryption passes when every store key is wrapped", () => {
    const data = healthyData();
    data.security = securityData({ databaseEncryption: databaseEncryption("on") });

    const report = evaluateDoctor(data);
    expect(findCheck(report.checks, "security.database-encryption")?.status).toBe("pass");
  });
});

describe("evaluateDoctor — gateway process isolation", () => {
  test("a dedicated-user gateway unit passes", () => {
    const data = healthyData();
    data.security = securityData({ gatewayIsolation: gatewayIsolation("dedicated-user") });

    const check = findCheck(evaluateDoctor(data).checks, "security.gateway-isolation");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("dedicated user");
    expect(check?.hint).toBeUndefined();
  });

  test("a login-user gateway unit warns with the hardened/Docker hint", () => {
    const data = healthyData();
    data.security = securityData({ gatewayIsolation: gatewayIsolation("login-user") });

    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "security.gateway-isolation");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("--hardened");
    expect(check?.hint).toContain("Docker");
    // The collector is never flagged for running as the login user.
    expect(check?.hint).toContain("collector correctly stays");
    // Advisory only — it must not flip ok.
    expect(report.ok).toBe(true);
  });

  test("no gateway unit at all emits no isolation check", () => {
    const data = healthyData();
    data.security = securityData({ gatewayIsolation: gatewayIsolation("not-installed") });

    const check = findCheck(evaluateDoctor(data).checks, "security.gateway-isolation");
    expect(check).toBeUndefined();
  });
});

describe("evaluateDoctor — recovery escrow", () => {
  function securityWith(
    escrow: NonNullable<DoctorData["security"]>["recoveryEscrow"],
    keyringValid: boolean,
  ): NonNullable<DoctorData["security"]> {
    return securityData({
      keyring: keyringValid
        ? healthySecurityKeyring()
        : { ...healthySecurityKeyring(), present: false, valid: false },
      recoveryEscrow: escrow,
      databaseEncryption: databaseEncryption("on"),
    });
  }

  test("passes when a well-formed escrow is exported", () => {
    const data = healthyData();
    data.security = securityWith(recoveryEscrow("exported"), true);
    const check = findCheck(evaluateDoctor(data).checks, "security.recovery-escrow");
    expect(check?.status).toBe("pass");
    expect(check?.hint).toBeUndefined();
  });

  test("warns when no escrow exists but a root key is present to escrow", () => {
    const data = healthyData();
    data.security = securityWith(recoveryEscrow("missing"), true);
    const check = findCheck(evaluateDoctor(data).checks, "security.recovery-escrow");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toMatch(/export-recovery/);
  });

  test("is silent when no escrow exists and there is no root key to escrow", () => {
    const data = healthyData();
    data.security = securityWith(recoveryEscrow("missing"), false);
    const check = findCheck(evaluateDoctor(data).checks, "security.recovery-escrow");
    expect(check).toBeUndefined();
  });

  test("fails when the escrow is present but corrupt", () => {
    const data = healthyData();
    data.security = securityWith(recoveryEscrow("corrupt"), true);
    const check = findCheck(evaluateDoctor(data).checks, "security.recovery-escrow");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toMatch(/--force/);
  });

  test("fails on a corrupt escrow with no root key, pointing at backup recovery", () => {
    const data = healthyData();
    data.security = securityWith(recoveryEscrow("corrupt"), false);
    const check = findCheck(evaluateDoctor(data).checks, "security.recovery-escrow");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toMatch(/backup/);
    expect(check?.hint).not.toMatch(/--force/);
  });
});

describe("evaluateDoctor — push registrations", () => {
  test("warns when a paired phone has no selected transport", () => {
    const data = healthyData();
    data.devices!.push(
      {
        id: "phone-example",
        name: "Fictional phone",
        kind: "ios",
        online: false,
        pushTransport: null,
      },
      {
        id: "phone-healthy-example",
        name: "Healthy test phone",
        kind: "android",
        online: false,
        pushTransport: "direct-fcm",
        notificationDeliveryHealth: "healthy",
      },
    );
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe(
      "1/2 paired phone(s) have no usable push transport: Fictional phone",
    );
    expect(check?.hint).toContain("omnesis push setup");
  });

  test("gives a published app the relay-consent remedy instead of credential setup", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-relay-consent-example",
      name: "Fictional store phone",
      kind: "ios",
      online: false,
      pushTransport: null,
      pushPlan: {
        transport: "unavailable",
        reasonCode: "relay-disabled",
        reason: "relay notifications are not authorized for this device",
      },
    });

    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("approve relay notifications");
    expect(check?.hint).not.toContain("omnesis push setup");
  });

  test("keeps consent, identity, endpoint and registration apart in one inventory", () => {
    const data = healthyData();
    data.devices!.push(
      {
        id: "phone-consent",
        name: "Store phone",
        kind: "ios",
        online: false,
        pushTransport: null,
        pushPlan: {
          transport: "unavailable",
          reasonCode: "relay-disabled",
          reason: "not approved",
        },
      },
      {
        id: "phone-identity",
        name: "Self-built phone",
        kind: "android",
        online: false,
        pushTransport: null,
        pushPlan: {
          transport: "unavailable",
          reasonCode: "no-direct-credential",
          reason: "no push credential covers com.example.self",
        },
      },
      {
        id: "phone-endpoint",
        name: "Endpoint phone",
        kind: "ios",
        online: false,
        pushTransport: "relay",
        pushPlan: {
          transport: "unavailable",
          reasonCode: "relay-url-unavailable",
          reason: "relay URL is unavailable",
        },
      },
      {
        id: "phone-registration",
        name: "Stale phone",
        kind: "ios",
        online: false,
        pushTransport: null,
        pushPlan: { transport: "relay" },
      },
    );
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("Store phone (not approved)");
    expect(check?.message).toContain(
      "Self-built phone (no push credential covers com.example.self)",
    );
    expect(check?.message).toContain("Endpoint phone (relay URL is unavailable)");
    expect(check?.message).toMatch(/Stale phone$/u);
    expect(check?.hint).toContain("approve relay notifications");
    expect(check?.hint).toContain("changing the relay URL does not authorize it");
    expect(check?.hint).toContain("gateway.pushRelay.url");
    expect(check?.hint).toContain("refresh its push registration");
  });

  test("a servable plan with no transport is a registration to redo, never a credential to add", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-registration",
      name: "Stale phone",
      kind: "ios",
      online: false,
      pushTransport: null,
      pushPlan: { transport: "relay" },
    });
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.hint).toContain("refresh its push registration");
    expect(check?.hint).not.toContain("push setup");
  });

  test("a phone-declared app id in the plan's reason is normalized like a name", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-evil",
      name: "Fictional phone",
      kind: "ios",
      online: false,
      pushTransport: null,
      pushPlan: {
        transport: "unavailable",
        reasonCode: "no-direct-credential",
        reason: "no push credential covers dev.example\u001b[31m.app",
      },
    });
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.message).not.toContain("\u001b");
    expect(check?.message).toContain("dev.example");
  });

  test("treats a stale stored relay as unavailable when the current plan rejects it", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-stale-relay-example",
      name: "Fictional stale relay phone",
      kind: "ios",
      online: false,
      pushTransport: "relay",
      pushPlan: {
        transport: "unavailable",
        reasonCode: "relay-url-unavailable",
        reason: "relay URL is unavailable",
      },
      notificationDeliveryHealth: "healthy",
    });

    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("Fictional stale relay phone");
  });

  test("passes and names mixed registered transports", () => {
    const data = healthyData();
    data.devices!.push(
      {
        id: "phone-ios-example",
        name: "Fictional iPhone",
        kind: "ios",
        online: false,
        pushTransport: "direct-apns",
        notificationDeliveryHealth: "healthy",
      },
      {
        id: "phone-android-example",
        name: "Android test phone",
        kind: "android",
        online: false,
        pushTransport: "relay",
        notificationDeliveryHealth: "healthy",
      },
    );
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("direct-apns");
    expect(check?.message).toContain("relay");
  });

  test("treats unclaimed carrier-address columns as unavailable", () => {
    const data = healthyData();
    data.devices!.push(
      {
        id: "phone-unclaimed-ios-example",
        name: "Fictional unclaimed iPhone",
        kind: "ios",
        online: false,
        pushTransport: null,
        apnsRegistration: {},
      },
      {
        id: "phone-unclaimed-android-example",
        name: "Fictional unclaimed Android",
        kind: "android",
        online: false,
        pushTransport: null,
        hasFcmRegistration: true,
      },
    );
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe(
      "2/2 paired phone(s) have no usable push transport: Fictional unclaimed iPhone, Fictional unclaimed Android",
    );
  });

  test("keeps device names safe and bounded in the one-line warning", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-hostile-example",
      name: `  Fictional\x1b[31m\nphone\u202e  ${"x".repeat(300)}`,
      kind: "android",
      online: false,
      pushTransport: null,
    });
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    const displayedName = check?.message.split(": ", 2)[1];
    expect(displayedName).toMatch(/^Fictional \[31m phone x+…$/);
    expect(displayedName).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(Array.from(displayedName ?? "")).toHaveLength(256);
  });

  test("clips device names without splitting Unicode code points", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-unicode-example",
      name: `${"a".repeat(254)}😀xy`,
      kind: "ios",
      online: false,
      pushTransport: null,
    });
    const check = findCheck(evaluateDoctor(data).checks, "push.inventory");
    const displayedName = check?.message.split(": ", 2)[1];
    expect(displayedName).toBe(`${"a".repeat(254)}😀…`);
    expect(Array.from(displayedName ?? "")).toHaveLength(256);
  });

  test("warns specifically when a phone reports iOS notification batching", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-summary-example",
      name: "Fictional iPhone",
      kind: "ios",
      online: false,
      pushTransport: "direct-apns",
      notificationDeliveryHealth: "scheduled-summary",
    });
    const check = findCheck(evaluateDoctor(data).checks, "push.delivery-health");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("batching");
  });

  test("warns when a registered phone has not reported delivery health", () => {
    const data = healthyData();
    data.devices!.push({
      id: "phone-unreported-example",
      name: "Fictional phone",
      kind: "android",
      online: false,
      pushTransport: "relay",
    });
    const check = findCheck(evaluateDoctor(data).checks, "push.delivery-health");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("not reported");
  });
});

describe("fleet update results", () => {
  const withDevices = (devices: DoctorData["devices"]): DoctorData => {
    const base = healthyData();
    return { ...base, devices: [...(base.devices ?? []), ...(devices ?? [])] };
  };

  test("a failed harness update names the running and requested versions and the refresh command", () => {
    const report = evaluateDoctor(
      withDevices([
        {
          id: "dev-agent",
          name: "lab-agent",
          kind: "agent",
          online: true,
          version: "0.4.7",
          desiredVersion: "0.4.8",
          updateState: "failed",
          updateDetail: "Plugin refresh failed on its host",
          harness: "openclaw",
        },
      ]),
    );
    const check = findCheck(report.checks, "fleet.update-failed");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("lab-agent still runs 0.4.7 instead of 0.4.8");
    expect(check?.message).toContain("Plugin refresh failed on its host");
    expect(check?.hint).toContain("`omnesis connect openclaw --refresh`");
    expect(findCheck(report.checks, "fleet.restart-pending")).toBeUndefined();
  });

  test("a failed collector update points at its own updater", () => {
    const report = evaluateDoctor(
      withDevices([
        {
          id: "dev-c",
          name: "studio-mini",
          kind: "collector",
          online: false,
          version: "0.4.7",
          desiredVersion: "0.4.8",
          updateState: "failed",
        },
      ]),
    );
    expect(findCheck(report.checks, "fleet.update-failed")?.hint).toContain("`omnesis update`");
  });

  test("an installed but unloaded build is a restart owed, with the detail that names the command", () => {
    const report = evaluateDoctor(
      withDevices([
        {
          id: "dev-agent",
          name: "lab-agent",
          kind: "agent",
          online: true,
          version: "0.4.7",
          desiredVersion: "0.4.8",
          updateState: "restart-pending",
          updateDetail: "Plugin 0.4.8 installed; restart owed: openclaw gateway restart",
          harness: "openclaw",
        },
      ]),
    );
    const check = findCheck(report.checks, "fleet.restart-pending");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("lab-agent runs 0.4.7 with 0.4.8 installed");
    expect(check?.hint).toContain("openclaw gateway restart");
    expect(findCheck(report.checks, "fleet.update-failed")).toBeUndefined();
  });

  test("a build that cannot take the update command is named with the commands for its kind", () => {
    const report = evaluateDoctor(
      withDevices([
        {
          id: "dev-agent",
          name: "lab-agent",
          kind: "agent",
          online: true,
          version: "0.4.7",
          desiredVersion: "0.4.9",
          updateState: "unsupported",
          harness: "hermes",
        },
        {
          id: "dev-c",
          name: "studio-box",
          kind: "collector",
          online: true,
          version: "0.4.6",
          updateState: "unsupported",
        },
      ]),
    );
    const check = findCheck(report.checks, "fleet.update-unsupported");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("lab-agent (0.4.7)");
    expect(check?.message).toContain("studio-box (0.4.6)");
    expect(check?.hint).toContain(
      "On lab-agent's machine run `omnesis update`, then `omnesis connect hermes --refresh`, then `hermes gateway restart`.",
    );
    expect(check?.hint).toContain("On studio-box's machine run `omnesis update`.");
    expect(findCheck(report.checks, "fleet.update-failed")).toBeUndefined();
  });

  test("a revoked device's stale result and an update in flight raise nothing", () => {
    const report = evaluateDoctor(
      withDevices([
        {
          id: "dev-gone",
          name: "old-agent",
          kind: "agent",
          online: false,
          revokedAt: 1,
          updateState: "failed",
        },
        {
          id: "dev-busy",
          name: "busy-collector",
          kind: "collector",
          online: true,
          updateState: "dispatched",
          desiredVersion: "0.4.8",
        },
      ]),
    );
    expect(findCheck(report.checks, "fleet.update-failed")).toBeUndefined();
    expect(findCheck(report.checks, "fleet.restart-pending")).toBeUndefined();
  });

  test("a lapsed agent authorization is named with the command to run on that machine", () => {
    const report = evaluateDoctor(
      withDevices([
        {
          id: "dev-agent",
          name: "lab-agent",
          kind: "agent",
          online: true,
          harness: "hermes",
          agentAuthorization: {
            status: "needs-reauthorization",
            remedy: "omnesis connect hermes --refresh",
          },
        },
        {
          id: "dev-agent-2",
          name: "desk-agent",
          kind: "agent",
          online: true,
          harness: "openclaw",
          agentAuthorization: { status: "authorized" },
        },
      ]),
    );
    const check = findCheck(report.checks, "fleet.agent-authorization");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("lab-agent");
    expect(check?.message).not.toContain("desk-agent");
    expect(check?.hint).toContain("`omnesis connect hermes --refresh`");
  });
});

describe("fleet re-pairing", () => {
  test("names every revoked device that still hosts sources, with its repair command", () => {
    const base = healthyData();
    const data: DoctorData = {
      ...base,
      devices: [
        ...(base.devices ?? []),
        {
          id: "dev-dormant",
          name: "studio-mini",
          kind: "collector",
          online: false,
          revokedAt: 1,
          needsPairing: true,
        },
        {
          id: "dev-retired",
          name: "old-laptop",
          kind: "collector",
          online: false,
          revokedAt: 1,
          needsPairing: false,
        },
      ],
    };
    const report = evaluateDoctor(data);
    const check = findCheck(report.checks, "fleet.needs-pairing");
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe("1 device is revoked but still hosts sources: studio-mini");
    expect(check?.hint).toContain("`omnesis devices repair 'studio-mini'`");
    expect(check?.hint).not.toContain("old-laptop");
  });

  test("is silent when no revoked device hosts sources", () => {
    const report = evaluateDoctor(healthyData());
    expect(findCheck(report.checks, "fleet.needs-pairing")).toBeUndefined();
  });
});

describe("storage footprint", () => {
  const GB = 1024 ** 3;

  test("reports the whole footprint with its breakdown when the gateway measures it", () => {
    const report = evaluateDoctor({
      ...healthyData(),
      overall: {
        dbSizeBytes: 2 * GB,
        diskUsage: {
          totalBytes: 5 * GB,
          measuredAt: "2026-06-04T10:00:00.000Z",
          stores: [
            { id: "documents", label: "Main database", bytes: 2 * GB },
            { id: "index", label: "Search index", bytes: 3 * GB },
          ],
        },
      },
    });
    const check = findCheck(report.checks, "storage.db");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("Gateway data on disk: 5.0 GB");
    expect(check?.message).toContain("main database 2.0 GB");
    expect(check?.message).toContain("search index 3.0 GB");
  });

  test("falls back to the main database size on a gateway without diskUsage", () => {
    const report = evaluateDoctor({ ...healthyData(), overall: { dbSizeBytes: 2 * GB } });
    expect(findCheck(report.checks, "storage.db")?.message).toBe("Gateway DB size: 2.0 GB");
  });

  test("falls back while the first measurement is still running", () => {
    const report = evaluateDoctor({
      ...healthyData(),
      overall: { dbSizeBytes: 2 * GB, diskUsage: null },
    });
    expect(findCheck(report.checks, "storage.db")?.message).toBe("Gateway DB size: 2.0 GB");
  });
});
