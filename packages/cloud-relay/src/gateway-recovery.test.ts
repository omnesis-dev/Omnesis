// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRecoveryAuthority, signRecoveryReceipt } from "./recovery-authority.js";
import { gatewayRecoveryDraft, readGatewayRecoveryReceipt } from "./gateway-recovery.js";
import {
  prepareGatewayRecoveryRequest,
  readOrCreateGatewayOwnerKey,
} from "./gateway-key-client.js";
import * as credentials from "./google-credentials.js";

let directory: string;
const authority = createRecoveryAuthority();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-gateway-recovery-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const options = {
    relayUrl: "https://relay.example.test",
    sessionFile: join(directory, "session.json"),
    gatewayId: "b714074e-2354-49a9-b6ae-0eccfb7c2f01",
    publicOrigin: "https://gateway.example.test",
  };
  const owner = await readOrCreateGatewayOwnerKey(`${options.sessionFile}.owner-key`);
  const ownerPublicKey = createPublicKey(owner).export({ type: "spki", format: "pem" }).toString();
  const draft = gatewayRecoveryDraft(options, { ...options, ownerPublicKey });
  const now = Math.floor(Date.now() / 1000);
  const receipt = signRecoveryReceipt(
    {
      ...draft,
      keyId: "independent",
      relayDomain: "relay.example.test",
      issuedAt: now - 60,
      expiresAt: now + 3600,
      recoveryEpoch: 1,
    },
    authority.privateKey,
  );
  return { options, receipt, draft, identity: { ...options, ownerPublicKey } };
}

test("offline request preparation never mints a lost owner and exports no TLS or private material", async () => {
  const f = await fixture();
  expect(await prepareGatewayRecoveryRequest(f.options)).toEqual(f.draft);
  expect(JSON.stringify(f.draft)).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(f.draft)).not.toContain("certificate");
  const explicit = join(directory, "owner.pem");
  await writeFile(explicit, await readFile(`${f.options.sessionFile}.owner-key`));
  expect(await prepareGatewayRecoveryRequest({ ...f.options, ownerKeyFile: explicit })).toEqual(
    f.draft,
  );
  await rm(`${f.options.sessionFile}.owner-key`);
  await expect(prepareGatewayRecoveryRequest(f.options)).rejects.toThrow("missing");
  await expect(readFile(`${f.options.sessionFile}.owner-key`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("every fresh proof can carry a bounded exact owner receipt from its default or explicit file", async () => {
  const f = await fixture();
  expect(await readGatewayRecoveryReceipt(f.options, f.identity)).toBeUndefined();
  const path = `${f.options.sessionFile}.recovery.json`;
  await writeFile(path, JSON.stringify(f.receipt));
  expect(await readGatewayRecoveryReceipt(f.options, f.identity)).toEqual(f.receipt);
  const explicit = join(directory, "receipt.json");
  await writeFile(explicit, JSON.stringify(f.receipt));
  expect(
    await readGatewayRecoveryReceipt({ ...f.options, recoveryReceiptFile: explicit }, f.identity),
  ).toEqual(f.receipt);
  for (const change of [
    { gatewayId: "c714074e-2354-49a9-b6ae-0eccfb7c2f01" },
    { publicOrigin: "https://other.example.test" },
    { ownerPublicKey: createRecoveryAuthority().publicKey },
  ])
    await expect(
      readGatewayRecoveryReceipt(f.options, { ...f.identity, ...change }),
    ).rejects.toThrow("does not match");
  await expect(
    readGatewayRecoveryReceipt(
      { ...f.options, relayUrl: "https://other.example.test" },
      f.identity,
    ),
  ).rejects.toThrow("does not match");
  for (const patch of [{ ownerSpkiFingerprint: "a".repeat(64) }, { accountId: "a".repeat(64) }]) {
    await writeFile(
      path,
      JSON.stringify({ ...f.receipt, payload: { ...f.receipt.payload, ...patch } }),
    );
    await expect(readGatewayRecoveryReceipt(f.options, f.identity)).rejects.toThrow();
  }
  for (const patch of [
    { issuedAt: Math.floor(Date.now() / 1000) + 100 },
    { issuedAt: 1, expiresAt: 2 },
  ]) {
    await writeFile(
      path,
      JSON.stringify(signRecoveryReceipt({ ...f.receipt.payload, ...patch }, authority.privateKey)),
    );
    await expect(readGatewayRecoveryReceipt(f.options, f.identity)).rejects.toThrow("not current");
  }
  await writeFile(path, "not json");
  await expect(readGatewayRecoveryReceipt(f.options, f.identity)).rejects.toThrow();
  await writeFile(path, "x".repeat(65_537));
  await expect(readGatewayRecoveryReceipt(f.options, f.identity)).rejects.toThrow("too large");
});

test("unreadable recovery artifacts cannot silently downgrade to invitation or receipt-less enrollment", async () => {
  const f = await fixture();
  const read = vi.spyOn(credentials, "readPrivateJson");
  for (const failure of [
    new Error("unreadable"),
    Object.assign(new Error("denied"), { code: "EACCES" }),
    "invalid",
    null,
  ]) {
    read.mockRejectedValueOnce(failure);
    await expect(readGatewayRecoveryReceipt(f.options, f.identity)).rejects.toBe(failure);
  }
});

test("real sockets recover absent heartbeats, abrupt resets and transient session failures without invalidating authority", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { GatewayTunnel } = await import("./tunnel-client.js");
  const { listen, until, closeServer } = await import("../test/support.js");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  let admitted = 0;
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (ws) => {
      admitted++;
      ws.send(JSON.stringify({ type: "ready", version: 1, heartbeatMs: 20 }));
      if (admitted === 2) setImmediate(() => ws.terminate());
      // Other accepted controls deliberately omit pings; the gateway must detect the half-open peer.
    }),
  );
  const relayUrl = await listen(server);
  const invalidate = vi.fn();
  const session = vi
    .fn<(...args: unknown[]) => Promise<string>>()
    .mockRejectedValueOnce(
      Object.assign(new Error("temporary DNS lookup failure"), { code: "EAI_AGAIN" }),
    )
    .mockResolvedValue("existing-authority");
  const tunnel = new GatewayTunnel({
    relayUrl,
    gatewayUrl: "https://localhost:1",
    gatewayId: "b714074e-2354-49a9-b6ae-0eccfb7c2f01",
    session,
    invalidateSession: invalidate,
    reconnectMs: 10,
  });
  try {
    tunnel.start();
    await until(() => admitted >= 3 && tunnel.status().state === "online");
    expect(session.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(invalidate).not.toHaveBeenCalled();
    tunnel.stop();
    await until(() => sockets.clients.size === 0);
    expect(tunnel.status().state).toBe("disabled");
  } finally {
    tunnel.stop();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await closeServer(server);
    vi.unstubAllEnvs();
  }
});
