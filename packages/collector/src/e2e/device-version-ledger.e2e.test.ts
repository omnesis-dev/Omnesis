// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Device version ledger E2E.
 *
 * Four pseudo-collectors pair and connect against one real gateway, each
 * announcing a different build — the gateway's own version, a release older
 * than it but still supported, one below the declared floor, and one that
 * announces no version at all the way a client built before the ledger does.
 *
 * What this proves that a unit test cannot:
 *
 *   - The version survives the whole path: the client's hello capability,
 *     the writer, the `devices.version` column, and back out of
 *     `GET /admin/devices`.
 *   - A hello that carries no version is still accepted. That is the epic's
 *     standing constraint — the field is optional forever, and only the wire
 *     protocol number may refuse a connection.
 *   - The three verdicts and the unknown reading agree across the three
 *     surfaces an operator actually looks at: the admin API, `omnesis
 *     devices list`, and `omnesis doctor`.
 *
 * The `unsupported`-by-protocol arm is deliberately absent here: a hello on
 * a protocol the gateway does not speak is refused at the handshake, so no
 * live client can reach that state. It is covered where it is reachable, in
 * `packages/core/src/client-version.test.ts`.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { MINIMUM_CLIENT_VERSIONS, compareProductVersions } from "@omnesis/core";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";

/**
 * Exactly at the floor a collector's kind declares: old enough to be behind
 * the gateway, new enough to still be supported. Taken from the constant
 * rather than written out, so raising the floor cannot leave this suite
 * quietly asserting the wrong band.
 */
const BEHIND_VERSION = MINIMUM_CLIENT_VERSIONS.collector;
/** Below any plausible floor: this build is past the line. */
const UNSUPPORTED_VERSION = "0.0.1";

/** The gateway's own product version, read from the running gateway. */
let gatewayVersion = "";

interface DeviceListEntry {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  version?: string | null;
  versionSeenAt?: number | null;
  protocolVersion?: number | null;
  versionState?: string;
}

interface DoctorCheck {
  id: string;
  section: string;
  status: "pass" | "warn" | "fail";
  message: string;
  hint?: string;
}

