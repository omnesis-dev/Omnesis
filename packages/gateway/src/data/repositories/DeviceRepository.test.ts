// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  AccountId,
  SCOPE_ADMIN,
  SCOPE_ANSWER,
  SCOPE_READ,
  SCOPE_SUBSCRIPTIONS_MANAGE,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  writeScope,
  DeviceId,
  SourceType,
} from "@omnesis/types";
import { createAccessLevel } from "../../access/store.js";
import { createDatabase } from "../../db.js";
import {
  bootstrapSelfFromDevices,
  clearApnsToken,
  clearFcmToken,
  createDevice,
  getDevice,
  listDevices,
  listIosDevicesWithApnsToken,
  listAndroidDevicesWithFcmToken,
  deleteDevice,
  findDeviceByInstallId,
  renameDevice,
  revokeDevice,
  setApnsToken,
  setFcmToken,
  setNotificationDeliveryHealth,
  setRelayPushConsent,
  setRelayPushRegistration,
  withdrawRelayPushConsent,
  updateDeviceCapabilities,
  updateDeviceSelfInfo,
  touchDevice,
  createPairing,
  consumePairing,
  revokePairing,
  cleanupExpiredPairings,
  resolveDeviceName,
  findDeviceByName,
  replaceDeviceForRepair,
  setDeviceUpdateRequest,
  peekPairing,
  redeemAgentIntegrationPairing,
  redeemDevicePairing,
} from "./DeviceRepository.js";
import { createSource, listSources } from "./SourceRepository.js";
import { getReauthReminder, reserveReauthReminder } from "./ReauthRemindersRepository.js";
import { createToken, listTokens } from "./TokenRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-devices-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("createDevice", () => {
  test("creates and returns a DeviceRecord", () => {
    const d = createDevice(db, { name: "my-cli", kind: "cli" });
    expect(d.id).toBeDefined();
    expect(d.name).toBe("my-cli");
    expect(d.kind).toBe("cli");
    expect(d.capabilities).toEqual({});
    expect(d.pairedAt).toBeGreaterThan(0);
    expect(d.lastSeenAt).toBeNull();
    expect(d.pushTransport).toBeNull();
    expect(d.relayUrl).toBeNull();
    expect(d.relayCredential).toBeNull();
    expect(d.relayConsent).toBeNull();
  });

  test("stores capabilities JSON", () => {
    const d = createDevice(db, {
      name: "mac-collector",
      kind: "collector",
      capabilities: { hostname: "marzipan", hostableSourceTypes: [SourceType("gmail")] },
    });
    expect(d.capabilities.hostname).toBe("marzipan");
  });

  test("rejects invalid kind", () => {
    expect(() => createDevice(db, { name: "x", kind: "bogus" as never })).toThrow();
  });

  test("rejects duplicate name", () => {
    createDevice(db, { name: "dup", kind: "cli" });
    expect(() => createDevice(db, { name: "dup", kind: "cli" })).toThrow();
  });
});

describe("getDevice / listDevices", () => {
  test("listDevices returns devices in paired_at order", async () => {
    const a = createDevice(db, { name: "a", kind: "cli" });
    await new Promise((r) => setTimeout(r, 5));
    const b = createDevice(db, { name: "b", kind: "portal" });
    const list = listDevices(db);
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]);
  });

  test("getDevice returns null for unknown id", () => {
    expect(getDevice(db, "nope" as never)).toBeNull();
  });
});

describe("updateDeviceCapabilities + touchDevice", () => {
  test("updates capabilities and last_seen_at", () => {
    const d = createDevice(db, { name: "d", kind: "collector" });
    updateDeviceCapabilities(db, d.id, { hostname: "new-host", platform: "macos" });
    const reloaded = getDevice(db, d.id)!;
    expect(reloaded.capabilities.hostname).toBe("new-host");
    expect(reloaded.capabilities.platform).toBe("macos");
    expect(reloaded.lastSeenAt).not.toBeNull();
  });

  test("touchDevice bumps last_seen_at without changing capabilities", () => {
    const d = createDevice(db, { name: "d", kind: "collector", capabilities: { hostname: "a" } });
    touchDevice(db, d.id);
    const r = getDevice(db, d.id)!;
    expect(r.lastSeenAt).not.toBeNull();
    expect(r.capabilities.hostname).toBe("a");
  });
});

describe("deleteDevice", () => {
  test("deletes and returns true", () => {
    const d = createDevice(db, { name: "d", kind: "cli" });
    expect(deleteDevice(db, d.id)).toBe(true);
    expect(getDevice(db, d.id)).toBeNull();
  });

  test("returns false for unknown id", () => {
    expect(deleteDevice(db, "nope" as never)).toBe(false);
  });

  test("drops the device's re-auth reminder episodes and leaves a sibling's", () => {
    const principal = "fictional-provider:maya@example.com";
    const forgotten = createDevice(db, { name: "Maya-Laptop", kind: "collector" });
    const sibling = createDevice(db, { name: "Studio-Mini", kind: "collector" });
    for (const device of [forgotten, sibling]) {
      expect(reserveReauthReminder(db, principal, device.id, 0, 1_000, () => true)).not.toBeNull();
    }

    expect(deleteDevice(db, forgotten.id)).toBe(true);

    expect(getReauthReminder(db, principal, forgotten.id)).toBeNull();
    expect(getReauthReminder(db, principal, sibling.id)).not.toBeNull();
  });
});

