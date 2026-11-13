// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultScopesForDeviceKind, SCOPE_ADMIN } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  createPairing,
  getDevice,
  getDeviceEnrollmentPublicKey,
  listDevices,
  redeemDevicePairing,
  replaceDeviceForRepair,
  rotateDeviceToken,
  type PairingEnrollment,
} from "./DeviceRepository.js";
import { createToken, lookupToken } from "./TokenRepository.js";
import type { DeviceCapability, DeviceKind } from "@omnesis/types";
import type Database from "better-sqlite3";

const VICTIM_KEY = "victim-device-key";
const ATTACKER_KEY = "attacker-device-key";

let db: Database.Database;
let path: string;

beforeEach(() => {
  // Enrollment records are read back only with the cloud relay opt-in.
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  path = `/tmp/omnesis-enrollment-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function enrolled(key: string, method: PairingEnrollment["method"] = "automatic") {
  return { method, signIn: "google" as const, devicePublicKey: key };
}

function redeem(
  enrollment: PairingEnrollment | undefined,
  capabilities: DeviceCapability,
  options: { kind?: DeviceKind; name?: string; online?: string[] } = {},
) {
  const kind = options.kind ?? "ios";
  const pending = createPairing(db, {
    kind,
    name: options.name ?? "",
    scopes: defaultScopesForDeviceKind(kind),
    ...(enrollment ? { enrollment } : {}),
  });
  const result = redeemDevicePairing(db, {
    pairingCode: pending.pairingCode,
    expectedKind: kind,
    capabilities,
    onlineDeviceIds: (options.online ?? []) as never,
  });
  return result;
}

function paired(result: ReturnType<typeof redeem>) {
  if (result.outcome !== "paired") throw new Error(`expected paired, got ${result.outcome}`);
  return result;
}

describe("redeeming a sign-in pairing", () => {
  test("an attacker naming an offline device, with its install and previous ids, takes nothing", () => {
    const victim = paired(
      redeem(enrolled(VICTIM_KEY), {
        suggestedName: "Maya's iPhone",
        installId: "victim-install",
      }),
    );
    const victimCredential = lookupToken(db, victim.token);
    expect(victimCredential).not.toBeNull();

    const attacker = paired(
      redeem(enrolled(ATTACKER_KEY), {
        suggestedName: "Maya's iPhone",
        installId: "victim-install",
        previousDeviceId: victim.device.id,
      }),
    );

    expect(attacker.device.id).not.toBe(victim.device.id);
    expect(attacker.replacedDeviceId).toBeUndefined();
    expect(attacker.device.name).toMatch(/^Maya's iPhone-[0-9a-f]{4}$/);
    // The install id stays with the row that had it.
    expect(attacker.device.installId).toBeNull();
    expect(getDevice(db, victim.device.id)?.installId).toBe("victim-install");
    expect(lookupToken(db, victim.token)).not.toBeNull();
    expect(getDeviceEnrollmentPublicKey(db, victim.device.id)).toBe(VICTIM_KEY);
  });

  test("it never adopts a legacy row by any of those claims either", () => {
    const legacy = createDevice(db, {
      name: "Old phone",
      kind: "ios",
      capabilities: { installId: "legacy-install" },
    });
    const { token } = createToken(db, legacy.id, [SCOPE_ADMIN]);
    const result = paired(
      redeem(enrolled(ATTACKER_KEY), {
        suggestedName: "Old phone",
        installId: "legacy-install",
        previousDeviceId: legacy.id,
      }),
    );
    expect(result.device.id).not.toBe(legacy.id);
    expect(lookupToken(db, token)).not.toBeNull();
    expect(getDevice(db, legacy.id)?.installId).toBe("legacy-install");
  });

  test("a name held by a device of another kind makes a suffixed row, not a refusal", () => {
    createDevice(db, { name: "Workstation", kind: "collector" });
    const result = paired(redeem(enrolled(ATTACKER_KEY), { suggestedName: "Workstation" }));
    expect(result.device.kind).toBe("ios");
    expect(result.device.name).toMatch(/^Workstation-[0-9a-f]{4}$/);
  });

  test("the same key on the same kind is a reinstall: the row is kept and old tokens go", () => {
    const first = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "Jamie's phone" }));
    const second = paired(
      redeem(enrolled(VICTIM_KEY, "approved"), {
        suggestedName: "renamed by reinstall",
        installId: "new-install",
      }),
    );
    expect(second.device.id).toBe(first.device.id);
    expect(second.replacedDeviceId).toBe(first.device.id);
    expect(second.device.name).toBe("Jamie's phone");
    expect(second.device.installId).toBe("new-install");
    expect(second.device.enrollment?.method).toBe("approved");
    expect(lookupToken(db, first.token)).toBeNull();
    expect(lookupToken(db, second.token)).not.toBeNull();
  });

  test("the same key on another kind is a different device", () => {
    const phone = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "one" }));
    const tablet = paired(
      redeem(enrolled(VICTIM_KEY), { suggestedName: "two" }, { kind: "android" }),
    );
    expect(tablet.device.id).not.toBe(phone.device.id);
  });

  test("a device online under that key still refuses and leaves the code usable", () => {
    const first = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "Online" }));
    const pending = createPairing(db, {
      kind: "ios",
      scopes: defaultScopesForDeviceKind("ios"),
      enrollment: enrolled(VICTIM_KEY),
    });
    const refused = redeemDevicePairing(db, {
      pairingCode: pending.pairingCode,
      expectedKind: "ios",
      capabilities: {},
      onlineDeviceIds: [first.device.id],
    });
    expect(refused.outcome).toBe("conflict");
    expect(
      redeemDevicePairing(db, {
        pairingCode: pending.pairingCode,
        expectedKind: "ios",
        capabilities: {},
      }).outcome,
    ).toBe("paired");
  });

  test("it records how the device joined", () => {
    const before = Date.now();
    const { device } = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "Fresh" }));
    expect(device.enrollment).toMatchObject({ method: "automatic", signIn: "google" });
    expect(device.enrollment!.joinedAt).toBeGreaterThanOrEqual(before);
    const approved = paired(redeem(enrolled(ATTACKER_KEY, "approved"), {}));
    expect(approved.device.enrollment).toMatchObject({ method: "approved" });
    expect(Object.keys(device.enrollment!).sort()).toEqual(["joinedAt", "method", "signIn"]);
  });
});

test("without the cloud relay opt-in no device record mentions enrollment", () => {
  const { device } = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "Fresh" }));
  expect(device.enrollment).toBeDefined();
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "");
  const read = getDevice(db, device.id)!;
  expect("enrollment" in read).toBe(false);
  expect(JSON.stringify(listDevices(db))).not.toContain("enrollment");
});

describe("legacy pairings", () => {
  test("still adopt by install id, and serialize with no enrollment field", () => {
    const first = paired(redeem(undefined, { suggestedName: "Legacy", installId: "install-1" }));
    expect("enrollment" in first.device).toBe(false);
    const second = paired(redeem(undefined, { suggestedName: "else", installId: "install-1" }));
    expect(second.device.id).toBe(first.device.id);
    expect(JSON.stringify(second.device)).not.toContain("enrollment");
  });

  test("still adopt by previous id and by name", () => {
    const byName = paired(redeem(undefined, { suggestedName: "Shared name" }));
    expect(paired(redeem(undefined, { suggestedName: "Shared name" })).device.id).toBe(
      byName.device.id,
    );
    expect(
      paired(redeem(undefined, { suggestedName: "other", previousDeviceId: byName.device.id }))
        .device.id,
    ).toBe(byName.device.id);
  });

  test("a code an administrator minted drops the old key and the enrollment record from the row it adopts", () => {
    const signedIn = paired(
      redeem(enrolled(VICTIM_KEY), { suggestedName: "Taken back", installId: "install-2" }),
    );
    expect(signedIn.device.enrollment?.method).toBe("automatic");
    const repaired = paired(redeem(undefined, { installId: "install-2" }));
    expect(repaired.device.id).toBe(signedIn.device.id);
    expect(repaired.device.enrollment).toBeUndefined();
    expect(getDeviceEnrollmentPublicKey(db, signedIn.device.id)).toBeNull();
  });

  test("a direct repair clears the record too", () => {
    const signedIn = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "Direct" }));
    replaceDeviceForRepair(db, signedIn.device.id, { name: "Direct", kind: "ios" });
    expect(getDevice(db, signedIn.device.id)?.enrollment).toBeUndefined();
  });
});

describe("rotateDeviceToken", () => {
  const OVERLAP = 60 * 60 * 1000;
  function deviceWithToken() {
    const result = paired(redeem(enrolled(VICTIM_KEY), { suggestedName: "Rotator" }));
    return {
      deviceId: result.device.id,
      tokenId: result.tokenId,
      token: result.token,
      request: {
        deviceId: result.device.id,
        tokenId: result.tokenId,
        challenge: "challenge-one",
        signature: "signature-one",
        challengeConsumed: true,
        overlapMs: OVERLAP,
      },
    };
  }

  test("mints the same scopes and leaves the old token valid only for the overlap", () => {
    const { request, token, tokenId } = deviceWithToken();
    const before = lookupToken(db, token)!;
    const rotated = rotateDeviceToken(db, request);
    if (rotated.outcome !== "rotated") throw new Error(rotated.outcome);
    expect(rotated.replayed).toBe(false);
    expect(lookupToken(db, rotated.token)?.scopes).toEqual(before.scopes);
    expect(lookupToken(db, token)).not.toBeNull();
    const expires = db
      .prepare<[string], { expires_at: number }>("SELECT expires_at FROM tokens WHERE id = ?")
      .get(tokenId)!.expires_at;
    expect(expires).toBeGreaterThan(Date.now() + OVERLAP - 5_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + OVERLAP);
    expect(
      db
        .prepare<[string], { expires_at: number | null }>(
          "SELECT expires_at FROM tokens WHERE id = ?",
        )
        .get(rotated.tokenId)!.expires_at,
    ).toBeNull();
  });

  test("the exact retry returns the same token, without a live challenge", () => {
    const { request } = deviceWithToken();
    const first = rotateDeviceToken(db, request);
    const retry = rotateDeviceToken(db, { ...request, challengeConsumed: false });
    if (first.outcome !== "rotated" || retry.outcome !== "rotated") throw new Error("not rotated");
    expect(retry.token).toBe(first.token);
    expect(retry.tokenId).toBe(first.tokenId);
    expect(retry.replayed).toBe(true);
  });

  test("an unknown challenge with no receipt is refused", () => {
    const { request } = deviceWithToken();
    expect(rotateDeviceToken(db, { ...request, challengeConsumed: false }).outcome).toBe("invalid");
  });

  test("the same signature with another challenge does not read the receipt", () => {
    const { request } = deviceWithToken();
    rotateDeviceToken(db, request);
    expect(
      rotateDeviceToken(db, { ...request, challenge: "challenge-two", challengeConsumed: true })
        .outcome,
    ).toBe("invalid");
  });

  test("starting again after a lost response removes the token nobody ever used", () => {
    const { request } = deviceWithToken();
    const lost = rotateDeviceToken(db, request);
    const again = rotateDeviceToken(db, {
      ...request,
      challenge: "challenge-two",
      signature: "signature-two",
    });
    if (lost.outcome !== "rotated" || again.outcome !== "rotated") throw new Error("not rotated");
    expect(lookupToken(db, lost.token)).toBeNull();
    expect(lookupToken(db, again.token)).not.toBeNull();
  });

  test("a short-lived token is not rotated into one that never expires", () => {
    const { deviceId, request } = deviceWithToken();
    const shortLived = createToken(db, deviceId, [SCOPE_ADMIN], "short", { ttlMs: 60_000 });
    expect(rotateDeviceToken(db, { ...request, tokenId: shortLived.id }).outcome).toBe("refused");
  });
});
