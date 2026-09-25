// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `DoctorService` folds the check inputs from in-process gateway state.
 * These tests pin that fold — that each slot is populated from the right
 * source and reshaped into what the shared evaluator expects — and the
 * degradation paths, where an optional dependency is absent.
 *
 * The classification itself belongs to `@omnesis/core`'s
 * `doctor/checks.test.ts`; asserting verdicts here would only re-test the
 * evaluator through a slower door.
 *
 * Fixture data is fictional per the repo's privacy rule.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PROCESS_VITALS_WINDOW_SECONDS } from "@omnesis/core/doctor";
import { GATEWAY_VERSION } from "../../version.js";
import { DoctorService, type DoctorServiceDeps } from "./DoctorService.js";
import type { WhoAmIResult } from "@omnesis/core/doctor";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WHOAMI: WhoAmIResult = {
  tokenId: "tok_portal",
  deviceId: null,
  deviceName: null,
  scopes: ["read", "admin"],
};

function deps(overrides: Partial<DoctorServiceDeps> = {}): DoctorServiceDeps {
  return {
    statusCache: {
      sourceHostingDeviceIds: new Set<string>(),
      listDevices: [],
      listSources: [],
      listSyncStates: [],
    } as unknown as DoctorServiceDeps["statusCache"],
    sourceService: {
      listSourcesForAdmin: () => [],
      listSyncStatuses: () => [],
    } as unknown as DoctorServiceDeps["sourceService"],
    // No index DB → computeIndexStats returns the "disabled" shape without
    // touching a database, which keeps these tests handle-free.
    indexStats: { db: undefined as never },
    ...overrides,
  };
}