describe("revokeDevice", () => {
  test("keeps the row, stamps revoked_at, and kills the tokens", () => {
    const d = createDevice(db, { name: "revocable", kind: "collector" });
    createToken(db, d.id, [SCOPE_READ], "t1");
    expect(revokeDevice(db, d.id)).toBe(true);

    const after = getDevice(db, d.id);
    expect(after).not.toBeNull();
    expect(after?.revokedAt).not.toBeNull();
    expect(listTokens(db, d.id)).toHaveLength(0);
  });

  test("also revokes principal credentials bound to an integration device", () => {
    const device = createDevice(db, { name: "fictional-runtime", kind: "agent" });
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-device-revoke', 'Fictional assistant', 'interactive', 1, 1);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES ('grant-device-revoke', 'principal-device-revoke', 'Answer', 1, 1);
    `);
    db.prepare(
      `INSERT INTO principal_credentials
         (id, grant_id, oauth_client_id, kind, label, execution_device_id, created_at)
       VALUES ('credential-device-revoke', 'grant-device-revoke', 'client-device-revoke',
               'interactive', 'Fictional runtime', ?, 1)`,
    ).run(device.id);

    expect(revokeDevice(db, device.id)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT revoked_at FROM principal_credentials WHERE id = 'credential-device-revoke'",
        )
        .get(),
    ).toEqual({ revoked_at: expect.any(Number) });
  });

  test("is idempotent and returns false for unknown ids", () => {
    const d = createDevice(db, { name: "revocable-2", kind: "cli" });
    expect(revokeDevice(db, d.id)).toBe(true);
    const first = getDevice(db, d.id)?.revokedAt;
    expect(revokeDevice(db, d.id)).toBe(true);
    expect(getDevice(db, d.id)?.revokedAt).toBe(first);
    expect(revokeDevice(db, "nope" as never)).toBe(false);
  });

  test("a same-name repair adopts the revoked row: id kept, revocation cleared", () => {
    // The phone-was-unpaired-by-mistake recovery: revoke keeps the row, so
    // pairing again under the same name goes through the repair path and
    // the device identity (per-device cursors, stream keys) survives.
    const d = createDevice(db, { name: "recoverable", kind: "collector" });
    revokeDevice(db, d.id);

    const repaired = replaceDeviceForRepair(db, d.id, {
      name: "recoverable",
      kind: "collector",
    });
    expect(repaired.id).toBe(d.id);
    expect(getDevice(db, d.id)?.revokedAt).toBeNull();
  });

  test("a new device is on no access level", () => {
    const d = createDevice(db, { name: "levelless", kind: "cli" });
    expect(d.accessLevelId).toBeNull();
    expect(getDevice(db, d.id)?.accessLevelId).toBeNull();
  });

  test("a repair keeps the device's access level", () => {
    const d = createDevice(db, { name: "levelheld", kind: "cli" });
    // The level is written by the access store; the repository only carries it.
    db.prepare("UPDATE devices SET access_level_id = ? WHERE id = ?").run("level-1", d.id);
    revokeDevice(db, d.id);

    const repaired = replaceDeviceForRepair(db, d.id, { name: "levelheld", kind: "cli" });
    expect(repaired.accessLevelId).toBe("level-1");
    expect(getDevice(db, d.id)?.accessLevelId).toBe("level-1");
  });
});

describe("pairing flow", () => {
  test("device redemption commits code, adoption, self info, and credential atomically", () => {
    const pairing = createPairing(db, {
      kind: "ios",
      scopes: [SCOPE_ADMIN],
      selfEmails: ["maya.reeves@example.com"],
    });
    const result = redeemDevicePairing(db, {
      pairingCode: pairing.pairingCode,
      expectedKind: "ios",
      capabilities: { installId: "fictional-install", suggestedName: "fictional-phone" },
    });

    expect(result.outcome).toBe("paired");
    if (result.outcome !== "paired") throw new Error("expected paired result");
    expect(peekPairing(db, pairing.pairingCode)).toBeNull();
    expect(getDevice(db, result.device.id)?.selfEmails).toEqual(["maya.reeves@example.com"]);
    expect(listTokens(db, result.device.id).map((token) => token.id)).toEqual([result.tokenId]);
  });

  test("device redemption rolls every phase back when credential minting fails", () => {
    const pairing = createPairing(db, { kind: "ios", scopes: [SCOPE_ADMIN] });
    db.exec(`CREATE TRIGGER reject_test_token BEFORE INSERT ON tokens
      BEGIN SELECT RAISE(ABORT, 'synthetic token failure'); END`);

    expect(() =>
      redeemDevicePairing(db, {
        pairingCode: pairing.pairingCode,
        expectedKind: "ios",
        capabilities: { installId: "rollback-install", suggestedName: "rollback-phone" },
      }),
    ).toThrow("synthetic token failure");
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
    expect(findDeviceByInstallId(db, "ios", "rollback-install")).toBeNull();
  });

  test("an integration pairs only with answer-bounded scopes", () => {
    const wide = createPairing(db, { kind: "integration", scopes: [SCOPE_ADMIN] });
    const refused = redeemDevicePairing(db, {
      pairingCode: wide.pairingCode,
      expectedKind: "integration",
      capabilities: { installId: "fictional-voice-install" },
    });
    expect(refused).toMatchObject({ outcome: "conflict" });
    if (refused.outcome !== "conflict") throw new Error("expected a conflict");
    expect(refused.error).toContain("integration");
    expect(peekPairing(db, wide.pairingCode)).not.toBeNull();
  });

  test("an integration's pairing code puts it on the access level chosen for it", () => {
    const level = createAccessLevel(
      db,
      {
        name: "Voice answers",
        rules: [
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
        ],
        actorTokenId: "portal-token",
      },
      Date.now(),
    );
    if (!level.ok) throw new Error("level not created");
    const pairing = createPairing(db, {
      kind: "integration",
      scopes: [SCOPE_ANSWER],
      accessLevelId: level.value.id,
    });
    expect(peekPairing(db, pairing.pairingCode)?.accessLevelId).toBe(level.value.id);
    const paired = redeemDevicePairing(db, {
      pairingCode: pairing.pairingCode,
      expectedKind: "integration",
      capabilities: { installId: "fictional-voice-install", suggestedName: "voice-desk" },
    });
    expect(paired).toMatchObject({
      outcome: "paired",
      device: { kind: "integration", accessLevelId: level.value.id },
    });

    // A code minted without one leaves the integration on none.
    const bare = createPairing(db, { kind: "integration", scopes: [SCOPE_ANSWER] });
    expect(
      redeemDevicePairing(db, {
        pairingCode: bare.pairingCode,
        expectedKind: "integration",
        capabilities: { installId: "fictional-other-install", suggestedName: "other-desk" },
      }),
    ).toMatchObject({ outcome: "paired", device: { accessLevelId: null } });
  });

  test("online-adoption conflict leaves the pairing code intact for the retry", () => {
    const existing = createDevice(db, {
      name: "fictional-collector",
      kind: "collector",
      capabilities: { installId: "fictional-collector-install" },
    });
    const oldToken = createToken(db, existing.id, [SCOPE_READ], "fictional-existing-token");
    const pairing = createPairing(db, { kind: "collector", scopes: [SCOPE_ADMIN] });

    const result = redeemDevicePairing(db, {
      pairingCode: pairing.pairingCode,
      expectedKind: "collector",
      capabilities: {
        installId: "fictional-collector-install",
        suggestedName: "fictional-collector",
      },
      onlineDeviceIds: [existing.id],
    });

    expect(result).toMatchObject({ outcome: "conflict" });
    // The 409 tells the operator to disconnect the device and pair it again,
    // so the one-shot code has to survive for that retry.
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
    expect(listTokens(db, existing.id).map((token) => token.id)).toEqual([oldToken.id]);
  });

  test("name-reserved conflict leaves the pairing code intact for the retry", () => {
    const existing = createDevice(db, { name: "fictional-shared-name", kind: "cli" });
    const pairing = createPairing(db, {
      name: "fictional-shared-name",
      kind: "ios",
      scopes: [SCOPE_ADMIN],
    });

    const result = redeemDevicePairing(db, {
      pairingCode: pairing.pairingCode,
      expectedKind: "ios",
      capabilities: { installId: "fictional-phone-install" },
    });

    expect(result).toMatchObject({ outcome: "conflict" });
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
    expect(findDeviceByName(db, "fictional-shared-name")?.id).toBe(existing.id);
    expect(listTokens(db)).toHaveLength(0);
  });

  test("later concurrent-install redemption is the only active generation", () => {
    const firstCode = createPairing(db, { kind: "ios", scopes: [SCOPE_ADMIN] });
    const secondCode = createPairing(db, { kind: "ios", scopes: [SCOPE_ADMIN] });
    const capabilities = { installId: "shared-install", suggestedName: "shared-phone" };
    const first = redeemDevicePairing(db, {
      pairingCode: firstCode.pairingCode,
      expectedKind: "ios",
      capabilities,
    });
    const second = redeemDevicePairing(db, {
      pairingCode: secondCode.pairingCode,
      expectedKind: "ios",
      capabilities,
    });

    expect(first.outcome).toBe("paired");
    expect(second.outcome).toBe("paired");
    if (first.outcome !== "paired" || second.outcome !== "paired") {
      throw new Error("expected paired results");
    }
    expect(second.device.id).toBe(first.device.id);
    expect(second.tokenId).not.toBe(first.tokenId);
    expect(listTokens(db, second.device.id).map((token) => token.id)).toEqual([second.tokenId]);
  });

  const openClawCapabilities = {
    suggestedName: "fictional-openclaw",
    agentIntegration: {
      harness: "openclaw" as const,
      deliveryProtocolMin: 3,
      deliveryProtocolMax: 3,
      maxConcurrentRuns: 2,
    },
  };

  test("createPairing returns a code with scopes + expiry", () => {
    const p = createPairing(db, {
      name: "new-cli",
      kind: "cli",
      scopes: [SCOPE_ADMIN, SCOPE_READ],
    });
    expect(p.pairingCode).toMatch(/^[0-9A-F]{10}$/);
    expect(p.scopes).toEqual([SCOPE_ADMIN, SCOPE_READ]);
    expect(p.expiresAt).toBeGreaterThan(p.createdAt);
  });

  test("rejects invalid scope", () => {
    expect(() =>
      createPairing(db, { name: "x", kind: "cli", scopes: ["bogus" as never] }),
    ).toThrow();
  });

  test("consumePairing returns the pending pairing and deletes it", () => {
    const p = createPairing(db, {
      name: "ios",
      kind: "ios",
      scopes: [SCOPE_ADMIN, writeScope(SourceType("apple-health"))],
    });
    const consumed = consumePairing(db, p.pairingCode)!;
    expect(consumed.name).toBe("ios");
    expect(consumed.scopes).toContain("write:apple-health");
    // One-shot: second call returns null
    expect(consumePairing(db, p.pairingCode)).toBeNull();
  });

  test("kind-scoped consume does NOT burn a code of a different kind", () => {
    const p = createPairing(db, { name: "cli", kind: "cli", scopes: [SCOPE_READ] });
    // A portal login attempt on a cli code must miss AND leave it intact.
    expect(consumePairing(db, p.pairingCode, "portal")).toBeNull();
    // The code is still redeemable by the kind it was minted for.
    const consumed = consumePairing(db, p.pairingCode, "cli")!;
    expect(consumed.kind).toBe("cli");
    // ...and only once.
    expect(consumePairing(db, p.pairingCode, "cli")).toBeNull();
  });

  test("kind-scoped consume redeems and deletes a matching code", () => {
    const p = createPairing(db, { name: "portal", kind: "portal", scopes: [SCOPE_READ] });
    const consumed = consumePairing(db, p.pairingCode, "portal")!;
    expect(consumed.kind).toBe("portal");
    expect(consumePairing(db, p.pairingCode, "portal")).toBeNull();
  });

  test("revokePairing invalidates only an unused matching code", () => {
    const first = createPairing(db, { name: "first", kind: "ios", scopes: [SCOPE_READ] });
    const second = createPairing(db, { name: "second", kind: "ios", scopes: [SCOPE_READ] });
    expect(revokePairing(db, first.pairingCode)).toBe(true);
    expect(revokePairing(db, first.pairingCode)).toBe(false);
    expect(consumePairing(db, first.pairingCode)).toBeNull();
    expect(consumePairing(db, second.pairingCode)?.name).toBe("second");
  });

  test("consumePairing returns null for expired pairing", () => {
    const p = createPairing(db, { name: "x", kind: "cli", scopes: [SCOPE_READ], ttlMs: 1 });
    // Wait past expiry.
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(consumePairing(db, p.pairingCode)).toBeNull();
        resolve(undefined);
      }, 10);
    });
  });

  test("cleanupExpiredPairings removes expired rows", async () => {
    createPairing(db, { name: "x", kind: "cli", scopes: [SCOPE_READ], ttlMs: 1 });
    createPairing(db, { name: "y", kind: "cli", scopes: [SCOPE_READ] });
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanupExpiredPairings(db)).toBe(1);
  });

  test("createPairing accepts no name (admin-skipped)", () => {
    const p = createPairing(db, { kind: "ios", scopes: [SCOPE_READ] });
    expect(p.name).toBe("");
    const consumed = consumePairing(db, p.pairingCode)!;
    expect(consumed.name).toBe("");
  });

  test("createPairing trims whitespace-only name to empty", () => {
    const p = createPairing(db, { name: "   ", kind: "cli", scopes: [SCOPE_READ] });
    expect(p.name).toBe("");
  });

  // Self annotation staged with the pairing code, carried back through
  // consumePairing so the redeem path can apply it to the new device.
  test("createPairing carries staged self info through consumePairing", () => {
    const p = createPairing(db, {
      name: "selfdev",
      kind: "cli",
      scopes: [SCOPE_READ],
      selfEmails: ["owner@example.com"],
      selfPhones: ["+12025550123"],
    });
    expect(p.selfEmails).toEqual(["owner@example.com"]);
    expect(p.selfPhones).toEqual(["+12025550123"]);

    const consumed = consumePairing(db, p.pairingCode)!;
    expect(consumed.selfEmails).toEqual(["owner@example.com"]);
    expect(consumed.selfPhones).toEqual(["+12025550123"]);
  });

  test("createPairing defaults self info to empty arrays when omitted", () => {
    const p = createPairing(db, { name: "noself", kind: "cli", scopes: [SCOPE_READ] });
    expect(p.selfEmails).toEqual([]);
    expect(p.selfPhones).toEqual([]);
    const consumed = consumePairing(db, p.pairingCode)!;
    expect(consumed.selfEmails).toEqual([]);
    expect(consumed.selfPhones).toEqual([]);
  });

  test("persists an exact agent repair target with the pairing code", () => {
    const existing = createDevice(db, {
      name: "fictional-openclaw",
      kind: "agent",
      capabilities: openClawCapabilities,
    });
    const pairing = createPairing(db, {
      name: existing.name,
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
      repairDeviceId: existing.id,
    });
    expect(pairing.repairDeviceId).toBe(existing.id);
    expect(peekPairing(db, pairing.pairingCode)?.repairDeviceId).toBe(existing.id);
  });

  test("atomically redeems an agent integration into three least-privilege credentials", () => {
    const pairing = createPairing(db, {
      name: "fictional-openclaw",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
      selfEmails: ["maya.reeves@example.com"],
    });
    const result = redeemAgentIntegrationPairing(db, {
      pairingCode: pairing.pairingCode,
      harness: "openclaw",
      capabilities: openClawCapabilities,
    });

    expect(result).toMatchObject({
      outcome: "paired",
      device: {
        name: "fictional-openclaw",
        kind: "agent",
        selfEmails: ["maya.reeves@example.com"],
      },
    });
    if (result.outcome !== "paired") throw new Error("expected paired result");
    expect(result.credentials.delivery.scopes).toEqual([SCOPE_SUBSCRIPTIONS_RECEIVE]);
    expect(result.credentials.ingestion.scopes).toEqual([writeScope(SourceType("openclaw"))]);
    expect(result.credentials.management.scopes).toEqual([SCOPE_SUBSCRIPTIONS_MANAGE]);
    expect(
      listTokens(db, result.device.id)
        .map((token) => ({ name: token.name, scopes: token.scopes }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        name: "openclaw-conversation-ingestion",
        scopes: [writeScope(SourceType("openclaw"))],
      },
      {
        name: "openclaw-management",
        scopes: [SCOPE_SUBSCRIPTIONS_MANAGE],
      },
      {
        name: "openclaw-subscription-delivery",
        scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
      },
    ]);
    expect(peekPairing(db, pairing.pairingCode)).toBeNull();
  });

  test("replays one agent redemption exactly for the same crash-recovery key", () => {
    const pairing = createPairing(db, {
      name: "fictional-hermes",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });
    const idempotencyKey = "r".repeat(43);
    const input = {
      pairingCode: pairing.pairingCode,
      harness: "hermes" as const,
      capabilities: {
        ...openClawCapabilities,
        agentIntegration: {
          ...openClawCapabilities.agentIntegration!,
          harness: "hermes" as const,
        },
      },
      idempotencyKey,
    };

    const first = redeemAgentIntegrationPairing(db, input);
    const replay = redeemAgentIntegrationPairing(db, input);

    expect(first).toMatchObject({ outcome: "paired", replayed: false });
    if (first.outcome !== "paired" || replay.outcome !== "paired") {
      throw new Error("expected paired results");
    }
    expect(replay).toEqual({ ...first, replayed: true });
    expect(listTokens(db)).toHaveLength(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices WHERE kind = 'agent'").get()).toEqual({
      count: 1,
    });
    const sealed = db
      .prepare("SELECT sealed_response, created_at, expires_at FROM pairing_redemption_receipts")
      .get() as { sealed_response: string; created_at: number; expires_at: number };
    expect(sealed.sealed_response).not.toContain(first.credentials.delivery.token);
    expect(sealed.expires_at - sealed.created_at).toBe(24 * 60 * 60 * 1000);

    expect(redeemAgentIntegrationPairing(db, { ...input, idempotencyKey: "s".repeat(43) })).toEqual(
      { outcome: "invalid", error: "invalid or expired pairing code" },
    );
    expect(
      redeemAgentIntegrationPairing(db, {
        ...input,
        pairingCode: "DIFFERENT-CODE",
      }),
    ).toEqual({ outcome: "conflict", error: "pairing idempotency key was reused" });

    db.prepare("UPDATE pairing_redemption_receipts SET expires_at = 0").run();
    expect(redeemAgentIntegrationPairing(db, input)).toEqual({
      outcome: "invalid",
      error: "expired pairing redemption receipt",
    });
  });

  test("replays one device redemption exactly for the same crash-recovery key", () => {
    const pairing = createPairing(db, { kind: "browser", scopes: [writeScope(SourceType("web"))] });
    const idempotencyKey = "b".repeat(43);
    const input = {
      pairingCode: pairing.pairingCode,
      expectedKind: "browser" as const,
      capabilities: { platform: "web", installId: "fictional-browser-install" },
      idempotencyKey,
    };

    const first = redeemDevicePairing(db, input);
    // The code is spent; the response is lost; the client sends the same
    // request again. It must get the same device and the same token back.
    const replay = redeemDevicePairing(db, { ...input, expectedKind: undefined });

    expect(first).toMatchObject({ outcome: "paired", replayed: false });
    if (first.outcome !== "paired" || replay.outcome !== "paired") {
      throw new Error("expected paired results");
    }
    expect(replay).toEqual({ ...first, replayed: true });
    expect(listTokens(db, first.device.id)).toHaveLength(1);
    const sealed = db.prepare("SELECT sealed_response FROM pairing_redemption_receipts").get() as {
      sealed_response: string;
    };
    expect(sealed.sealed_response).not.toContain(first.token);

    // A different key with the same spent code is an ordinary invalid code;
    // the same key with a different code or different capabilities is misuse.
    expect(redeemDevicePairing(db, { ...input, idempotencyKey: "c".repeat(43) })).toEqual({
      outcome: "invalid",
    });
    expect(redeemDevicePairing(db, { ...input, pairingCode: "DIFFERENT-CODE" })).toEqual({
      outcome: "conflict",
      error: "pairing idempotency key was reused",
    });
    expect(
      redeemDevicePairing(db, {
        ...input,
        capabilities: { platform: "web", installId: "another-install" },
      }),
    ).toEqual({ outcome: "conflict", error: "pairing idempotency key was reused" });

    db.prepare("UPDATE pairing_redemption_receipts SET expires_at = 0").run();
    expect(redeemDevicePairing(db, input)).toEqual({ outcome: "invalid" });
  });

  test("a replay attempt with no receipt never consumes a code whose kind it could not name", () => {
    const pairing = createPairing(db, { kind: "browser", scopes: [writeScope(SourceType("web"))] });
    expect(
      redeemDevicePairing(db, {
        pairingCode: pairing.pairingCode,
        capabilities: { platform: "web" },
        idempotencyKey: "z".repeat(43),
      }),
    ).toEqual({ outcome: "invalid" });
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
  });

  test("invalid agent identity rolls back and leaves the one-time code redeemable", () => {
    const pairing = createPairing(db, {
      name: "fictional-openclaw",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });
    expect(
      redeemAgentIntegrationPairing(db, {
        pairingCode: pairing.pairingCode,
        harness: "hermes",
        capabilities: openClawCapabilities,
      }),
    ).toEqual({
      outcome: "invalid",
      error: "invalid agent integration pairing contract",
    });
    expect(peekPairing(db, pairing.pairingCode)?.kind).toBe("agent");
    expect(findDeviceByName(db, "fictional-openclaw")).toBeNull();
    expect(listTokens(db)).toHaveLength(0);
  });

  test("device-name conflict rolls the code, device, and tokens back together", () => {
    const existing = createDevice(db, { name: "fictional-openclaw", kind: "cli" });
    const oldToken = createToken(db, existing.id, [SCOPE_READ], "existing-token");
    const pairing = createPairing(db, {
      name: "fictional-openclaw",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });
    expect(
      redeemAgentIntegrationPairing(db, {
        pairingCode: pairing.pairingCode,
        harness: "openclaw",
        capabilities: openClawCapabilities,
      }),
    ).toMatchObject({ outcome: "conflict" });
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
    expect(findDeviceByName(db, "fictional-openclaw")?.id).toBe(existing.id);
    expect(listTokens(db, existing.id).map((token) => token.id)).toEqual([oldToken.id]);
  });

  test("repairs only the exact device bound when the code was minted", () => {
    const existing = createDevice(db, {
      name: "fictional-openclaw",
      kind: "agent",
      capabilities: openClawCapabilities,
    });
    const oldToken = createToken(
      db,
      existing.id,
      [SCOPE_SUBSCRIPTIONS_RECEIVE],
      "fictional-old-delivery",
    );
    const pairing = createPairing(db, {
      name: existing.name,
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
      repairDeviceId: existing.id,
    });

    expect(
      redeemAgentIntegrationPairing(db, {
        pairingCode: pairing.pairingCode,
        harness: "openclaw",
        capabilities: openClawCapabilities,
        repairDeviceId: existing.id,
      }),
    ).toMatchObject({ outcome: "paired", device: { id: existing.id } });
    expect(listTokens(db, existing.id)).toHaveLength(3);
    expect(listTokens(db, existing.id).some((token) => token.id === oldToken.id)).toBe(false);
  });

  test("rejects a caller-selected repair target not bound into the code", () => {
    const existing = createDevice(db, {
      name: "fictional-openclaw",
      kind: "agent",
      capabilities: openClawCapabilities,
    });
    const oldToken = createToken(
      db,
      existing.id,
      [SCOPE_SUBSCRIPTIONS_RECEIVE],
      "fictional-old-delivery",
    );
    const pairing = createPairing(db, {
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });

    expect(
      redeemAgentIntegrationPairing(db, {
        pairingCode: pairing.pairingCode,
        harness: "openclaw",
        capabilities: openClawCapabilities,
        repairDeviceId: existing.id,
      }),
    ).toMatchObject({ outcome: "conflict" });
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
    expect(listTokens(db, existing.id).map((token) => token.id)).toEqual([oldToken.id]);
  });
});

describe("resolveDeviceName", () => {
  test("admin-supplied name wins", () => {
    expect(resolveDeviceName("alice", "ios", { suggestedName: "ignored" })).toBe("alice");
  });

  test("falls back to capabilities.suggestedName when admin name empty", () => {
    expect(resolveDeviceName("", "ios", { suggestedName: "iPhone-Perso-iphone" })).toBe(
      "iPhone-Perso-iphone",
    );
  });

  test("trims both inputs", () => {
    expect(resolveDeviceName("  bob  ", "cli", {})).toBe("bob");
    expect(resolveDeviceName("", "cli", { suggestedName: "  charlie  " })).toBe("charlie");
  });

  test("falls back to <kind>-<short> when both missing", () => {
    const name = resolveDeviceName("", "cli", {});
    expect(name).toMatch(/^cli-[0-9a-f]{8}$/);
  });

  test("kind-based fallback differs per kind", () => {
    const a = resolveDeviceName("", "android", {});
    const b = resolveDeviceName("", "ios", {});
    expect(a.startsWith("android-")).toBe(true);
    expect(b.startsWith("ios-")).toBe(true);
  });

  test("blank portal pairings resolve to the stable canonical name", () => {
    // Browser logins without a name collapse onto one reusable "portal" row
    // (the by-name reuse in createOrReplaceDeviceForPair), so they stop
    // accumulating ghost portal-<hex> devices.
    expect(resolveDeviceName("", "portal", {})).toBe("portal");
    expect(resolveDeviceName("", "portal", {})).toBe("portal");
    // An explicit or device-suggested name still wins, so a deliberately
    // named portal device is never forced onto the canonical row.
    expect(resolveDeviceName("my-laptop", "portal", {})).toBe("my-laptop");
    expect(resolveDeviceName("", "portal", { suggestedName: "kiosk" })).toBe("kiosk");
  });
});

describe("findDeviceByName", () => {
  test("returns null when no device has that name", () => {
    expect(findDeviceByName(db, "nope")).toBeNull();
  });

  test("returns the matching device", () => {
    const d = createDevice(db, { name: "iphone", kind: "ios" });
    const found = findDeviceByName(db, "iphone");
    expect(found?.id).toBe(d.id);
    expect(found?.kind).toBe("ios");
  });
});

describe("replaceDeviceForRepair", () => {
  test("repairs the existing device identity in place so durable owned state survives", () => {
    const oldDev = createDevice(db, { name: "iphone", kind: "ios" });
    createSource(db, {
      type: SourceType("apple-health"),
      accountId: AccountId("local"),
      deviceId: oldDev.id,
    });

    const repaired = replaceDeviceForRepair(db, oldDev.id, { name: "iphone", kind: "ios" });

    expect(repaired.id).toBe(oldDev.id);
    expect(repaired.name).toBe("iphone");
    expect(getDevice(db, oldDev.id)?.name).toBe("iphone");

    const sources = listSources(db);
    expect(sources).toHaveLength(1);
    expect(sources[0].deviceId).toBe(repaired.id);
    expect(sources[0].id).toBe("apple-health:local");
  });

  test("cascades token deletion for the replaced device", () => {
    const oldDev = createDevice(db, { name: "iphone", kind: "ios" });
    createToken(db, oldDev.id, [SCOPE_READ, writeScope("apple-health")], "old");

    const repaired = replaceDeviceForRepair(db, oldDev.id, { name: "iphone", kind: "ios" });

    expect(listTokens(db, oldDev.id)).toHaveLength(0);
    expect(listTokens(db, repaired.id)).toHaveLength(0);
  });

  test("rejects invalid kind", () => {
    const old = createDevice(db, { name: "x", kind: "ios" });
    expect(() =>
      replaceDeviceForRepair(db, old.id, { name: "x", kind: "bogus" as never }),
    ).toThrow();
  });

  test("requires a non-empty name", () => {
    const old = createDevice(db, { name: "x", kind: "ios" });
    expect(() => replaceDeviceForRepair(db, old.id, { name: "", kind: "ios" })).toThrow();
  });
});

// Device self annotation
describe("device self annotation", () => {
  test("createDevice initializes empty selfEmails / selfPhones", () => {
    const d = createDevice(db, { name: "mac", kind: "collector" });
    expect(d.selfEmails).toEqual([]);
    expect(d.selfPhones).toEqual([]);
    const reloaded = getDevice(db, d.id)!;
    expect(reloaded.selfEmails).toEqual([]);
    expect(reloaded.selfPhones).toEqual([]);
  });

  test("updateDeviceSelfInfo persists emails and phones", () => {
    const d = createDevice(db, { name: "mac", kind: "collector" });
    updateDeviceSelfInfo(db, d.id, {
      selfEmails: ["me@example.com"],
      selfPhones: ["+447700000000"],
    });
    const r = getDevice(db, d.id)!;
    expect(r.selfEmails).toEqual(["me@example.com"]);
    expect(r.selfPhones).toEqual(["+447700000000"]);
  });

  test("updateDeviceSelfInfo with only emails leaves phones untouched", () => {
    const d = createDevice(db, { name: "mac", kind: "collector" });
    updateDeviceSelfInfo(db, d.id, {
      selfEmails: ["a@x.com"],
      selfPhones: ["+1"],
    });
    updateDeviceSelfInfo(db, d.id, { selfEmails: ["b@x.com"] });
    const r = getDevice(db, d.id)!;
    expect(r.selfEmails).toEqual(["b@x.com"]);
    expect(r.selfPhones).toEqual(["+1"]);
  });

  test("listDevices surfaces self info", () => {
    const a = createDevice(db, { name: "a", kind: "cli" });
    updateDeviceSelfInfo(db, a.id, { selfEmails: ["me@x.com"] });
    const list = listDevices(db);
    const reloaded = list.find((d) => d.id === a.id)!;
    expect(reloaded.selfEmails).toEqual(["me@x.com"]);
  });
});

describe("APNs registration", () => {
  const TOKEN_A = "a".repeat(64);
  const TOKEN_B = "b".repeat(64);

  test("createDevice yields apnsRegistration: null", () => {
    const d = createDevice(db, { name: "iphone", kind: "ios" });
    expect(d.apnsRegistration).toBeNull();
  });

  test("setApnsToken persists and is round-tripped via getDevice", () => {
    const d = createDevice(db, { name: "iphone", kind: "ios" });
    setApnsToken(db, d.id, {
      deviceToken: TOKEN_A,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1_700_000_000_000,
    });
    const r = getDevice(db, d.id)!;
    expect(r.apnsRegistration).toEqual({
      deviceToken: TOKEN_A,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1_700_000_000_000,
    });
    expect(r.pushTransport).toBe("direct-apns");
    expect(r.relayUrl).toBeNull();
    expect(r.relayCredential).toBeNull();
  });

  test("setApnsToken replaces a prior registration wholesale", () => {
    const d = createDevice(db, { name: "iphone", kind: "ios" });
    setApnsToken(db, d.id, {
      deviceToken: TOKEN_A,
      environment: "sandbox",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1,
    });
    setApnsToken(db, d.id, {
      deviceToken: TOKEN_B,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 2,
    });
    const r = getDevice(db, d.id)!;
    expect(r.apnsRegistration?.deviceToken).toBe(TOKEN_B);
    expect(r.apnsRegistration?.environment).toBe("production");
    expect(r.apnsRegistration?.updatedAt).toBe(2);
  });

  test("setApnsToken throws on missing device id", () => {
    expect(() =>
      setApnsToken(db, "ffffffff-ffff-ffff-ffff-ffffffffffff" as never, {
        deviceToken: TOKEN_A,
        environment: "production",
        bundleId: "dev.omnesis.ios",
        updatedAt: 1,
      }),
    ).toThrow(/not found/);
  });

  test("clearApnsToken nulls the registration", () => {
    const d = createDevice(db, { name: "iphone", kind: "ios" });
    setApnsToken(db, d.id, {
      deviceToken: TOKEN_A,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1,
    });
    clearApnsToken(db, d.id);
    expect(getDevice(db, d.id)).toMatchObject({
      apnsRegistration: null,
      pushTransport: null,
    });
  });

  test("conditional APNs cleanup preserves a token rotated in flight", () => {
    const d = createDevice(db, { name: "rotated-iphone", kind: "ios" });
    setApnsToken(db, d.id, {
      deviceToken: TOKEN_A,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1,
    });
    setApnsToken(db, d.id, {
      deviceToken: TOKEN_B,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 2,
    });
    expect(
      clearApnsToken(db, d.id, {
        deviceToken: TOKEN_A,
        environment: "production",
        bundleId: "dev.omnesis.ios",
        updatedAt: 1,
      }),
    ).toBe(false);
    expect(getDevice(db, d.id)?.apnsRegistration?.deviceToken).toBe(TOKEN_B);
  });

  test("conditional APNs cleanup preserves a reissued token generation", () => {
    const d = createDevice(db, { name: "reissued-iphone", kind: "ios" });
    const old = {
      deviceToken: TOKEN_A,
      environment: "production" as const,
      bundleId: "dev.omnesis.ios",
      updatedAt: 1,
    };
    setApnsToken(db, d.id, old);
    setApnsToken(db, d.id, { ...old, updatedAt: 2 });
    expect(clearApnsToken(db, d.id, old)).toBe(false);
    expect(getDevice(db, d.id)?.apnsRegistration?.updatedAt).toBe(2);
  });

  test("listIosDevicesWithApnsToken excludes non-iOS and unregistered iOS devices", () => {
    const cli = createDevice(db, { name: "cli", kind: "cli" });
    const ios1 = createDevice(db, { name: "iphone-1", kind: "ios" });
    const ios2 = createDevice(db, { name: "iphone-2", kind: "ios" });
    setApnsToken(db, ios1.id, {
      deviceToken: TOKEN_A,
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1,
    });
    // Even if a non-iOS device somehow had APNs columns populated, the
    // query filters it out by `kind = 'ios'`.
    const all = listIosDevicesWithApnsToken(db);
    const ids = all.map((d) => d.id).sort();
    expect(ids).toEqual([ios1.id]);
    expect(ids).not.toContain(cli.id);
    expect(ids).not.toContain(ios2.id);
  });

  test("listIosDevicesWithApnsToken returns empty when no iOS devices have tokens", () => {
    createDevice(db, { name: "iphone", kind: "ios" });
    expect(listIosDevicesWithApnsToken(db)).toEqual([]);
  });
});

describe("FCM registration", () => {
  test("sets, replaces, lists, and clears an Android registration", () => {
    const android = createDevice(db, { name: "android-phone", kind: "android" });
    const ios = createDevice(db, { name: "iphone", kind: "ios" });
    expect(android.fcmRegistration).toBeNull();

    setFcmToken(db, android.id, { registrationToken: "fcm-token-one", updatedAt: 1 });
    setFcmToken(db, android.id, { registrationToken: "fcm-token-two", updatedAt: 2 });
    // A wrongly populated non-Android row must never enter the fan-out list.
    setFcmToken(db, ios.id, { registrationToken: "wrong-platform", updatedAt: 2 });

    expect(getDevice(db, android.id)?.fcmRegistration).toEqual({
      registrationToken: "fcm-token-two",
      updatedAt: 2,
    });
    expect(getDevice(db, android.id)?.pushTransport).toBe("direct-fcm");
    expect(listAndroidDevicesWithFcmToken(db).map((device) => device.id)).toEqual([android.id]);

    clearFcmToken(db, android.id);
    expect(getDevice(db, android.id)?.fcmRegistration).toBeNull();
    expect(getDevice(db, android.id)?.pushTransport).toBeNull();
    expect(listAndroidDevicesWithFcmToken(db)).toEqual([]);
  });

  test("conditional FCM cleanup preserves a token rotated in flight", () => {
    const android = createDevice(db, { name: "rotated-android", kind: "android" });
    setFcmToken(db, android.id, { registrationToken: "fcm-token-old", updatedAt: 1 });
    setFcmToken(db, android.id, { registrationToken: "fcm-token-new", updatedAt: 2 });
    expect(
      clearFcmToken(db, android.id, { registrationToken: "fcm-token-old", updatedAt: 1 }),
    ).toBe(false);
    expect(getDevice(db, android.id)?.fcmRegistration?.registrationToken).toBe("fcm-token-new");
  });

  test("conditional FCM cleanup preserves a reissued token generation", () => {
    const android = createDevice(db, { name: "reissued-android", kind: "android" });
    const old = { registrationToken: "fcm-token-same", updatedAt: 1 };
    setFcmToken(db, android.id, old);
    setFcmToken(db, android.id, { ...old, updatedAt: 2 });
    expect(clearFcmToken(db, android.id, old)).toBe(false);
    expect(getDevice(db, android.id)?.fcmRegistration?.updatedAt).toBe(2);
  });

  test("relay consent is phone-only and registration requires exact active consent", () => {
    const device = createDevice(db, { name: "relay-phone", kind: "ios" });
    const sibling = createDevice(db, { name: "relay-sibling", kind: "ios" });
    const collector = createDevice(db, { name: "relay-host", kind: "collector" });
    expect(
      setRelayPushRegistration(db, device.id, {
        relayUrl: "https://push.omnesis.app",
        credential: "relay_fictional",
        appId: "dev.omnesis.ios",
      }),
    ).toBe(false);
    expect(setRelayPushConsent(db, collector.id, { appId: "dev.omnesis.ios", grantedAt: 1 })).toBe(
      "device-not-found",
    );
    expect(setRelayPushConsent(db, device.id, { appId: "dev.omnesis.ios", grantedAt: 2 })).toBe(
      "granted",
    );
    expect(getDevice(db, device.id)?.relayConsent).toEqual({
      appId: "dev.omnesis.ios",
      grantedAt: 2,
    });
    expect(getDevice(db, sibling.id)?.relayConsent).toBeNull();

    setApnsToken(db, device.id, {
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.omnesis.ios",
      updatedAt: 1,
    });
    expect(
      setRelayPushRegistration(db, device.id, {
        relayUrl: "https://push.omnesis.app",
        credential: "relay_fictional",
        appId: "dev.omnesis.android",
      }),
    ).toBe(false);
    expect(
      setRelayPushRegistration(db, device.id, {
        relayUrl: "https://push.omnesis.app",
        credential: "relay_fictional",
        appId: "dev.omnesis.ios",
      }),
    ).toBe(true);

    expect(getDevice(db, device.id)).toMatchObject({
      apnsRegistration: null,
      fcmRegistration: null,
      pushTransport: "relay",
      relayUrl: "https://push.omnesis.app",
      relayCredential: "relay_fictional",
      relayConsent: { appId: "dev.omnesis.ios", grantedAt: 2 },
    });
  });

  test("consent adopts a missing app identity and preserves a declared one", () => {
    const stale = createDevice(db, {
      name: "pre-capability-phone",
      kind: "ios",
      capabilities: {},
    });
    expect(getDevice(db, stale.id)?.capabilities.pushAppId).toBeUndefined();
    expect(setRelayPushConsent(db, stale.id, { appId: "dev.omnesis.ios", grantedAt: 7 })).toBe(
      "granted",
    );
    expect(getDevice(db, stale.id)).toMatchObject({
      relayConsent: { appId: "dev.omnesis.ios", grantedAt: 7 },
      capabilities: { pushAppId: "dev.omnesis.ios" },
    });

    const declared = createDevice(db, {
      name: "declared-phone",
      kind: "ios",
      capabilities: { pushAppId: "dev.omnesis.ios", hostname: "fictional-host" },
    });
    expect(setRelayPushConsent(db, declared.id, { appId: "dev.omnesis.ios", grantedAt: 8 })).toBe(
      "granted",
    );
    expect(getDevice(db, declared.id)?.capabilities).toMatchObject({
      pushAppId: "dev.omnesis.ios",
      hostname: "fictional-host",
    });

    const conflicting = createDevice(db, {
      name: "conflicting-phone",
      kind: "ios",
      capabilities: { pushAppId: "dev.example.other-ios" },
    });
    expect(
      setRelayPushConsent(db, conflicting.id, { appId: "dev.omnesis.ios", grantedAt: 9 }),
    ).toBe("identity-mismatch");
    expect(getDevice(db, conflicting.id)?.relayConsent).toBeNull();
    expect(getDevice(db, conflicting.id)?.capabilities.pushAppId).toBe("dev.example.other-ios");
    expect(
      setRelayPushConsent(db, DeviceId(randomUUID()), {
        appId: "dev.omnesis.ios",
        grantedAt: 10,
      }),
    ).toBe("device-not-found");
  });

  test("withdrawal clears authorization and relay credential atomically without affecting a sibling", () => {
    const device = createDevice(db, { name: "withdrawing-phone", kind: "android" });
    const sibling = createDevice(db, { name: "consented-sibling", kind: "android" });
    for (const phone of [device, sibling]) {
      setRelayPushConsent(db, phone.id, { appId: "dev.omnesis.android", grantedAt: 1 });
      expect(
        setRelayPushRegistration(db, phone.id, {
          relayUrl: "https://push.omnesis.app",
          credential: `credential-${phone.id}`,
          appId: "dev.omnesis.android",
        }),
      ).toBe(true);
    }

    expect(withdrawRelayPushConsent(db, device.id)).toBe(true);
    expect(getDevice(db, device.id)).toMatchObject({
      pushTransport: null,
      relayUrl: null,
      relayCredential: null,
      relayConsent: null,
    });
    expect(getDevice(db, sibling.id)).toMatchObject({
      pushTransport: "relay",
      relayConsent: { appId: "dev.omnesis.android", grantedAt: 1 },
    });
    expect(
      setRelayPushRegistration(db, device.id, {
        relayUrl: "https://push.omnesis.app",
        credential: "stale-in-flight",
        appId: "dev.omnesis.android",
      }),
    ).toBe(false);
  });

  test("setFcmToken rejects a missing device", () => {
    expect(() =>
      setFcmToken(db, "ffffffff-ffff-ffff-ffff-ffffffffffff" as never, {
        registrationToken: "fcm-token",
        updatedAt: 1,
      }),
    ).toThrow(/not found/);
  });
});

describe("notification delivery health", () => {
  test("round-trips normalized phone state and gateway receipt time", () => {
    const phone = createDevice(db, { name: "health-phone", kind: "ios" });
    expect(getDevice(db, phone.id)?.notificationDeliveryHealth).toBeNull();

    setNotificationDeliveryHealth(db, phone.id, "scheduled-summary", 1_700_000_000_000);

    expect(getDevice(db, phone.id)).toMatchObject({
      notificationDeliveryHealth: "scheduled-summary",
      notificationDeliveryHealthUpdatedAt: 1_700_000_000_000,
    });
  });

  test("rejects a missing device", () => {
    expect(() =>
      setNotificationDeliveryHealth(
        db,
        "ffffffff-ffff-ffff-ffff-ffffffffffff" as never,
        "healthy",
        1,
      ),
    ).toThrow(/not found/);
  });
});

describe("bootstrapSelfFromDevices", () => {
  test("returns null when no device has self info", () => {
    createDevice(db, { name: "a", kind: "cli" });
    expect(bootstrapSelfFromDevices(db)).toBeNull();
    const count = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get();
    expect(count?.c).toBe(0);
  });

  test("creates a canonical self person when a device has self info", () => {
    const d = createDevice(db, { name: "mac", kind: "collector" });
    updateDeviceSelfInfo(db, d.id, {
      selfEmails: ["me@example.com"],
      selfPhones: ["+447700000000"],
    });

    const personId = bootstrapSelfFromDevices(db);
    expect(personId).not.toBeNull();

    const person = db
      .prepare<
        [string],
        { id: string; is_self: number; source: string; canonical_name: string }
      >("SELECT id, is_self, source, canonical_name FROM people WHERE id = ?")
      .get(personId!);
    expect(person?.is_self).toBe(1);
    expect(person?.source).toBe("device");

    const aliases = db
      .prepare<
        [string],
        { alias: string; alias_type: string; source_id: string | null }
      >("SELECT alias, alias_type, source_id FROM person_aliases WHERE person_id = ? ORDER BY alias_type, alias")
      .all(personId!);
    expect(aliases).toHaveLength(2);
    expect(aliases.find((a) => a.alias_type === "email")?.alias).toBe("me@example.com");
    expect(aliases.find((a) => a.alias_type === "phone")?.alias).toBe("+447700000000");
    expect(aliases[0].source_id).toBe(`device:${d.id}`);
    // And the device is recorded as vouching for them, so a source removal's
    // withdrawal can see that something other than that source asserts these.
    const vouchers = db
      .prepare<[], { source_id: string }>("SELECT DISTINCT source_id FROM person_alias_assertions")
      .all()
      .map((r) => r.source_id);
    expect(vouchers).toEqual([`device:${d.id}`]);
  });

  test("is idempotent — second call is a no-op when self exists", () => {
    const d = createDevice(db, { name: "mac", kind: "collector" });
    updateDeviceSelfInfo(db, d.id, { selfEmails: ["me@example.com"] });
    const first = bootstrapSelfFromDevices(db);
    expect(first).not.toBeNull();
    const second = bootstrapSelfFromDevices(db);
    expect(second).toBeNull();
    const count = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people WHERE is_self = TRUE")
      .get();
    expect(count?.c).toBe(1);
  });

  test("picks earliest-paired device when multiple have self info", async () => {
    const a = createDevice(db, { name: "a", kind: "collector" });
    await new Promise((r) => setTimeout(r, 5));
    const b = createDevice(db, { name: "b", kind: "ios" });

    updateDeviceSelfInfo(db, a.id, { selfEmails: ["a@x.com"] });
    updateDeviceSelfInfo(db, b.id, { selfEmails: ["b@x.com"] });

    const personId = bootstrapSelfFromDevices(db);
    expect(personId).not.toBeNull();

    // Exactly one is_self person.
    const count = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people WHERE is_self = TRUE")
      .get();
    expect(count?.c).toBe(1);

    // Aliases come from the earlier-paired device only.
    const aliases = db
      .prepare<
        [string],
        { alias: string; source_id: string | null }
      >("SELECT alias, source_id FROM person_aliases WHERE person_id = ?")
      .all(personId!);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].alias).toBe("a@x.com");
    expect(aliases[0].source_id).toBe(`device:${a.id}`);
  });

  test("does not overwrite an existing canonical self", () => {
    const d = createDevice(db, { name: "mac", kind: "collector" });
    updateDeviceSelfInfo(db, d.id, { selfEmails: ["me@example.com"] });

    // Pre-existing self person (e.g. seeded from contacts).
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES ('pre-existing', 'Pre Existing', 'contacts', TRUE, ?, ?, ?, ?)`,
    ).run(nowIso, nowIso, nowIso, nowIso);

    const personId = bootstrapSelfFromDevices(db);
    expect(personId).toBeNull();

    const count = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people WHERE is_self = TRUE")
      .get();
    expect(count?.c).toBe(1);
  });
});

