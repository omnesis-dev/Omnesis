// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeCommand, PROTOCOL_VERSION, type WsResponse } from "@omnesis/core";
import {
  SCOPE_READ,
  SCOPE_SUBSCRIPTIONS_ANSWER,
  SCOPE_SUBSCRIPTIONS_MANAGE,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  SourceType,
  writeScope,
  type DeviceCapability,
  type DeviceId,
} from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  createPairing,
  getDevice,
  peekPairing,
} from "../../data/repositories/DeviceRepository.js";
import { createToken, listTokens, lookupToken } from "../../data/repositories/TokenRepository.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { DeviceWsServer } from "../../ws.js";
import { createSubscription } from "../../subscriptions/store-mutations.js";
import { PairingService, type PairingServiceDeps } from "./PairingService.js";
import type { CreateSubscriptionMutation } from "../../subscriptions/store-types.js";

const openClawCapabilities: DeviceCapability = {
  suggestedName: "fictional-openclaw",
  platform: "openclaw",
  agentIntegration: {
    harness: "openclaw",
    deliveryProtocolMin: 3,
    deliveryProtocolMax: 3,
    maxConcurrentRuns: 2,
  },
};

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-pairing-service-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeService(overrides: Partial<PairingServiceDeps> = {}): PairingService {
  return new PairingService({
    db,
    writeGate: directWriteGate(db),
    statusCache: { bump: vi.fn() },
    sourceService: { clearRemovedForDeviceTypes: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  });
}

describe("PairingService", () => {
  test("returns a regular device credential when source cleanup fails", async () => {
    const pairing = createPairing(db, {
      name: "fictional-cli",
      kind: "cli",
      scopes: [SCOPE_READ],
    });
    const writeGate = directWriteGate(db);
    const cleanup = vi.fn().mockRejectedValue(new Error("fictional cleanup failure"));
    const service = makeService({
      writeGate,
      sourceService: { clearRemovedForDeviceTypes: cleanup },
    });

    const result = await service.redeem({ pairingCode: pairing.pairingCode });

    expect(result.outcome).toBe("paired-device");
    if (result.outcome !== "paired-device") throw new Error("expected paired-device");
    expect(result.token).toMatch(/^omn_/);
    expect(lookupToken(db, result.token)).toMatchObject({
      deviceId: result.device.id,
      scopes: [SCOPE_READ],
    });
    expect(peekPairing(db, pairing.pairingCode)).toBeNull();
    expect(cleanup).toHaveBeenCalledWith([]);
  });

  test("returns committed credentials when post-pair source cleanup fails", async () => {
    const pairing = createPairing(db, {
      name: "fictional-openclaw",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });
    const cleanup = vi.fn().mockRejectedValue(new Error("fictional cleanup failure"));
    const service = makeService({
      sourceService: { clearRemovedForDeviceTypes: cleanup },
    });

    const result = await service.redeem({
      pairingCode: pairing.pairingCode,
      capabilities: openClawCapabilities,
      agentIntegration: { harness: "openclaw" },
    });

    expect(result.outcome).toBe("paired-agent");
    if (result.outcome !== "paired-agent") throw new Error("expected paired-agent");
    expect(Object.keys(result.credentials).sort()).toEqual(["delivery", "ingestion", "management"]);
    expect(result.credentials.delivery.token).toMatch(/^omn_/);
    expect(result.credentials.delivery.scopes).toEqual([SCOPE_SUBSCRIPTIONS_RECEIVE]);
    expect(result.credentials.ingestion.scopes).toEqual([writeScope(SourceType("openclaw"))]);
    expect(result.credentials.management.scopes).toEqual([SCOPE_SUBSCRIPTIONS_MANAGE]);
    expect(listTokens(db, result.device.id)).toHaveLength(3);
    expect(peekPairing(db, pairing.pairingCode)).toBeNull();
    expect(cleanup).toHaveBeenCalledWith(["openclaw"]);
  });

  test("recovers the same committed agent credentials after the pairing code is consumed", async () => {
    const pairing = createPairing(db, {
      name: "fictional-openclaw-recovery",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const bump = vi.fn();
    const service = makeService({
      statusCache: { bump },
      sourceService: { clearRemovedForDeviceTypes: cleanup },
    });
    const request = {
      pairingCode: pairing.pairingCode,
      capabilities: openClawCapabilities,
      agentIntegration: { harness: "openclaw" as const },
      idempotencyKey: "i".repeat(43),
    };

    const first = await service.redeem(request);
    const recovered = await service.redeem(request);

    expect(recovered).toEqual(first);
    expect(listTokens(db)).toHaveLength(3);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledTimes(1);
  });

  test("recovers the same committed device credential after the pairing code is consumed", async () => {
    const pairing = createPairing(db, {
      name: "fictional-browser-recovery",
      kind: "browser",
      scopes: [writeScope(SourceType("web"))],
    });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const bump = vi.fn();
    const service = makeService({
      statusCache: { bump },
      sourceService: { clearRemovedForDeviceTypes: cleanup },
    });
    const request = {
      pairingCode: pairing.pairingCode,
      capabilities: { platform: "web", installId: "fictional-browser-install" },
      idempotencyKey: "d".repeat(43),
    };

    const first = await service.redeem(request);
    // The code is spent; the same request comes back after a lost response.
    const recovered = await service.redeem(request);

    expect(first.outcome).toBe("paired-device");
    expect(recovered).toEqual(first);
    if (first.outcome !== "paired-device") throw new Error("expected paired-device");
    expect(listTokens(db, first.device.id)).toHaveLength(1);
    // Post-commit work ran for the first attempt only.
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledTimes(1);
    // The same key with different capabilities is a misuse, not a replay.
    expect(
      await service.redeem({
        ...request,
        capabilities: { platform: "web", installId: "another-install" },
      }),
    ).toEqual({ outcome: "conflict", error: "pairing idempotency key was reused" });
  });

  test("repairs an install only through an explicitly bound code without orphaning subscriptions", async () => {
    const firstCode = createPairing(db, {
      name: "",
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });
    const service = makeService();
    const first = await service.redeem({
      pairingCode: firstCode.pairingCode,
      capabilities: openClawCapabilities,
      agentIntegration: { harness: "openclaw" },
    });
    expect(first.outcome).toBe("paired-agent");
    if (first.outcome !== "paired-agent") throw new Error("expected paired-agent");
    expect(first.device.name).toBe(openClawCapabilities.suggestedName);

    const subscriptionInput: CreateSubscriptionMutation = {
      id: "sub_fictional_repair",
      approvalId: "sapp_fictional_repair",
      workflowId: "wf_fictional_repair",
      integrationDeviceId: first.device.id,
      ownerId: `device:${first.device.id}`,
      clientRequestId: "request-fictional-repair",
      requestFingerprint: "fingerprint-fictional-repair",
      condition: {
        kind: "natural-language",
        description: "when a fictional launch record is created",
      },
      reaction: {
        kind: "agent-workflow",
        instruction: "Prepare a fictional launch checklist.",
      },
      interpretation: {
        summary: "A fictional launch record is created",
        pushDetail: "existence",
      },
      compiledPlan: {
        version: 1,
        events: ["created"],
        predicate: { kind: "title-equals", value: "Fictional launch record" },
      },
      compilerVersion: "test-v1",
      privacyCategories: ["documents"],
      policyRevision: "policy-a",
      createdAt: 100,
      expiresAt: 10_000,
      approvalExpiresAt: 2_000,
      workflowName: "Fictional repair workflow",
      workflowPurpose: "Prepare a fictional launch checklist.",
      createWorkflow: true,
      workflowExpiresAt: 10_000,
    };
    expect(createSubscription(db, subscriptionInput).outcome).toBe("created");
    const oldTokens = [
      first.credentials.delivery.token,
      first.credentials.ingestion.token,
      first.credentials.management.token,
    ];

    const repairCode = createPairing(db, {
      name: first.device.name,
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
      repairDeviceId: first.device.id,
    });
    const repaired = await service.redeem({
      pairingCode: repairCode.pairingCode,
      capabilities: openClawCapabilities,
      agentIntegration: { harness: "openclaw" },
    });
    expect(repaired.outcome).toBe("paired-agent");
    if (repaired.outcome !== "paired-agent") throw new Error("expected paired-agent");
    expect(repaired.device.id).toBe(first.device.id);
    expect(
      db
        .prepare<
          [string],
          { integration_device_id: string }
        >("SELECT integration_device_id FROM subscriptions WHERE id = ?")
        .get("sub_fictional_repair")?.integration_device_id,
    ).toBe(first.device.id);
    for (const token of oldTokens) expect(lookupToken(db, token)).toBeNull();
    expect(listTokens(db, first.device.id)).toHaveLength(3);
  });

  test("does not let an unnamed code take over an offline device by suggested name", async () => {
    const existing = createDevice(db, {
      name: openClawCapabilities.suggestedName!,
      kind: "agent",
      capabilities: openClawCapabilities,
    });
    const oldToken = createToken(
      db,
      existing.id,
      [SCOPE_SUBSCRIPTIONS_RECEIVE],
      "fictional-existing-delivery",
    );
    const pairing = createPairing(db, {
      kind: "agent",
      scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
    });

    const result = await makeService().redeem({
      pairingCode: pairing.pairingCode,
      capabilities: openClawCapabilities,
      agentIntegration: { harness: "openclaw" },
    });

    expect(result).toMatchObject({ outcome: "conflict" });
    expect(peekPairing(db, pairing.pairingCode)).not.toBeNull();
    expect(lookupToken(db, oldToken.token)?.deviceId).toBe(existing.id);
  });

  test("evicts an old socket that authenticates during the repair transaction race", async () => {
    const existing = createDevice(db, {
      name: "fictional-openclaw",
      kind: "agent",
      capabilities: openClawCapabilities,
    });
    const oldCredential = createToken(
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

    const writerEntered = deferred();
    const releaseWriter = deferred();
    const baseWriteGate = directWriteGate(db);
    const gatedWriteGate: WriteGate = {
      ...baseWriteGate,
      redeemAgentIntegrationPairing: async (input) => {
        writerEntered.resolve();
        await releaseWriter.promise;
        return baseWriteGate.redeemAgentIntegrationPairing(input);
      },
    };
    const wsServer = new DeviceWsServer({
      db,
      writeGate: gatedWriteGate,
      authTimeoutMs: 5_000,
      heartbeatIntervalMs: 60_000,
    });
    const service = makeService({ writeGate: gatedWriteGate, wsServer });

    const redeemPromise = service.redeem({
      pairingCode: pairing.pairingCode,
      capabilities: openClawCapabilities,
      agentIntegration: { harness: "openclaw" },
    });
    await writerEntered.promise;

    const helloComplete = deferred();
    let socketClosed = false;
    const socket = {
      send(data: string) {
        const envelope = JSON.parse(data) as WsResponse;
        if (envelope.kind === "response" && envelope.ok) helloComplete.resolve();
      },
      close() {
        socketClosed = true;
      },
    };
    const upgrade = wsServer.authenticateUpgradeToken(
      "fictional-pairing-race",
      oldCredential.token,
    );
    expect(upgrade.ok).toBe(true);
    if (!upgrade.ok) throw new Error("expected authenticated upgrade");
    wsServer.onOpen(socket, "fictional-pairing-race", upgrade.auth);
    wsServer.onMessage(
      socket,
      JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
    );
    await helloComplete.promise;
    expect(wsServer.isConnected(existing.id)).toBe(true);

    let pendingSocketClosed = false;
    const pendingSocket = {
      send(_data: string) {},
      close() {
        pendingSocketClosed = true;
      },
    };
    const pendingUpgrade = wsServer.authenticateUpgradeToken(
      "fictional-pairing-pending",
      oldCredential.token,
    );
    expect(pendingUpgrade.ok).toBe(true);
    if (!pendingUpgrade.ok) throw new Error("expected pending authenticated upgrade");
    wsServer.onOpen(pendingSocket, "fictional-pairing-pending", pendingUpgrade.auth);

    // Model the narrowest transport race: HTTP upgrade auth has succeeded,
    // but the WebSocket onOpen callback has not registered the socket yet.
    const lateUpgrade = wsServer.authenticateUpgradeToken(
      "fictional-pairing-late-open",
      oldCredential.token,
    );
    expect(lateUpgrade.ok).toBe(true);
    if (!lateUpgrade.ok) throw new Error("expected late authenticated upgrade");

    releaseWriter.resolve();
    const result = await redeemPromise;

    expect(result.outcome).toBe("paired-agent");
    expect(socketClosed).toBe(true);
    expect(pendingSocketClosed).toBe(true);
    expect(wsServer.isConnected(existing.id)).toBe(false);
    expect(lookupToken(db, oldCredential.token)).toBeNull();
    await expect(
      wsServer.sendCommand(
        existing.id,
        "subscription.commit",
        {
          protocolVersion: 3,
          deliveryId: "sdel_fictional",
        },
        100,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      ),
    ).rejects.toThrow(`device ${existing.id} not connected`);

    const lateHello = deferred();
    let lateSocketClosed = false;
    let lateHelloError: string | undefined;
    const lateSocket = {
      send(data: string) {
        const envelope = JSON.parse(data) as WsResponse;
        if (envelope.kind === "response" && !envelope.ok) {
          lateHelloError = envelope.error.code;
          lateHello.resolve();
        }
      },
      close() {
        lateSocketClosed = true;
      },
    };
    wsServer.onOpen(lateSocket, "fictional-pairing-late-open", lateUpgrade.auth);
    wsServer.onMessage(
      lateSocket,
      JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
    );
    await lateHello.promise;
    expect(lateHelloError).toBe("invalid_token");
    expect(lateSocketClosed).toBe(true);
    expect(wsServer.isConnected(existing.id)).toBe(false);
  });

  describe("reconnecting an agent host by its own credential", () => {
    async function pairFirst(service = makeService()) {
      const code = createPairing(db, { kind: "agent", scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE] });
      const first = await service.redeem({
        pairingCode: code.pairingCode,
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
      });
      if (first.outcome !== "paired-agent") throw new Error("expected paired-agent");
      return first;
    }

    function freshCode(opts: { repairDeviceId?: DeviceId; name?: string } = {}) {
      return createPairing(db, {
        kind: "agent",
        scopes: [SCOPE_SUBSCRIPTIONS_RECEIVE],
        ...opts,
      }).pairingCode;
    }

    function subscriptionFor(deviceId: DeviceId): CreateSubscriptionMutation {
      return {
        id: "sub_fictional_reconnect",
        approvalId: "sapp_fictional_reconnect",
        workflowId: "wf_fictional_reconnect",
        integrationDeviceId: deviceId,
        ownerId: `device:${deviceId}`,
        clientRequestId: "request-fictional-reconnect",
        requestFingerprint: "fingerprint-fictional-reconnect",
        condition: { kind: "natural-language", description: "when a fictional memo is created" },
        reaction: { kind: "agent-workflow", instruction: "Summarize the fictional memo." },
        interpretation: { summary: "A fictional memo is created", pushDetail: "existence" },
        compiledPlan: {
          version: 1,
          events: ["created"],
          predicate: { kind: "title-equals", value: "Fictional memo" },
        },
        compilerVersion: "test-v1",
        privacyCategories: ["documents"],
        policyRevision: "policy-a",
        createdAt: 100,
        expiresAt: 10_000,
        approvalExpiresAt: 2_000,
        workflowName: "Fictional reconnect workflow",
        workflowPurpose: "Summarize the fictional memo.",
        createWorkflow: true,
        workflowExpiresAt: 10_000,
      };
    }

    test("an unbound code keeps the device id, its subscriptions, and rotates every credential", async () => {
      const first = await pairFirst();
      expect(createSubscription(db, subscriptionFor(first.device.id)).outcome).toBe("created");
      const oldTokens = Object.values(first.credentials).map((entry) => entry.token);
      const disconnectDevice = vi.fn();
      // The installation being reinstalled is the one holding the live socket.
      const service = makeService({
        wsServer: { isConnected: () => true, disconnectDevice },
      });

      const reconnected = await service.redeem({
        pairingCode: freshCode(),
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
        continuityCredential: first.credentials.delivery.token,
      });

      expect(reconnected).toMatchObject({ outcome: "paired-agent", reconnected: true });
      if (reconnected.outcome !== "paired-agent") throw new Error("expected paired-agent");
      expect(reconnected.device.id).toBe(first.device.id);
      expect(reconnected.device.name).toBe(first.device.name);
      for (const token of oldTokens) expect(lookupToken(db, token)).toBeNull();
      expect(lookupToken(db, reconnected.credentials.management.token)?.deviceId).toBe(
        first.device.id,
      );
      expect(listTokens(db, first.device.id)).toHaveLength(3);
      expect(disconnectDevice).toHaveBeenCalledWith(first.device.id);
      expect(
        db
          .prepare<
            [string],
            { integration_device_id: string }
          >("SELECT integration_device_id FROM subscriptions WHERE id = ?")
          .get("sub_fictional_reconnect")?.integration_device_id,
      ).toBe(first.device.id);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM devices WHERE kind = 'agent'").get(),
      ).toEqual({ count: 1 });
    });

    test("an admin-named code reconnects under the device's own name", async () => {
      const first = await pairFirst();
      const reconnected = await makeService().redeem({
        pairingCode: freshCode({ name: "Fictional renamed integration" }),
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
        continuityCredential: first.credentials.management.token,
      });
      expect(reconnected).toMatchObject({
        outcome: "paired-agent",
        reconnected: true,
        device: { id: first.device.id, name: first.device.name },
      });
    });

    test("a replayed reconnect returns the same credentials after the old ones are gone", async () => {
      const first = await pairFirst();
      const service = makeService();
      const request = {
        pairingCode: freshCode(),
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" as const },
        continuityCredential: first.credentials.delivery.token,
        idempotencyKey: "r".repeat(43),
      };
      const reconnected = await service.redeem(request);
      expect(reconnected).toMatchObject({ outcome: "paired-agent", reconnected: true });
      // The presented credential was revoked by the reconnect itself; the lost
      // response is still recovered from the receipt.
      expect(await service.redeem(request)).toEqual(reconnected);
    });

    test("another host with no credential cannot take over the device by its name", async () => {
      const first = await pairFirst();
      const code = freshCode();
      const result = await makeService().redeem({
        pairingCode: code,
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
      });
      expect(result).toMatchObject({ outcome: "conflict", code: "AGENT_DEVICE_EXISTS" });
      expect(peekPairing(db, code)).not.toBeNull();
      expect(lookupToken(db, first.credentials.delivery.token)?.deviceId).toBe(first.device.id);
    });

    test("an unknown or foreign credential proves nothing", async () => {
      const first = await pairFirst();
      const hermes = createDevice(db, {
        name: "fictional-hermes",
        kind: "agent",
        capabilities: {
          suggestedName: "fictional-hermes",
          agentIntegration: { ...openClawCapabilities.agentIntegration!, harness: "hermes" },
        },
      });
      const hermesToken = createToken(db, hermes.id, [SCOPE_SUBSCRIPTIONS_RECEIVE], "hermes");
      const cli = createDevice(db, { name: "fictional-cli", kind: "cli" });
      const cliToken = createToken(db, cli.id, [SCOPE_READ], "cli");
      for (const credential of ["omn_fictional_unknown", hermesToken.token, cliToken.token]) {
        const code = freshCode();
        const result = await makeService().redeem({
          pairingCode: code,
          capabilities: openClawCapabilities,
          agentIntegration: { harness: "openclaw" },
          continuityCredential: credential,
        });
        expect(result).toMatchObject({ outcome: "conflict", code: "AGENT_DEVICE_EXISTS" });
        expect(peekPairing(db, code)).not.toBeNull();
      }
      expect(lookupToken(db, first.credentials.delivery.token)?.deviceId).toBe(first.device.id);
      expect(lookupToken(db, hermesToken.token)?.deviceId).toBe(hermes.id);
    });

    test("a different machine with its own identity gets its own device", async () => {
      const first = await pairFirst();
      const second = await makeService().redeem({
        pairingCode: freshCode(),
        capabilities: { ...openClawCapabilities, suggestedName: "fictional-openclaw-second" },
        agentIntegration: { harness: "openclaw" },
      });
      expect(second).toMatchObject({ outcome: "paired-agent", reconnected: false });
      if (second.outcome !== "paired-agent") throw new Error("expected paired-agent");
      expect(second.device.id).not.toBe(first.device.id);
      expect(lookupToken(db, first.credentials.delivery.token)?.deviceId).toBe(first.device.id);
    });

    test("a code bound to one device refuses a host connected as another", async () => {
      const first = await pairFirst();
      const other = await makeService().redeem({
        pairingCode: freshCode(),
        capabilities: { ...openClawCapabilities, suggestedName: "fictional-openclaw-other" },
        agentIntegration: { harness: "openclaw" },
      });
      if (other.outcome !== "paired-agent") throw new Error("expected paired-agent");
      const code = freshCode({ repairDeviceId: first.device.id });
      const result = await makeService().redeem({
        pairingCode: code,
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
        continuityCredential: other.credentials.delivery.token,
      });
      expect(result).toMatchObject({ outcome: "conflict", code: "AGENT_DEVICE_MISMATCH" });
      expect(peekPairing(db, code)).not.toBeNull();
      expect(lookupToken(db, first.credentials.delivery.token)?.deviceId).toBe(first.device.id);
      expect(lookupToken(db, other.credentials.delivery.token)?.deviceId).toBe(other.device.id);
    });

    test("a bound code repairs an online device only for the host that holds its credential", async () => {
      const first = await pairFirst();
      const online = makeService({
        wsServer: { isConnected: () => true, disconnectDevice: vi.fn() },
      });
      const code = freshCode({ repairDeviceId: first.device.id });
      expect(
        await online.redeem({
          pairingCode: code,
          capabilities: openClawCapabilities,
          agentIntegration: { harness: "openclaw" },
        }),
      ).toMatchObject({ outcome: "conflict", code: "AGENT_DEVICE_ONLINE" });

      const repaired = await online.redeem({
        pairingCode: code,
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
        continuityCredential: first.credentials.ingestion.token,
      });
      expect(repaired).toMatchObject({
        outcome: "paired-agent",
        reconnected: true,
        device: { id: first.device.id },
      });
    });

    test("a bound repair code still works for a host that lost its credentials", async () => {
      const first = await pairFirst();
      const repaired = await makeService().redeem({
        pairingCode: freshCode({ repairDeviceId: first.device.id }),
        capabilities: { ...openClawCapabilities, suggestedName: "fictional-openclaw-reinstall" },
        agentIntegration: { harness: "openclaw" },
      });
      expect(repaired).toMatchObject({
        outcome: "paired-agent",
        reconnected: true,
        device: { id: first.device.id, name: first.device.name },
      });
      expect(lookupToken(db, first.credentials.delivery.token)).toBeNull();
    });

    test("a credential revoked before the writer commits proves nothing", async () => {
      const first = await pairFirst();
      const baseWriteGate = directWriteGate(db);
      const racingWriteGate: WriteGate = {
        ...baseWriteGate,
        redeemAgentIntegrationPairing: async (input) => {
          db.prepare("DELETE FROM tokens WHERE device_id = ?").run(first.device.id);
          return baseWriteGate.redeemAgentIntegrationPairing(input);
        },
      };
      const code = freshCode();
      const result = await makeService({ writeGate: racingWriteGate }).redeem({
        pairingCode: code,
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
        continuityCredential: first.credentials.delivery.token,
      });
      expect(result).toMatchObject({ outcome: "conflict", code: "AGENT_CREDENTIAL_STALE" });
      expect(peekPairing(db, code)).not.toBeNull();
    });

    // Revocation also deletes the device's tokens; marking the row alone
    // shows the proof depends on the device, not only on its tokens.
    const markRevoked = (deviceId: DeviceId) =>
      db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(deviceId);

    test("a credential of a revoked device proves nothing", async () => {
      const early = await pairFirst();
      markRevoked(early.device.id);
      const earlyCode = freshCode();
      expect(
        await makeService().redeem({
          pairingCode: earlyCode,
          capabilities: openClawCapabilities,
          agentIntegration: { harness: "openclaw" },
          continuityCredential: early.credentials.delivery.token,
        }),
      ).toMatchObject({ outcome: "conflict", code: "AGENT_DEVICE_EXISTS" });
      expect(peekPairing(db, earlyCode)).not.toBeNull();
    });

    test("a device revoked between the preflight and the commit is not reconnected", async () => {
      const late = await pairFirst();
      const baseWriteGate = directWriteGate(db);
      const racingWriteGate: WriteGate = {
        ...baseWriteGate,
        redeemAgentIntegrationPairing: async (input) => {
          markRevoked(late.device.id);
          return baseWriteGate.redeemAgentIntegrationPairing(input);
        },
      };
      const lateCode = freshCode();
      expect(
        await makeService({ writeGate: racingWriteGate }).redeem({
          pairingCode: lateCode,
          capabilities: openClawCapabilities,
          agentIntegration: { harness: "openclaw" },
          continuityCredential: late.credentials.delivery.token,
        }),
      ).toMatchObject({ outcome: "conflict", code: "AGENT_CREDENTIAL_STALE" });
      expect(peekPairing(db, lateCode)).not.toBeNull();
      expect(getDevice(db, late.device.id)?.revokedAt).not.toBeNull();
    });

    test("a per-run or expiring token of the device proves nothing", async () => {
      const first = await pairFirst();
      // An agent run is handed short-lived tokens of its device; they live in
      // a runtime that handles untrusted content, so they cannot rotate the
      // device's standing credentials.
      const perRun = createToken(
        db,
        first.device.id,
        [SCOPE_SUBSCRIPTIONS_ANSWER],
        "fictional-run-answer",
        { ttlMs: 60_000 },
      );
      const expiringDelivery = createToken(
        db,
        first.device.id,
        [SCOPE_SUBSCRIPTIONS_RECEIVE],
        "fictional-expiring-delivery",
        { ttlMs: 60_000 },
      );
      // A standing token an administrator minted with a wider grant is not
      // one of the three a pairing mints either.
      const widened = createToken(
        db,
        first.device.id,
        [SCOPE_SUBSCRIPTIONS_RECEIVE, SCOPE_SUBSCRIPTIONS_ANSWER],
        "fictional-widened-delivery",
      );
      for (const credential of [perRun.token, expiringDelivery.token, widened.token]) {
        const code = freshCode();
        const result = await makeService().redeem({
          pairingCode: code,
          capabilities: openClawCapabilities,
          agentIntegration: { harness: "openclaw" },
          continuityCredential: credential,
        });
        expect(result).toMatchObject({ outcome: "conflict", code: "AGENT_DEVICE_EXISTS" });
        expect(peekPairing(db, code)).not.toBeNull();
      }
      expect(lookupToken(db, first.credentials.delivery.token)?.deviceId).toBe(first.device.id);
    });

    test("a reconnect keeps the device's self identities when its code stages none", async () => {
      const first = await pairFirst();
      db.prepare("UPDATE devices SET self_emails = ? WHERE id = ?").run(
        JSON.stringify(["maya.reeves@example.com"]),
        first.device.id,
      );
      const reconnected = await makeService().redeem({
        pairingCode: freshCode(),
        capabilities: openClawCapabilities,
        agentIntegration: { harness: "openclaw" },
        continuityCredential: first.credentials.delivery.token,
      });
      expect(reconnected).toMatchObject({
        outcome: "paired-agent",
        device: { selfEmails: ["maya.reeves@example.com"] },
      });
    });

    test("a continuity credential is refused on a code for another device kind", async () => {
      const first = await pairFirst();
      const code = createPairing(db, { name: "fictional-cli", kind: "cli", scopes: [SCOPE_READ] });
      expect(
        await makeService().redeem({
          pairingCode: code.pairingCode,
          continuityCredential: first.credentials.delivery.token,
        }),
      ).toMatchObject({ outcome: "invalid" });
    });
  });
});