describe("DoctorService — folding in-process state", () => {
  test("reports reachability and auth as settled, since the request got here", async () => {
    const report = await new DoctorService(deps()).report(WHOAMI);

    const reachable = report.checks.find((c) => c.id === "gateway.reachable");
    expect(reachable?.status).toBe("pass");
    const token = report.checks.find((c) => c.id === "auth.token");
    expect(token?.status).toBe("pass");
    expect(token?.message).toContain("tok_portal");
  });

  test("a portal session (no device) warns rather than failing", async () => {
    const report = await new DoctorService(deps()).report(WHOAMI);
    const device = report.checks.find((c) => c.id === "auth.device");
    expect(device?.status).toBe("warn");
    expect(device?.message).toMatch(/portal session/);
  });

  test("folds a relay-disabled phone plan into the consent-specific remedy", async () => {
    const report = await new DoctorService(
      deps({
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(),
          listDevices: [
            {
              id: "phone_store_example",
              name: "Fictional store phone",
              kind: "ios",
              capabilities: { pushAppId: "dev.omnesis.ios" },
              revokedAt: null,
              pushTransport: null,
              apnsRegistration: null,
              fcmRegistration: null,
            },
          ],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
        pushPlanForDevice: () => ({
          transport: "unavailable",
          reasonCode: "relay-disabled",
          reason: "relay notifications are not authorized for this device",
        }),
      }),
    ).report(WHOAMI);

    const push = report.checks.find((check) => check.id === "push.inventory");
    expect(push?.hint).toContain("approve relay notifications");
    expect(push?.hint).not.toContain("omnesis push setup");
  });

  test("a disconnected collector with healthy sync evidence does not warn", async () => {
    const service = new DoctorService(
      deps({
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(),
          listDevices: [
            { id: "dev_a", name: "Studio laptop", kind: "collector" },
            { id: "dev_b", name: "Kitchen tablet", kind: "ios" },
          ],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
        wsServer: {
          isConnected: () => false,
        } as unknown as DoctorServiceDeps["wsServer"],
        sourceService: {
          listSourcesForAdmin: () => [
            {
              id: "demo-mail:user@example.com",
              type: "demo-mail",
              accountId: "user@example.com",
              deviceId: "dev_a",
              enabled: true,
              pushBased: false,
              lastSyncedAt: "2026-06-04T10:00:00.000Z",
            },
          ],
          listSyncStatuses: () => [
            {
              sourceId: "demo-mail:user@example.com",
              state: "synced",
              lastSyncAt: "2026-06-04T10:00:00.000Z",
            },
          ],
        } as unknown as DoctorServiceDeps["sourceService"],
      }),
    );

    const report = await service.report(WHOAMI);
    expect(report.checks.find((c) => c.id === "sources.healthy")?.status).toBe("pass");
  });

  // The fold reshapes seven source fields and four sync fields into what the
  // evaluator reads. Mis-keying any of them (type↔accountId, a dropped
  // errorMessage, an inverted pushBased) is invisible unless a test drives
  // non-empty input, so this one does.
  test("source and sync fields reach the checks that classify on them", async () => {
    const service = new DoctorService(
      deps({
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(),
          listDevices: [{ id: "dev_a", name: "Studio laptop", kind: "collector" }],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
        sourceService: {
          listSourcesForAdmin: () => [
            {
              id: "demo-mail:user@example.com",
              type: "demo-mail",
              accountId: "user@example.com",
              deviceId: "dev_a",
              enabled: true,
              pushBased: false,
              lastSyncedAt: null,
            },
            {
              id: "demo-capture:local",
              type: "demo-capture",
              accountId: "local",
              deviceId: "dev_b",
              enabled: true,
              // Push sources run no sync loop, so a missing timestamp is
              // expected and must not be reported as "never synced".
              pushBased: true,
              lastSyncedAt: null,
            },
          ],
          listSyncStatuses: () => [
            {
              sourceId: "demo-mail:user@example.com",
              state: "error",
              lastSyncAt: "2026-06-01T00:00:00.000Z",
              errorMessage: "connection refused",
            },
          ],
        } as unknown as DoctorServiceDeps["sourceService"],
      }),
    );

    const report = await service.report(WHOAMI);

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "sources.any", message: expect.stringContaining("2") }),
    );

    // The error message survived the fold into the per-source check.
    const errored = report.checks.find((c) => c.id === "sources.error.demo-mail:user@example.com");
    expect(errored?.status).toBe("warn");
    expect(errored?.message).toContain("connection refused");

    // `pushBased` and `lastSyncAt` both reached the never-synced rule: the
    // push source is exempt from it and the pull source has a sync
    // timestamp, so nothing qualifies and the check is not raised at all.
    expect(report.checks.find((c) => c.id === "sources.never-synced")).toBeUndefined();
  });

  test("a pull source with no sync history is reported as never synced", async () => {
    const service = new DoctorService(
      deps({
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(),
          listDevices: [{ id: "dev_a", name: "Studio laptop", kind: "collector" }],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
        sourceService: {
          listSourcesForAdmin: () => [
            {
              id: "demo-mail:user@example.com",
              type: "demo-mail",
              accountId: "user@example.com",
              deviceId: "dev_a",
              enabled: true,
              pushBased: false,
              lastSyncedAt: null,
            },
          ],
          listSyncStatuses: () => [],
        } as unknown as DoctorServiceDeps["sourceService"],
      }),
    );

    const report = await service.report(WHOAMI);
    const neverSynced = report.checks.find((c) => c.id === "sources.never-synced");
    expect(neverSynced?.status).toBe("warn");
    expect(neverSynced?.message).toContain("demo-mail:user@example.com");
  });

  test("the process-vitals snapshot is taken over the window the checks assume", async () => {
    const windows: number[] = [];
    const service = new DoctorService(
      deps({
        processVitals: {
          snapshot: (windowSeconds: number) => {
            windows.push(windowSeconds);
            return { eventLoop: { current: null }, memory: { current: null } } as never;
          },
        },
      }),
    );

    await service.report(WHOAMI);
    expect(windows).toEqual([PROCESS_VITALS_WINDOW_SECONDS]);
  });

  test("the config revision and the product version are folded from separate sources", async () => {
    // Two different numbers that a single `gateway.version` check used to
    // conflate. The config revision is a counter the config store bumps on
    // every write; the product version is this build's lockstep semver. The
    // fold has to supply both — `config.version` from the store, and
    // `health.version` from the running gateway — or one of the two answers
    // silently goes missing.
    const service = new DoctorService(
      deps({
        configStore: {
          getStatus: () => ({
            ok: true,
            version: 7,
            lastLoadedAt: Date.parse("2026-06-01T00:00:00.000Z"),
            lastWrittenAt: null,
            lastError: null,
          }),
        } as unknown as DoctorServiceDeps["configStore"],
      }),
    );

    const report = await service.report(WHOAMI);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "gateway.config-revision",
        message: expect.stringContaining("7"),
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "gateway.product-version",
        message: expect.stringContaining(GATEWAY_VERSION),
      }),
    );
    // The conflated id is gone; nothing may still answer to it.
    expect(report.checks.find((c) => c.id === "gateway.version")).toBeUndefined();
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "config.load", status: "pass" }),
    );
  });

  test("db size comes from the database file on disk", async () => {
    const dir = tmp("omnesis-doctor-db-");
    const dbPath = join(dir, "omnesis.db");
    writeFileSync(dbPath, "x".repeat(4096));

    const report = await new DoctorService(deps({ dbPath })).report(WHOAMI);
    const db = report.checks.find((c) => c.id === "storage.db");
    expect(db?.status).toBe("pass");
    expect(db?.message).toContain("4.0 KB");
  });

  test("the storage check reports the measured footprint when a monitor is wired", async () => {
    const dir = tmp("omnesis-doctor-disk-");
    const dbPath = join(dir, "omnesis.db");
    writeFileSync(dbPath, "x".repeat(4096));
    const usage = {
      totalBytes: 3 * 4096,
      measuredAt: "2026-06-04T10:00:00.000Z",
      stores: [
        { id: "documents", label: "Main database", bytes: 4096 },
        { id: "index", label: "Search index", bytes: 2 * 4096 },
      ],
    };

    const report = await new DoctorService(deps({ dbPath, getDiskUsage: () => usage })).report(
      WHOAMI,
    );
    const db = report.checks.find((c) => c.id === "storage.db");
    expect(db?.message).toContain("Gateway data on disk: 12.0 KB");
    expect(db?.message).toContain("search index 8.0 KB");
  });

  test("a missing database file degrades instead of throwing", async () => {
    const service = new DoctorService(deps({ dbPath: "/nonexistent/omnesis.db" }));
    await expect(service.report(WHOAMI)).resolves.toBeDefined();
  });

  test("folds the gateway's last successful release check into the report", async () => {
    const report = await new DoctorService(
      deps({
        getReleaseCheck: () => ({
          currentVersion: "1.4.0",
          latestVersion: "1.5.0",
          installMethod: "source",
          checkedAt: "2026-09-07T12:00:00.000Z",
          updateAvailable: true,
        }),
      }),
    ).report(WHOAMI);

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "gateway.release", status: "warn" }),
    );
  });
});