describe("device-bootstrapped self resolves isSelf mentions", () => {
  test("after bootstrapSelfFromDevices, isSelf mentions resolve to that person", async () => {
    const { findOrCreatePerson } = await import("../../domain/PeopleResolutionService.js");

    const d = createDevice(db, { name: "mac", kind: "collector" });
    updateDeviceSelfInfo(db, d.id, { selfEmails: ["me@example.com"] });
    const selfId = bootstrapSelfFromDevices(db);
    expect(selfId).not.toBeNull();

    const resolved = findOrCreatePerson(
      db,
      { role: "author", isSelf: true },
      "things:default",
      "2026-03-01",
    );
    expect(resolved).toBe(selfId);
  });
});

describe("schema migration: devices.self_emails / self_phones", () => {
  test("running schema setup twice is idempotent (ALTER TABLE no-ops)", async () => {
    const { runSchemaSetup } = await import("../schema.js");
    // db was created by createDatabase in beforeEach which already ran
    // schema setup once. Run it again — should not throw.
    expect(() => runSchemaSetup(db)).not.toThrow();
    // Columns are still present and writable.
    const d = createDevice(db, { name: "mig", kind: "cli" });
    updateDeviceSelfInfo(db, d.id, { selfEmails: ["x@y.com"] });
    expect(getDevice(db, d.id)!.selfEmails).toEqual(["x@y.com"]);
  });
});

