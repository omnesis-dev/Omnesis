// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The full life of a collector's pairing, end to end over real collector
 * connections: revoke it, see that both the gateway and the CLI say the row
 * is waiting on a repair, mint a repair code, redeem it, and prove that what
 * came back is the same device — same id, same sources, same memberships,
 * same cursors — rather than a fresh row wearing the old name.
 *
 * The other half is the collector that lives on the gateway host. It
 * registers itself under `<hostname>-collector` with the local bootstrap
 * token, so after a revoke that name is held by its own dormant row. The
 * route has to adopt that row; refusing it strands every source hanging off
 * the old device id.
 *
 * The tests run in declaration order and share one gateway: the revoke in the
 * second sets up the repair in the fourth, which burns a one-shot pairing
 * code and rotates `workstation.token` for the fifth. Running one in
 * isolation, or retrying one, will not reproduce that sequence.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const EXCLUSIVE = "gmail-synth:operator@example.com";
const REPLICATED = "notes-synth:operator@example.com";
const PARTITIONED = "activity-synth:operator@example.com";

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  revokedAt: number | null;
  needsPairing: boolean;
}

interface SourceRow {
  id: string;
  deviceId: string;
  members: string[];
}

async function asDevice<T>(
  base: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

describe("pairing lifecycle: revoke, repair, re-pair", () => {
  let harness: MultiCollectorHarness;
  let workstation: PairedCollector;
  let laptop: PairedCollector;

  const devices = async (): Promise<DeviceRow[]> =>
    (await harness.json<{ items: DeviceRow[] }>("/admin/devices")).items;
  const device = async (id: string): Promise<DeviceRow | undefined> =>
    (await devices()).find((d) => d.id === id);
  const source = async (id: string): Promise<SourceRow | undefined> =>
    (await harness.json<{ items: SourceRow[] }>("/admin/sources")).items.find((s) => s.id === id);

  const bulkUpsert = (c: PairedCollector, entries: Array<{ type: string; accountId: string }>) =>
    asDevice<{ errors: Array<{ error: string }> }>(
      c.gatewayBase,
      c.token,
      "/devices/sources/bulk-upsert",
      {
        method: "POST",
        body: JSON.stringify({ sources: entries.map((e) => ({ ...e, enabled: true })) }),
      },
    );

  const commitCursor = (c: PairedCollector, sourceId: string, page: number) =>
    asDevice<{ ingested: number }>(c.gatewayBase, c.token, "/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: sourceId,
        sourceId,
        documents: [],
        hasMore: false,
        cursor: { page },
      }),
    });

  const cursorOf = async (token: string, sourceId: string) =>
    (
      await asDevice<{ cursor: { page: number } | null }>(
        harness.gatewayUrl,
        token,
        `/sync-state/${encodeURIComponent(sourceId)}`,
      )
    ).cursor;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    writeFileSync(
      join(harness.gatewayConfigDir, ".env"),
      "OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN=https://gateway.example-tailnet.ts.net:7600\n",
    );
    await harness.start();
    const modes = {
      "notes-synth": "replicated" as const,
      "activity-synth": "partitioned" as const,
    };
    workstation = await harness.addCollector({
      name: "workstation-collector",
      hostableSourceTypes: ["gmail-synth", "notes-synth", "activity-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    laptop = await harness.addCollector({
      name: "laptop-collector",
      hostableSourceTypes: ["notes-synth", "activity-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    expect(
      (
        await bulkUpsert(workstation, [
          { type: "gmail-synth", accountId: "operator@example.com" },
          { type: "notes-synth", accountId: "operator@example.com" },
          { type: "activity-synth", accountId: "operator@example.com" },
        ])
      ).errors,
    ).toEqual([]);
    expect(
      (
        await bulkUpsert(laptop, [
          { type: "notes-synth", accountId: "operator@example.com" },
          { type: "activity-synth", accountId: "operator@example.com" },
        ])
      ).errors,
    ).toEqual([]);
    await commitCursor(workstation, EXCLUSIVE, 17);
    await commitCursor(workstation, REPLICATED, 19);
    await commitCursor(workstation, PARTITIONED, 23);
    await harness.pushDocuments(workstation, [
      { sourceId: EXCLUSIVE, externalId: "msg-1", title: "Quarterly planning thread" },
      { sourceId: REPLICATED, externalId: "note-1", title: "Workshop checklist" },
      { sourceId: PARTITIONED, externalId: "day-1", title: "Daily activity summary" },
    ]);
  }, 90_000);

  afterAll(async () => {
    await harness.destroy();
  }, 20_000);

  test("the installer-proven origin produces a renewal-safe system-trust QR", async () => {
    const pair = await harness.json<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "ios", scopes: ["admin"] }),
    });
    const qr = await harness.json<{ qrPayload: string }>("/admin/devices/pair-qr", {
      method: "POST",
      body: JSON.stringify({
        pairingCode: pair.pairingCode,
        gatewayUrl: "https://gateway.example-tailnet.ts.net:7600",
        trustMode: "auto",
      }),
    });
    expect(JSON.parse(qr.qrPayload)).toEqual({
      v: 4,
      gatewayUrl: "https://gateway.example-tailnet.ts.net:7600",
      pairingCode: pair.pairingCode,
      tls: { mode: "system" },
    });
  });

  test("an iPhone is offered the trusted name first and is refused a Tailscale IP", async () => {
    const mint = async (kind: "ios" | "android") =>
      (
        await harness.json<{ pairingCode: string }>("/admin/devices/pair", {
          method: "POST",
          body: JSON.stringify({ kind }),
        })
      ).pairingCode;
    const iphone = await mint("ios");
    const plan = await harness.json<{
      platform: string;
      recommendedUrl: string | null;
      addresses: Array<{ gatewayUrl: string; usable: boolean; systemTrust?: boolean }>;
      awayFromHome: unknown;
    }>("/admin/devices/pair-addresses", {
      method: "POST",
      body: JSON.stringify({ pairingCode: iphone }),
    });
    expect(plan.platform).toBe("ios");
    expect(plan.recommendedUrl).toBe("https://gateway.example-tailnet.ts.net:7600");
    expect(plan.addresses[0]).toMatchObject({ usable: true, systemTrust: true });
    expect(plan.awayFromHome).toBeNull();

    const encode = (pairingCode: string, gatewayUrl: string) =>
      harness.json<{ qrPayload: string }>("/admin/devices/pair-qr", {
        method: "POST",
        body: JSON.stringify({ pairingCode, gatewayUrl, trustMode: "auto" }),
      });
    const tailnetIp = "https://100.101.102.103:7600";
    await expect(encode(iphone, tailnetIp)).rejects.toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/Tailscale IP address/) },
    });
    expect(JSON.parse((await encode(await mint("android"), tailnetIp)).qrPayload)).toMatchObject({
      v: 3,
      gatewayUrl: tailnetIp,
    });
  });

  test("a code that is not pending gets no addresses and no QR", async () => {
    await expect(
      harness.json("/admin/devices/pair-addresses", {
        method: "POST",
        body: JSON.stringify({ pairingCode: "0000000000" }),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("a paired collector is not waiting on anything", async () => {
    const row = await device(workstation.deviceId);
    expect(row?.revokedAt).toBeNull();
    expect(row?.needsPairing).toBe(false);
  });

  test("revoking a collector that hosts sources shows as needs-pairing on the gateway and in the CLI", async () => {
    workstation.ws.disconnect();
    await harness.json(`/admin/devices/${workstation.deviceId}`, { method: "DELETE" });

    const row = await device(workstation.deviceId);
    expect(row?.revokedAt).toBeGreaterThan(0);
    // Revoked AND still holding sources: a machine waiting on a repair code,
    // not one retired on purpose.
    expect(row?.needsPairing).toBe(true);

    const listed = await harness.runCli(["devices", "list"]);
    expect(listed.exitCode).toBe(0);
    const line = listed.stdout.split("\n").find((l) => l.startsWith("workstation-collector"));
    expect(line).toBeDefined();
    expect(line).toContain("needs-pairing");
    expect(listed.stdout).toContain("omnesis devices repair");
    // The laptop is untouched by its sibling's revoke.
    const sibling = listed.stdout.split("\n").find((l) => l.startsWith("laptop-collector"));
    expect(sibling).toContain("paired");
    expect(sibling).not.toContain("needs-pairing");
  }, 60_000);

  test("a revoked device with nothing to bring back is simply revoked", async () => {
    const spare = await harness.json<{ device: { id: string } }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "retired-collector", kind: "collector", scopes: ["read"] }),
    });
    await harness.json(`/admin/devices/${spare.device.id}`, { method: "DELETE" });
    expect((await device(spare.device.id))?.needsPairing).toBe(false);
  });

  test("devices repair mints a code bound to the device, and re-pairing keeps its identity", async () => {
    const minted = await harness.runCli(["devices", "repair", "workstation-collector"]);
    expect(minted.exitCode).toBe(0);
    expect(minted.stdout).toContain(workstation.deviceId);
    // The CLI colours its output; skip the escape sequence between the label
    // and the code rather than assuming they are adjacent.
    const code = /Repair code:[^\n]*?([0-9A-F]{10})/.exec(minted.stdout)?.[1];
    expect(code, minted.stdout + minted.stderr).toBeDefined();

    const res = await fetch(`${harness.gatewayUrl}/devices/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: code, capabilities: workstation.capabilities }),
    });
    expect(res.status).toBe(200);
    const paired = (await res.json()) as {
      device: { id: string; name: string; revokedAt: number | null };
      token: string;
    };

    // Same row, back in service.
    expect(paired.device.id).toBe(workstation.deviceId);
    expect(paired.device.name).toBe("workstation-collector");
    expect(paired.device.revokedAt).toBeNull();
    expect((await device(workstation.deviceId))?.needsPairing).toBe(false);

    // Ownership and membership hang off the device id, so both survived.
    expect((await source(EXCLUSIVE))?.deviceId).toBe(workstation.deviceId);
    expect((await source(REPLICATED))?.members).toEqual(
      expect.arrayContaining([workstation.deviceId, laptop.deviceId]),
    );
    expect((await source(PARTITIONED))?.members).toEqual(
      expect.arrayContaining([workstation.deviceId, laptop.deviceId]),
    );

    // And the corpus is not orphaned: what this collector pushed before the
    // revoke is still attributed to the source it hosts.
    const counted = await harness.json<{ count: number }>(
      `/documents/count/${encodeURIComponent(EXCLUSIVE)}`,
    );
    expect(counted.count).toBe(1);
    for (const sourceId of [REPLICATED, PARTITIONED]) {
      const sourceCount = await harness.json<{ count: number }>(
        `/documents/count/${encodeURIComponent(sourceId)}`,
      );
      expect(sourceCount.count).toBe(1);
    }

    // And so do the cursors: the repaired collector resumes where it stopped
    // rather than bootstrapping the source all over again.
    expect(await cursorOf(paired.token, EXCLUSIVE)).toEqual({ page: 17 });
    expect(await cursorOf(paired.token, REPLICATED)).toEqual({ page: 19 });
    expect(await cursorOf(paired.token, PARTITIONED)).toEqual({ page: 23 });

    // The old credential is dead and the new one carries a real session.
    const stale = await fetch(`${harness.gatewayUrl}/config`, {
      headers: { Authorization: `Bearer ${workstation.token}` },
    });
    expect(stale.status).toBe(401);

    workstation.token = paired.token;
    await harness.reconnectCollector(workstation);
    await waitForCondition(
      async () => (await device(workstation.deviceId))?.online === true,
      10_000,
      "repaired collector back online",
    );
  }, 60_000);

  test("a repaired collector keeps committing on the cursor it resumed", async () => {
    await commitCursor(workstation, EXCLUSIVE, 18);
    expect(await cursorOf(workstation.token, EXCLUSIVE)).toEqual({ page: 18 });
  });

  // The gateway-host collector's own recovery. It has the local bootstrap
  // token, so it self-registers under a fixed name — which its own revoked
  // row still holds.
  test("the self-pair path reclaims a revoked collector row of the same name", async () => {
    const name = "homelab-collector";
    const created = await harness.json<{ device: { id: string }; token: string }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          kind: "collector",
          scopes: ["read", "write:*"],
          capabilities: { hostname: "homelab.example.com", platform: "linux" },
        }),
      },
    );
    const sourceId = "gmail-synth:homelab@example.com";
    await asDevice(harness.gatewayUrl, created.token, "/devices/sources/bulk-upsert", {
      method: "POST",
      body: JSON.stringify({
        sources: [{ type: "gmail-synth", accountId: "homelab@example.com", enabled: true }],
      }),
    });
    await asDevice(harness.gatewayUrl, created.token, "/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: sourceId,
        sourceId,
        documents: [],
        hasMore: false,
        cursor: { page: 42 },
      }),
    });
    await harness.json(`/admin/devices/${created.device.id}`, { method: "DELETE" });
    expect((await device(created.device.id))?.needsPairing).toBe(true);

    // Exactly what the collector daemon posts on startup.
    const reclaimed = await harness.json<{
      device: { id: string; revokedAt: number | null };
      token: string;
      reclaimed?: boolean;
    }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name,
        kind: "collector",
        scopes: ["read", "write:*"],
        capabilities: { hostname: "homelab.example.com", platform: "linux" },
      }),
    });
    expect(reclaimed.reclaimed).toBe(true);
    expect(reclaimed.device.id).toBe(created.device.id);
    expect(reclaimed.device.revokedAt).toBeNull();
    expect((await source(sourceId))?.deviceId).toBe(created.device.id);
    expect(await cursorOf(reclaimed.token, sourceId)).toEqual({ page: 42 });
  }, 60_000);

  test("a remote collector's name is still refused while its device is live", async () => {
    const res = await fetch(`${harness.gatewayUrl}/admin/devices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "laptop-collector",
        kind: "collector",
        scopes: ["read", "write:*"],
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("DEVICE_NAME_TAKEN");
  });
});