describe("DoctorService — degradation when a dependency is absent", () => {
  // An absent slot is a diagnostic in its own right rather than a silent
  // omission — "I could not read this" is information the operator wants,
  // and staying quiet would let a half-wired gateway look healthy.
  test("reports model status as unreadable when no inference overview is wired", async () => {
    const report = await new DoctorService(deps()).report(WHOAMI);
    const models = report.checks.filter((c) => c.section === "Models");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "models.unavailable", status: "warn" });
  });

  test("does not require a WS server to validate source host assignments", async () => {
    const report = await new DoctorService(
      deps({
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(),
          listDevices: [{ id: "dev_a", name: "Studio laptop", kind: "collector" }],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
        sourceService: {
          listSourcesForAdmin: () => [
            {
              id: "demo-mail:user@example.com",
              type: "demo-mail",
              accountId: "user@example.com",
              deviceId: "dev_a",
              enabled: true,
              pushBased: false,
              lastSyncedAt: "2026-06-04T10:00:00.000Z",
            },
          ],
          listSyncStatuses: () => [
            {
              sourceId: "demo-mail:user@example.com",
              state: "synced",
              lastSyncAt: "2026-06-04T10:00:00.000Z",
            },
          ],
        } as unknown as DoctorServiceDeps["sourceService"],
      }),
    ).report(WHOAMI);

    expect(report.checks.find((c) => c.id === "sources.healthy")?.status).toBe("pass");
  });

  test("skips the security section when no config dir is known", async () => {
    const report = await new DoctorService(deps()).report(WHOAMI);
    expect(report.checks.filter((c) => c.section === "Security")).toEqual([]);
  });

  test("runs the security scan in a worker when a config dir is known", async () => {
    const configDir = tmp("omnesis-doctor-config-");
    const report = await new DoctorService(deps({ configDir })).report(WHOAMI);

    // The worker resolved and returned a real bundle, so security checks exist.
    expect(report.checks.some((c) => c.section === "Security")).toBe(true);
  }, 60_000);

  test("the report is always well-formed regardless of what was collected", async () => {
    const report = await new DoctorService(deps()).report(WHOAMI);
    expect(report).toMatchObject({
      ok: expect.any(Boolean),
      summary: { errors: expect.any(Number), warnings: expect.any(Number) },
      checks: expect.any(Array),
    });
    for (const check of report.checks) {
      expect(check.id).toBeTruthy();
      expect(check.section).toBeTruthy();
      expect(["pass", "warn", "fail"]).toContain(check.status);
      // A hint is remediation advice — it only makes sense on a problem.
      if (check.status === "pass") expect(check.hint).toBeUndefined();
    }
  });
});