// device_pairings.self_emails / self_phones carry the staged
// annotation. Verify the columns exist and round-trip on a fresh DB.
describe("schema: device_pairings.self_emails / self_phones", () => {
  test("the columns are present on a freshly created database", () => {
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('device_pairings')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("self_emails");
    expect(cols).toContain("self_phones");
  });
});

describe("install identity + rename", () => {
  test("createDevice stores the client's install id and it is found by (kind, installId)", () => {
    const d = createDevice(db, {
      name: "self-named",
      kind: "ios",
      capabilities: { installId: "install-aaaa" },
    });
    expect(d.installId).toBe("install-aaaa");
    expect(findDeviceByInstallId(db, "ios", "install-aaaa")?.id).toBe(d.id);
    // Scoped by kind: another kind with the same value is a different device.
    expect(findDeviceByInstallId(db, "android", "install-aaaa")).toBeNull();
  });

  test("a repair keeps the install id when the client sends none, and adopts a new one", () => {
    const d = createDevice(db, {
      name: "keeps-identity",
      kind: "ios",
      capabilities: { installId: "install-bbbb" },
    });
    replaceDeviceForRepair(db, d.id, { name: "keeps-identity", kind: "ios" });
    expect(getDevice(db, d.id)?.installId).toBe("install-bbbb");
    replaceDeviceForRepair(db, d.id, {
      name: "keeps-identity",
      kind: "ios",
      capabilities: { installId: "install-cccc" },
    });
    expect(getDevice(db, d.id)?.installId).toBe("install-cccc");
  });

  test("pair-time adoption keys are kept out of the stored capabilities", () => {
    const d = createDevice(db, {
      name: "bag-phone",
      kind: "ios",
      capabilities: {
        installId: "install-bag",
        previousDeviceId: randomUUID(),
        platform: "ios",
      },
    });
    expect(d.capabilities).toEqual({ platform: "ios" });
    expect(getDevice(db, d.id)?.capabilities).toEqual({ platform: "ios" });
    expect(getDevice(db, d.id)?.installId).toBe("install-bag");

    const repaired = replaceDeviceForRepair(db, d.id, {
      name: "bag-phone",
      kind: "ios",
      capabilities: { installId: "install-bag", previousDeviceId: d.id, platform: "ios" },
    });
    expect(repaired.capabilities).toEqual({ platform: "ios" });
    expect(getDevice(db, d.id)?.capabilities).toEqual({ platform: "ios" });
  });

  test("a repair moves the client's install identity off any other row of the kind", () => {
    const a = createDevice(db, { name: "row-a", kind: "ios" });
    const b = createDevice(db, {
      name: "row-b",
      kind: "ios",
      capabilities: { installId: "install-moving" },
    });
    // The same identity on another kind is unrelated and untouched.
    const c = createDevice(db, {
      name: "row-c",
      kind: "android",
      capabilities: { installId: "install-moving" },
    });

    const repaired = replaceDeviceForRepair(db, a.id, {
      name: "row-a",
      kind: "ios",
      capabilities: { installId: "install-moving" },
    });
    expect(repaired.installId).toBe("install-moving");
    expect(getDevice(db, a.id)?.installId).toBe("install-moving");
    expect(getDevice(db, b.id)?.installId).toBeNull();
    expect(getDevice(db, c.id)?.installId).toBe("install-moving");
    expect(findDeviceByInstallId(db, "ios", "install-moving")?.id).toBe(a.id);

    // A repair without an install identity keeps the row's own.
    const kept = replaceDeviceForRepair(db, a.id, { name: "row-a", kind: "ios" });
    expect(kept.installId).toBe("install-moving");
  });

  test("renameDevice changes the display name, refuses a taken name, and reports a missing id", () => {
    const a = createDevice(db, { name: "alpha-name", kind: "cli" });
    createDevice(db, { name: "beta-name", kind: "cli" });
    expect(renameDevice(db, a.id, "gamma-name")).toMatchObject({ ok: true });
    expect(getDevice(db, a.id)?.name).toBe("gamma-name");
    expect(renameDevice(db, a.id, "beta-name")).toEqual({ ok: false, reason: "name-taken" });
    expect(renameDevice(db, DeviceId(randomUUID()), "whatever")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("an unsupported update result", () => {
  test("stands while the device reports the same build, and clears when it reports another", () => {
    const d = createDevice(db, { name: "example-agent", kind: "agent" });
    updateDeviceCapabilities(db, d.id, { version: "0.4.7" }, 1);
    setDeviceUpdateRequest(db, d.id, {
      desiredVersion: "0.4.9",
      state: "unsupported",
      detail: "This build does not accept update commands.",
    });

    updateDeviceCapabilities(db, d.id, { version: "0.4.7" }, 1);
    expect(getDevice(db, d.id)).toMatchObject({
      version: "0.4.7",
      desiredVersion: "0.4.9",
      updateState: "unsupported",
    });

    updateDeviceCapabilities(db, d.id, { version: "0.4.8" }, 1);
    expect(getDevice(db, d.id)).toMatchObject({
      version: "0.4.8",
      desiredVersion: null,
      updateState: null,
      updateDetail: null,
      updateStateAt: null,
    });
  });

  test("a version change leaves every other update state alone", () => {
    const d = createDevice(db, { name: "example-collector", kind: "collector" });
    updateDeviceCapabilities(db, d.id, { version: "0.4.7" }, 1);
    setDeviceUpdateRequest(db, d.id, { desiredVersion: "0.4.9", state: "failed", detail: "x" });
    updateDeviceCapabilities(db, d.id, { version: "0.4.8" }, 1);
    expect(getDevice(db, d.id)).toMatchObject({ desiredVersion: "0.4.9", updateState: "failed" });
  });

  test("clears when a source daemon reports another commit at the same version", () => {
    const d = createDevice(db, { name: "example-source-agent", kind: "agent" });
    updateDeviceCapabilities(db, d.id, { version: "0.4.7", sourceCommit: "a".repeat(40) }, 1);
    setDeviceUpdateRequest(db, d.id, {
      desiredVersion: `commit:${"c".repeat(40)}`,
      state: "unsupported",
      detail: "This build does not accept commit update commands.",
    });

    updateDeviceCapabilities(db, d.id, { version: "0.4.7", sourceCommit: "b".repeat(40) }, 1);
    expect(getDevice(db, d.id)).toMatchObject({
      version: "0.4.7",
      desiredVersion: null,
      updateState: null,
      updateDetail: null,
      updateStateAt: null,
    });
  });
});

describe("setDeviceUpdateRequest", () => {
  test("a source-commit settlement cannot clear a request after another socket reports another commit", () => {
    const device = createDevice(db, { name: "example-source", kind: "collector" });
    updateDeviceCapabilities(db, device.id, { version: "0.5.0", sourceCommit: "a".repeat(40) }, 1);
    setDeviceUpdateRequest(db, device.id, {
      desiredVersion: `commit:${"a".repeat(40)}`,
      state: "installed",
    });
    updateDeviceCapabilities(db, device.id, { version: "0.5.0", sourceCommit: "b".repeat(40) }, 1);

    expect(
      setDeviceUpdateRequest(db, device.id, {
        desiredVersion: null,
        state: "installed",
        onlyIfDesiredVersion: `commit:${"a".repeat(40)}`,
        onlyIfSourceCommit: "a".repeat(40),
      }),
    ).toBe(false);
    expect(getDevice(db, device.id)).toMatchObject({
      desiredVersion: `commit:${"a".repeat(40)}`,
      updateState: "installed",
    });
  });

  test("a settlement cannot clear a request after another socket reports a different build", () => {
    const device = createDevice(db, { name: "example-agent", kind: "agent" });
    updateDeviceCapabilities(db, device.id, { version: "0.5.0" }, 1);
    setDeviceUpdateRequest(db, device.id, { desiredVersion: "0.5.0", state: "installed" });
    updateDeviceCapabilities(db, device.id, { version: "0.4.9" }, 1);

    expect(
      setDeviceUpdateRequest(db, device.id, {
        desiredVersion: null,
        state: "installed",
        onlyIfDesiredVersion: "0.5.0",
        onlyIfReportedVersion: "0.5.0",
      }),
    ).toBe(false);
    expect(getDevice(db, device.id)).toMatchObject({
      version: "0.4.9",
      desiredVersion: "0.5.0",
      updateState: "installed",
    });
  });

  test("a settlement cannot overwrite a replacement target in the same state", () => {
    const device = createDevice(db, { name: "example-collector", kind: "collector" });
    setDeviceUpdateRequest(db, device.id, { desiredVersion: "0.6.0", state: "failed" });
    expect(
      setDeviceUpdateRequest(db, device.id, {
        desiredVersion: null,
        state: "installed",
        onlyIfState: "failed",
        onlyIfDesiredVersion: "0.5.0",
      }),
    ).toBe(false);
    expect(getDevice(db, device.id)).toMatchObject({
      desiredVersion: "0.6.0",
      updateState: "failed",
    });
  });

  test("a legacy settlement matches only an absent target", () => {
    const device = createDevice(db, { name: "example-agent", kind: "agent" });
    setDeviceUpdateRequest(db, device.id, { desiredVersion: "0.6.0", state: "failed" });
    const settled = {
      desiredVersion: null,
      state: "installed" as const,
      onlyIfDesiredVersion: null,
    };
    expect(setDeviceUpdateRequest(db, device.id, settled)).toBe(false);
    setDeviceUpdateRequest(db, device.id, { desiredVersion: null, state: "failed" });
    expect(setDeviceUpdateRequest(db, device.id, settled)).toBe(true);
  });

  test("records the version an operator asked for, and closes it out again", () => {
    const d = createDevice(db, { name: "studio-collector", kind: "collector" });
    expect(getDevice(db, d.id)).toMatchObject({ desiredVersion: null, updateState: null });

    expect(setDeviceUpdateRequest(db, d.id, { desiredVersion: "0.5.0", state: "pending" })).toBe(
      true,
    );
    expect(getDevice(db, d.id)).toMatchObject({
      desiredVersion: "0.5.0",
      updateState: "pending",
      updateDetail: null,
    });
    expect(getDevice(db, d.id)!.updateStateAt).toBeGreaterThan(0);

    setDeviceUpdateRequest(db, d.id, {
      desiredVersion: null,
      state: "failed",
      detail: "the build did not compile",
    });
    // The version is no longer owed, but how it ended stays on the row.
    expect(getDevice(db, d.id)).toMatchObject({
      desiredVersion: null,
      updateState: "failed",
      updateDetail: "the build did not compile",
    });
  });

  test("`onlyIfState` writes only from the state it names", () => {
    const d = createDevice(db, { name: "studio-collector", kind: "collector" });
    setDeviceUpdateRequest(db, d.id, { desiredVersion: "0.5.0", state: "installed" });

    // The device already reported; the older news that the command was
    // delivered must not replace it.
    expect(
      setDeviceUpdateRequest(db, d.id, {
        desiredVersion: "0.5.0",
        state: "dispatched",
        onlyIfState: "pending",
      }),
    ).toBe(false);
    expect(getDevice(db, d.id)).toMatchObject({ updateState: "installed" });
  });

  test("`notIfState` claims a row nobody is holding, including a fresh one", () => {
    const d = createDevice(db, { name: "studio-collector", kind: "collector" });
    // A device that was never asked anything has a NULL state; SQL's
    // three-valued `<>` would exclude it, which is why the guard is `IS NOT`.
    expect(
      setDeviceUpdateRequest(db, d.id, {
        desiredVersion: "0.5.0",
        state: "dispatched",
        notIfState: "dispatched",
      }),
    ).toBe(true);
    // A second claimant finds the row taken.
    expect(
      setDeviceUpdateRequest(db, d.id, {
        desiredVersion: "0.5.0",
        state: "dispatched",
        notIfState: "dispatched",
      }),
    ).toBe(false);
  });

  test("an unknown device id writes nothing", () => {
    expect(
      setDeviceUpdateRequest(db, DeviceId("00000000-0000-4000-8000-000000000000"), {
        desiredVersion: "0.5.0",
        state: "pending",
      }),
    ).toBe(false);
  });
});

describe("an outstanding update request and the device's identity", () => {
  test("revoking drops it — nothing runs on a revoked device", () => {
    const d = createDevice(db, { name: "studio-collector", kind: "collector" });
    setDeviceUpdateRequest(db, d.id, {
      desiredVersion: "0.5.0",
      state: "pending",
      detail: "waiting for it to reconnect",
    });

    revokeDevice(db, d.id);
    expect(getDevice(db, d.id)).toMatchObject({
      desiredVersion: null,
      updateState: null,
      updateDetail: null,
      updateStateAt: null,
    });
  });

  test("re-pairing the same machine drops it too", () => {
    const d = createDevice(db, { name: "studio-collector", kind: "collector" });
    setDeviceUpdateRequest(db, d.id, { desiredVersion: "0.5.0", state: "dispatched" });

    replaceDeviceForRepair(db, d.id, { name: "studio-collector", kind: "collector" });
    expect(getDevice(db, d.id)).toMatchObject({ desiredVersion: null, updateState: null });
  });
});