describe("device version ledger (gateway)", () => {
  let harness: MultiCollectorHarness;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    gatewayVersion = (await harness.json<{ version: string }>("/health")).version;

    // The three bands only exist while the floor sits strictly below the
    // running release. Assert the precondition rather than let a floor bumped
    // up to the current version turn "behind" into an empty band and this
    // whole suite into a tautology.
    expect(compareProductVersions(BEHIND_VERSION, gatewayVersion)).toBeLessThan(0);
    expect(compareProductVersions(UNSUPPORTED_VERSION, BEHIND_VERSION)).toBeLessThan(0);

    await harness.addCollector({
      name: "current-host",
      hostableSourceTypes: ["gmail-synth"],
      version: gatewayVersion,
    });
    await harness.addCollector({
      name: "behind-host",
      hostableSourceTypes: ["notion-synth"],
      version: BEHIND_VERSION,
    });
    await harness.addCollector({
      name: "ancient-host",
      hostableSourceTypes: ["calendar-synth"],
      version: UNSUPPORTED_VERSION,
    });
    // No `version` at all — a collector built before the ledger existed.
    await harness.addCollector({
      name: "silent-host",
      hostableSourceTypes: ["things-synth"],
    });
  }, 90_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  const listDevices = async (): Promise<Map<string, DeviceListEntry>> => {
    const { items } = await harness.json<{ items: DeviceListEntry[] }>("/admin/devices");
    return new Map(items.map((d) => [d.name, d]));
  };

  /** The version column as SQLite holds it, with no cache in the way. */
  const storedVersion = (name: string): string | null => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return (
        db
          .prepare<
            [string],
            { version: string | null }
          >("SELECT version FROM devices WHERE name = ?")
          .get(name)?.version ?? null
      );
    } finally {
      db.close();
    }
  };

  /**
   * Wait for the served device list to agree with the row.
   *
   * `GET /admin/devices` answers from `StatusCache`, a background-refreshed
   * snapshot rather than a live query, and a hello is not an HTTP mutation
   * route so nothing bumps that cache on its behalf — the same as every other
   * field a handshake writes. The ledger's contract is therefore eventual:
   * the row changes at once, the list catches up on the next tick.
   */
  const waitForServedDevice = async (
    name: string,
    predicate: (device: DeviceListEntry | undefined) => boolean,
    label: string,
  ): Promise<DeviceListEntry | undefined> => {
    await waitForCondition(
      async () => predicate((await listDevices()).get(name)),
      10_000,
      `${label} for ${name}`,
    );
    return (await listDevices()).get(name);
  };

  test("a collector that announces no version still pairs and connects", async () => {
    const silent = (await listDevices()).get("silent-host");
    // The standing constraint of the whole epic: the gateway never refuses a
    // hello for an absent version, so this row exists and its socket is live.
    // Only the protocol number may gate a connection.
    expect(silent).toBeDefined();
    expect(silent?.online).toBe(true);
  });

  test("every announced version is persisted on the device row", () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const rows = db
        .prepare<
          [],
          {
            name: string;
            version: string | null;
            version_seen_at: number | null;
            protocol_version: number | null;
          }
        >("SELECT name, version, version_seen_at, protocol_version FROM devices")
        .all();
      const byName = new Map(rows.map((r) => [r.name, r]));

      expect(byName.get("current-host")?.version).toBe(gatewayVersion);
      expect(byName.get("behind-host")?.version).toBe(BEHIND_VERSION);
      expect(byName.get("ancient-host")?.version).toBe(UNSUPPORTED_VERSION);
      // Not the empty string, not a placeholder — genuinely absent.
      expect(byName.get("silent-host")?.version).toBeNull();

      // `version_seen_at` is stamped exactly when a version was recorded.
      expect(byName.get("current-host")?.version_seen_at).toBeGreaterThan(0);
      expect(byName.get("silent-host")?.version_seen_at).toBeNull();

      // The protocol comes from the hello envelope, so every connected
      // device carries it — including the one that announced no version.
      for (const name of ["current-host", "behind-host", "ancient-host", "silent-host"]) {
        expect(byName.get(name)?.protocol_version).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  test("the version is hoisted into its column rather than left in the capability bag", async () => {
    const { items } = await harness.json<{
      items: Array<{ name: string; capabilities?: Record<string, unknown> }>;
    }>("/admin/devices");
    const current = items.find((d) => d.name === "current-host");
    expect(current?.capabilities?.version).toBeUndefined();
    expect(current?.capabilities?.hostname).toBe("current-host.example.com");
  });

  test("GET /admin/devices serves the three states plus unknown", async () => {
    const devices = await listDevices();
    expect(devices.get("current-host")?.versionState).toBe("current");
    expect(devices.get("behind-host")?.versionState).toBe("behind");
    expect(devices.get("ancient-host")?.versionState).toBe("unsupported");
    expect(devices.get("silent-host")?.versionState).toBe("unknown");

    expect(devices.get("current-host")?.version).toBe(gatewayVersion);
    expect(devices.get("silent-host")?.version).toBeNull();
  });

  test("`omnesis devices list` prints a VERSION and a STATE column", async () => {
    const result = await harness.runCli(["devices", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VERSION");
    expect(result.stdout).toContain("STATE");

    const row = (name: string): string =>
      result.stdout.split("\n").find((line) => line.startsWith(name)) ?? "";

    expect(row("current-host")).toContain(gatewayVersion);
    expect(row("current-host")).toContain("current");
    expect(row("behind-host")).toContain(BEHIND_VERSION);
    expect(row("behind-host")).toContain("behind");
    expect(row("ancient-host")).toContain(UNSUPPORTED_VERSION);
    expect(row("ancient-host")).toContain("unsupported");
    // An em dash, not a fabricated version, and a neutral state.
    expect(row("silent-host")).toContain("—");
    expect(row("silent-host")).toContain("unknown");
  });

  test("`omnesis status` reports the gateway version and a one-line fleet count", async () => {
    const result = await harness.runCli(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Gateway ${gatewayVersion}`);
    expect(result.stdout).toMatch(/devices:.*unsupported/);
  });

  test("the doctor fails on the unsupported device and names it", async () => {
    const report = await harness.json<{ ok: boolean; checks: DoctorCheck[] }>("/admin/doctor");
    const fleet = report.checks.find((c) => c.id === "fleet.versions");
    expect(fleet).toBeDefined();
    expect(fleet?.section).toBe("Fleet");
    expect(fleet?.status).toBe("fail");
    expect(fleet?.message).toContain("ancient-host");
    expect(fleet?.message).toContain(UNSUPPORTED_VERSION);
    // A behind or unknown device is never the reason a check fails.
    expect(fleet?.message).not.toContain("behind-host");
    expect(fleet?.hint).toBeTruthy();
  });

  test("the renamed gateway check reports the config revision, not the product version", async () => {
    const report = await harness.json<{ checks: DoctorCheck[] }>("/admin/doctor");
    expect(report.checks.find((c) => c.id === "gateway.version")).toBeUndefined();

    const revision = report.checks.find((c) => c.id === "gateway.config-revision");
    expect(revision?.status).toBe("pass");
    expect(revision?.message).toMatch(/revision \d+/);

    const product = report.checks.find((c) => c.id === "gateway.product-version");
    expect(product?.status).toBe("pass");
    expect(product?.message).toContain(gatewayVersion);
  });

  test("the doctor stops failing once the unsupported device updates", async () => {
    const ancient = harness.collectors.find((c) => c.name === "ancient-host")!;
    // A real update is the host installing a newer build and reconnecting;
    // the pseudo-collector models that by re-announcing on a fresh socket.
    await harness.reannounceCollector(ancient, {
      ...ancient.capabilities,
      version: gatewayVersion,
    });

    // The row is authoritative and changes with the handshake itself.
    expect(storedVersion("ancient-host")).toBe(gatewayVersion);

    const served = await waitForServedDevice(
      "ancient-host",
      (d) => d?.versionState === "current",
      "the updated version to reach the served list",
    );
    expect(served?.version).toBe(gatewayVersion);

    const report = await harness.json<{ checks: DoctorCheck[] }>("/admin/doctor");
    const fleet = report.checks.find((c) => c.id === "fleet.versions");
    expect(fleet?.status).toBe("pass");
    expect(fleet?.message).toContain("behind");
  });

  test("a device that downgrades to a pre-ledger build reads as unknown again", async () => {
    const behind = harness.collectors.find((c) => c.name === "behind-host")!;
    const { version: _dropped, ...withoutVersion } = behind.capabilities;
    await harness.reannounceCollector(behind, withoutVersion);

    // A remembered version would be a lie: this build reports none, so the
    // column is cleared rather than left standing.
    expect(storedVersion("behind-host")).toBeNull();

    const served = await waitForServedDevice(
      "behind-host",
      (d) => d?.versionState === "unknown",
      "the cleared version to reach the served list",
    );
    expect(served?.version).toBeNull();
  });
});