describe("the served certificate in the gateway's own report", () => {
  test("carries the lifecycle snapshot and each device's pairing and last-seen times", async () => {
    const tls = { ownership: "self-signed", served: { state: "valid" } };
    const service = new DoctorService(
      deps({
        getTlsLifecycle: () => tls as never,
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(),
          listDevices: [
            {
              id: "dev-phone",
              name: "phone",
              kind: "ios",
              revokedAt: null,
              pairedAt: 1_700_000_000_000,
              lastSeenAt: null,
              version: "0.4.8",
            },
          ],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
      }),
    );
    const data = await (
      service as unknown as {
        collect(w: unknown): Promise<{
          overall: { tls: unknown };
          devices: Array<{ id: string; pairedAt?: number | null; lastSeenAt?: number | null }>;
        }>;
      }
    ).collect({ tokenId: null, deviceId: null, deviceName: null, scopes: ["admin"] });
    expect(data.overall.tls).toBe(tls);
    expect(data.devices).toEqual([
      expect.objectContaining({ id: "dev-phone", pairedAt: 1_700_000_000_000, lastSeenAt: null }),
    ]);
  });

  test("a composition without TLS wiring reports null", async () => {
    const service = new DoctorService(deps({}));
    const data = await (
      service as unknown as { collect(w: unknown): Promise<{ overall: { tls: unknown } }> }
    ).collect({ tokenId: null, deviceId: null, deviceName: null, scopes: ["admin"] });
    expect(data.overall.tls).toBeNull();
  });
});

describe("needsPairing in the gateway's own report", () => {
  test("marks a revoked device that still hosts sources, and only that one", async () => {
    const revokedHosting = {
      id: "dev-dormant",
      name: "studio-mini",
      kind: "collector",
      revokedAt: 1,
      version: "0.4.8",
    };
    const revokedRetired = {
      id: "dev-retired",
      name: "old-laptop",
      kind: "collector",
      revokedAt: 1,
      version: "0.4.8",
    };
    const active = {
      id: "dev-live",
      name: "laptop",
      kind: "collector",
      revokedAt: null,
      version: "0.4.8",
    };
    const service = new DoctorService(
      deps({
        statusCache: {
          sourceHostingDeviceIds: new Set<string>(["dev-dormant", "dev-live"]),
          listDevices: [revokedHosting, revokedRetired, active],
          listSources: [],
          listSyncStates: [],
        } as unknown as DoctorServiceDeps["statusCache"],
      }),
    );
    const data = await (
      service as unknown as {
        collect(w: unknown): Promise<{ devices: Array<{ id: string; needsPairing?: boolean }> }>;
      }
    ).collect({ tokenId: null, deviceId: null, deviceName: null, scopes: ["admin"] });
    expect(data.devices.map((d) => [d.id, d.needsPairing])).toEqual([
      ["dev-dormant", true],
      ["dev-retired", false],
      ["dev-live", false],
    ]);
  });
});
