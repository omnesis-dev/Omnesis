// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";

import { createDatabase } from "../../db.js";
import {
  createDevice,
  setApnsToken,
  setFcmToken,
  setRelayPushConsent,
  setRelayPushRegistration,
} from "../../data/repositories/DeviceRepository.js";
import { PushTransport } from "../../watch/push-transport.js";
import { directWriteGate } from "../../write-gate.js";
import { claimNotification, confirmNotification, enqueueNotification } from "../../push/queue.js";
import { PushAdminService } from "./PushAdminService.js";

const dirs: string[] = [];
const databases: import("better-sqlite3").Database[] = [];

afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function service(db: import("better-sqlite3").Database, configDir?: string) {
  return new PushAdminService({
    db,
    configDir,
    getSettings: () => undefined,
    writeGate: directWriteGate(db),
    pushTransport: new PushTransport({ publish: () => Promise.resolve([]) }),
  });
}

describe("PushAdminService", () => {
  test("reports per-phone relay approval through the deprecated Boolean and count", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const subject = new PushAdminService({
      db,
      getSettings: () => undefined,
      getRelaySettings: () => ({
        enabled: true,
        url: "https://relay.example.com",
        visible: true,
      }),
      writeGate: directWriteGate(db),
      pushTransport: new PushTransport({ publish: () => Promise.resolve([]) }),
    });

    expect(subject.status()).toMatchObject({
      configured: { relay: false },
      settings: { relay: { enabled: false, url: "https://relay.example.com" } },
      devices: { relayConsented: 0 },
    });
    const phone = createDevice(db, { name: "consented-phone", kind: "ios" });
    setRelayPushConsent(db, phone.id, { appId: "dev.omnesis.ios", grantedAt: 1 });
    expect(subject.status()).toMatchObject({
      configured: { relay: true },
      settings: { relay: { enabled: true, url: "https://relay.example.com" } },
      devices: { relayConsented: 1 },
    });

    const hidden = new PushAdminService({
      db,
      getSettings: () => undefined,
      getRelaySettings: () => ({
        enabled: false,
        url: "https://push.omnesis.app",
        visible: false,
      }),
      writeGate: directWriteGate(db),
      pushTransport: new PushTransport({ publish: () => Promise.resolve([]) }),
    }).status();
    expect(hidden.configured).not.toHaveProperty("relay");
    expect(hidden.settings).not.toHaveProperty("relay");
  });

  test("summarises phone transports without exposing non-phone devices", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const ios = createDevice(db, { name: "ios-test-device", kind: "ios" });
    const android = createDevice(db, { name: "android-test-device", kind: "android" });
    const relay = createDevice(db, { name: "relay-test-device", kind: "ios" });
    createDevice(db, { name: "cli-test-device", kind: "cli" });
    setApnsToken(db, ios.id, {
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.example.ios",
      updatedAt: 1,
    });
    setFcmToken(db, android.id, { registrationToken: "opaque-token", updatedAt: 1 });
    setRelayPushConsent(db, relay.id, { appId: "dev.omnesis.ios", grantedAt: 1 });
    setRelayPushRegistration(db, relay.id, {
      relayUrl: "https://relay.example",
      credential: "opaque-credential",
      appId: "dev.omnesis.ios",
    });

    expect(service(db).status().devices).toEqual({
      total: 3,
      directApns: 1,
      directFcm: 1,
      legacyApns: 0,
      legacyFcm: 0,
      relay: 1,
      relayConsented: 1,
      unavailable: 0,
      deliveryHealth: [
        expect.objectContaining({
          name: "ios-test-device",
          transport: "direct-apns",
          status: null,
        }),
        expect.objectContaining({
          name: "android-test-device",
          transport: "direct-fcm",
          status: null,
        }),
        expect.objectContaining({ name: "relay-test-device", transport: "relay", status: null }),
      ],
    });
  });

  test("reports effective availability rather than a stale stored transport", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const relay = createDevice(db, { name: "relay-stale-device", kind: "ios" });
    setRelayPushConsent(db, relay.id, { appId: "dev.omnesis.ios", grantedAt: 1 });
    setRelayPushRegistration(db, relay.id, {
      relayUrl: "https://relay-old.example",
      credential: "opaque-credential",
      appId: "dev.omnesis.ios",
    });
    const subject = new PushAdminService({
      db,
      getSettings: () => undefined,
      getRelaySettings: () => ({
        enabled: true,
        url: "https://relay-current.example",
        visible: true,
      }),
      writeGate: directWriteGate(db),
      pushTransport: new PushTransport({
        publish: () => Promise.resolve([]),
        isAvailable: () => false,
      }),
    });

    expect(subject.status().devices).toMatchObject({
      relay: 0,
      unavailable: 1,
      deliveryHealth: [
        {
          name: "relay-stale-device",
          available: false,
          // A plan the gateway could serve, so what is missing is the registration.
          unavailableReason: "relay registration does not match the configured endpoint",
        },
      ],
    });
  });

  test("a phone the plan cannot serve carries the plan's reason, not a registration one", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const phone = createDevice(db, { name: "self-built-phone", kind: "ios" });
    const subject = new PushAdminService({
      db,
      getSettings: () => undefined,
      planForDevice: (device) =>
        device.id === phone.id
          ? {
              transport: "unavailable",
              reasonCode: "no-direct-credential",
              reason: "no push credential covers dev.example.ios",
            }
          : null,
      writeGate: directWriteGate(db),
      pushTransport: new PushTransport({
        publish: () => Promise.resolve([]),
        isAvailable: () => false,
      }),
    });
    const [entry] = subject.status().devices.deliveryHealth;
    expect(entry).toMatchObject({
      name: "self-built-phone",
      available: false,
      plan: { transport: "unavailable", reasonCode: "no-direct-credential" },
    });
    expect(entry).not.toHaveProperty("unavailableReason");
  });

  test("targets one phone for a diagnostic push and rejects non-phone targets", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const phone = createDevice(db, { name: "target-phone", kind: "ios" });
    const cli = createDevice(db, { name: "target-cli", kind: "cli" });
    const sendTest = vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        exitCode: 0,
        durationMs: 1,
        stdoutTail: "accepted",
        stderrTail: "",
        error: null,
        attempted: 1,
        delivered: 1,
      }),
    );
    const subject = new PushAdminService({
      db,
      getSettings: () => undefined,
      pushTransport: { sendTest } as unknown as PushTransport,
      writeGate: directWriteGate(db),
    });

    await subject.sendTest(phone.id);
    expect(sendTest).toHaveBeenCalledWith([phone.id]);
    await expect(subject.sendTest(cli.id)).rejects.toThrow(/phone-only/);
    await expect(
      subject.sendTest(DeviceId("00000000-0000-4000-8000-000000000099")),
    ).rejects.toThrow(/not found/);
  });

  test("stores phone-reported delivery health and exposes it in status", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const phone = createDevice(db, { name: "ios-health-device", kind: "ios" });
    const changed = { count: 0 };
    const subject = new PushAdminService({
      db,
      getSettings: () => undefined,
      pushTransport: new PushTransport({ publish: () => Promise.resolve([]) }),
      writeGate: directWriteGate(db),
      onDeviceChanged: () => changed.count++,
    });

    const result = await subject.reportDeliveryHealth(phone.id, "scheduled-summary");

    expect(result).toMatchObject({ ok: true });
    expect(changed.count).toBe(1);
    expect(subject.status().devices.deliveryHealth).toEqual([
      expect.objectContaining({
        id: phone.id,
        transport: null,
        status: "scheduled-summary",
        updatedAt: result.updatedAt,
      }),
    ]);
  });

  test("exposes the per-device claim and delivery ledger", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const phone = createDevice(db, { name: "ledger-phone", kind: "ios" });
    enqueueNotification(db, {
      message: {
        kind: "brief",
        title: "Fictional brief",
        body: "An invented summary is ready.",
        data: { briefId: "brief-fictional" },
        collapseId: "brief:fictional",
      },
      deviceIds: [phone.id],
      createdAt: 1_000,
      expiresAt: 10_000,
    });
    const claimed = claimNotification(db, { deviceId: phone.id, now: 2_000 })!;
    confirmNotification(db, { deviceId: phone.id, deliveryId: claimed.id, now: 3_000 });

    expect(service(db).status().devices.deliveryHealth[0]?.queue).toEqual({
      pending: 0,
      leased: 0,
      delivered: 1,
      superseded: 0,
      expired: 0,
      lastClaimedAt: 2_000,
      lastDeliveredAt: 3_000,
      wake: {
        pending: 0,
        leased: 0,
        sent: 1,
        terminal: 0,
        exhausted: 0,
        attempts: 0,
        lastAttemptAt: null,
        lastSuccessAt: 2_000,
        lastOutcome: "sent",
        lastError: null,
        lastTransport: null,
      },
    });
  });

  test("rejects delivery-health reports for non-phone devices", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const cli = createDevice(db, { name: "cli-health-device", kind: "cli" });
    await expect(service(db).reportDeliveryHealth(cli.id, "healthy")).rejects.toThrow(/phone-only/);
  });

  test("imports only the platform credential extension with private permissions", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const dir = mkdtempSync(join(tmpdir(), "omnesis-push-admin-"));
    dirs.push(dir);
    const source = join(dir, "AuthKey_FICTIONAL.p8");
    writeFileSync(source, "fictional-key", { mode: 0o644 });

    const destination = service(db, join(dir, "config")).importCredential({
      platform: "ios",
      sourcePath: source,
    });
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("fictional-key");
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(() =>
      service(db, join(dir, "config")).importCredential({
        platform: "android",
        sourcePath: source,
      }),
    ).toThrow(/\.json/);
  });
});
