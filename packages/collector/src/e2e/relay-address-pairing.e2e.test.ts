// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pairing a phone by hand with the gateway's Omnesis address, the one its
 * relay gives it. A gateway connected to a real relay offers that address in
 * the "Pair device" address list, encodes it with the gateway's public key
 * pinned, and a phone redeems the code through the relay. With remote access
 * turned off the address is no longer offered or encoded, and the phone that
 * paired with it still reaches the gateway on the home network under the same
 * name and key.
 */

import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  devicePinnedJson,
  EnrollmentGateway,
  EnrollmentWorld,
  waitFor,
} from "./account-enrollment-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

interface AddressOption {
  gatewayUrl: string;
  host: string;
  label: string;
  kind?: string;
  usable: boolean;
  reach?: string;
  systemTrust?: boolean;
  summary?: string;
}
interface AddressPlan {
  recommendedUrl: string | null;
  addresses: AddressOption[];
}

describe("pairing a phone with the gateway's Omnesis address", () => {
  let directory: string;
  let world: EnrollmentWorld;
  let gateway: EnrollmentGateway;

  const mint = async (kind: "ios" | "android") =>
    (
      await gateway.json<{ pairingCode: string }>("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind, name: `Fictional ${kind} phone` }),
      })
    ).pairingCode;
  const addresses = (pairingCode: string) =>
    gateway.json<AddressPlan>("/admin/devices/pair-addresses", {
      method: "POST",
      body: JSON.stringify({ pairingCode }),
    });
  const qr = (pairingCode: string, gatewayUrl: string, trustMode?: string) =>
    gateway.fetch("/admin/devices/pair-qr", {
      method: "POST",
      body: JSON.stringify({ pairingCode, gatewayUrl, ...(trustMode ? { trustMode } : {}) }),
    });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-relay-address-"));
    world = await EnrollmentWorld.create(directory, { signupPolicy: "invitation" });
    gateway = await EnrollmentGateway.start(world, "home");
    await waitFor(
      async () =>
        (await gateway.json<{ publicMcp: { ready: boolean } }>("/admin/cloud-relay")).publicMcp
          .ready,
      "the gateway's Omnesis address to answer",
      60_000,
    );
  }, gatewayBootBudgetMs() + 120_000);

  afterAll(async () => {
    try {
      await gateway?.close();
      await world?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("the address is offered, pins the gateway's key, pairs a phone through the relay, and after remote access is turned off is withdrawn while the phone still connects at home", async () => {
    const spki = createHash("sha256")
      .update(
        new X509Certificate(gateway.leaf.cert).publicKey.export({ type: "spki", format: "der" }),
      )
      .digest("hex");

    for (const kind of ["ios", "android"] as const) {
      const plan = await addresses(await mint(kind));
      const usable = plan.addresses.filter((option) => option.usable);
      const index = usable.findIndex((option) => option.kind === "relay");
      expect(usable[index], kind).toEqual({
        gatewayUrl: gateway.publicOrigin,
        host: gateway.hostname,
        label: "Omnesis address",
        kind: "relay",
        usable: true,
        reach: "anywhere",
        systemTrust: false,
        summary: "Works from anywhere. Needs remote access to stay on.",
      });
      // Only an address that itself reaches beyond the home network comes first
      // (this host may be on a tailnet); every home-network address comes after.
      expect(
        usable.slice(0, index).every((option) => option.reach === "tailnet"),
        kind,
      ).toBe(true);
      expect(
        usable.slice(index + 1).every((option) => option.reach === "local-network"),
        kind,
      ).toBe(true);
      if (index === 0) expect(plan.recommendedUrl, kind).toBe(gateway.publicOrigin);
    }

    const pairingCode = await mint("android");
    const system = await qr(pairingCode, gateway.publicOrigin, "system");
    expect(system.status).toBe(400);
    expect(JSON.stringify(await system.json())).toContain(
      "Relay pairing requires a verified gateway certificate pin",
    );
    const encoded = await qr(pairingCode, gateway.publicOrigin);
    expect(encoded.status).toBe(200);
    expect(JSON.parse(((await encoded.json()) as { qrPayload: string }).qrPayload)).toEqual({
      v: 4,
      gatewayUrl: gateway.publicOrigin,
      pairingCode,
      tls: { mode: "pinned-key-strict", spkiFingerprint: spki },
    });

    // The phone redeems the code at the address in the QR code, through the relay.
    const target = { publicOrigin: gateway.publicOrigin, certificate: gateway.leaf.cert };
    const paired = (await devicePinnedJson(target, "/devices/pair", { pairingCode })) as {
      token: string;
      device: { id: string };
    };
    expect(paired.token).toBeTruthy();
    // Over the same pinned channel it learns where the gateway is at home.
    const hints = (await devicePinnedJson(
      target,
      "/devices/direct-candidates",
      undefined,
      undefined,
      undefined,
      {
        token: paired.token,
      },
    )) as { version: number; candidates: Array<{ address: string; port: number }> };
    expect(hints.version).toBe(1);
    for (const candidate of hints.candidates) {
      expect(candidate.port).toBe(gateway.harness.gatewayPort);
    }
    const viaRelay = (await devicePinnedJson(target, "/whoami", undefined, undefined, undefined, {
      token: paired.token,
    })) as { deviceId: string };
    expect(viaRelay.deviceId).toBe(paired.device.id);

    await gateway.json("/admin/cloud-relay/disable", { method: "POST", body: "{}" });
    await waitFor(
      async () => (await gateway.status()).tunnel.state === "disabled",
      "remote access to turn off",
      30_000,
    );

    const later = await mint("android");
    const plan = await addresses(later);
    expect(plan.addresses.some((option) => option.kind === "relay")).toBe(false);
    expect(plan.addresses.map((option) => option.gatewayUrl)).not.toContain(gateway.publicOrigin);
    const refused = await qr(later, gateway.publicOrigin);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain(
      "Turn on remote access, or pair with another address.",
    );

    // Away from home the phone has no path: the relay no longer forwards to the gateway.
    await expect(
      devicePinnedJson(target, "/whoami", undefined, undefined, undefined, { token: paired.token }),
    ).rejects.toThrow();
    // At home it dials the gateway's own port under the same name and key, and is still paired.
    const atHome = (await devicePinnedJson(target, "/whoami", undefined, undefined, undefined, {
      token: paired.token,
      connectPort: gateway.harness.gatewayPort,
    })) as { deviceId: string };
    expect(atHome.deviceId).toBe(paired.device.id);
  }, 240_000);
});
