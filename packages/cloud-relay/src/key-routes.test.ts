// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { listen, tlsFiles } from "../test/support.js";
import { createCloudRelay, type CloudRelayOptions } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions, accountId } from "./identity.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { gatewayBindingNonce } from "./gateway-binding.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-key-route-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function setup(extra: Partial<CloudRelayOptions> = {}) {
  const accounts = new RelayAccounts(":memory:", 1);
  const sessions = new RelaySessions(randomBytes(32));
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: "https://relay.example.test",
    hostnameProof: async () => true,
    ...extra,
  });
  const url = await listen(relay.server);
  const tls = tlsFiles(directory, "gateway.example.test");
  const gatewayId = randomUUID();
  const enrollmentTokenFile = join(directory, "invite.json");
  const transport: typeof fetch = async (input, init) =>
    fetch(`${url}${new URL(String(input)).pathname}`, init);
  const options = {
    relayUrl: "https://relay.example.test",
    sessionFile: join(directory, `${gatewayId}.session.json`),
    gatewayId,
    publicOrigin: "https://gateway.example.test",
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
    enrollmentTokenFile,
    fetch: transport,
  };
  const invite = async (uuid = gatewayId, origin = options.relayUrl) =>
    writeFile(
      enrollmentTokenFile,
      JSON.stringify({ enrollmentToken: await sessions.issueEnrollmentInvitation(uuid, origin) }),
    );
  const request = (path: string, method = "GET", token?: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return {
    accounts,
    sessions,
    relay,
    url,
    options,
    invite,
    request,
    async close() {
      await relay.close();
      accounts.close();
    },
  };
}

test("public recipient on a loopback proxy requires a UUID invitation; failures leak no account slots and renewals need no invitation", async () => {
  const f = await setup({ allowLoopbackEnrollment: true });
  try {
    await expect(registerGatewayKey(f.options)).rejects.toThrow("registration refused");
    await f.invite(randomUUID());
    await expect(registerGatewayKey(f.options)).rejects.toThrow("registration refused");
    await f.invite(f.options.gatewayId, "https://other.example.test");
    await expect(registerGatewayKey(f.options)).rejects.toThrow("registration refused");
    await f.invite();
    const session = await registerGatewayKey(f.options);
    await rm(f.options.enrollmentTokenFile);
    const renewed = await registerGatewayKey(f.options);
    expect(renewed.accountId).toBe(session.accountId);
    expect(f.accounts.accountForHostname("gateway.example.test")).toBe(session.accountId);
    // Reusing this UUID-bound invitation with another owner never changes its established owner.
    const otherFile = join(directory, "other-session.json");
    await f.invite();
    await expect(registerGatewayKey({ ...f.options, sessionFile: otherFile })).rejects.toThrow(
      "registration refused",
    );
    expect(f.accounts.gatewayBinding(session.accountId)).toBeDefined();
  } finally {
    await f.close();
  }
});

test("key proof recipient requires trusted server configuration unless isolated loopback composition explicitly opts in", async () => {
  const f = await setup({ controlOrigin: undefined });
  try {
    const body = {
      gatewayId: f.options.gatewayId,
      publicOrigin: f.options.publicOrigin,
      certificate: await readFile(f.options.certificateFile, "utf8"),
      ownerPublicKey: "unused",
      relayOrigin: f.url,
    };
    expect((await f.request("/_relay/v2/key/challenge", "POST", undefined, body)).status).toBe(503);
    const wrongType = await fetch(`${f.url}/_relay/v2/key/challenge`, {
      method: "POST",
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    expect((await f.request("/_relay/v2/key/challenge")).status).toBe(405);
    expect((await f.request("/_relay/v2/key/complete", "POST", undefined, {})).status).toBe(400);
    const malformed = await fetch(`${f.url}/_relay/v2/key/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const oversized = await f.request("/_relay/v2/key/challenge", "POST", undefined, {
      data: "x".repeat(40_001),
    });
    expect(oversized.status).toBe(413);
  } finally {
    await f.close();
  }
});

const googleIdentity = {
  issuer: "https://accounts.google.com",
  subject: "test-google-subject",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};
test("optional Google aliases discover the same key-owned gateway but never authorize owner metadata, tunnel control or data", async () => {
  const verify = vi.fn(async () => googleIdentity);
  const f = await setup({ identity: { verify }, gatewayIdentity: { verify } });
  try {
    await f.invite();
    const owner = await registerGatewayKey(f.options);
    expect(
      await (await f.request("/_relay/v2/key/google-link", "GET", owner.token)).json(),
    ).toEqual({ googleAccountId: null });
    expect((await f.request("/_relay/v2/key/google-link", "DELETE", owner.token)).status).toBe(204);
    expect(
      (
        await f.request("/_relay/v2/key/google-link", "POST", owner.token, {
          identityToken: "fresh-google-proof",
        })
      ).status,
    ).toBe(204);
    expect(verify).toHaveBeenCalledWith(
      "fresh-google-proof",
      gatewayBindingNonce(f.accounts.gatewayBinding(owner.accountId)!),
    );
    expect(
      await (await f.request("/_relay/v2/key/google-link", "GET", owner.token)).json(),
    ).toEqual({ googleAccountId: accountId(googleIdentity) });
    const login = (await (
      await f.request("/_relay/v1/login", "POST", undefined, { idToken: "normal-client" })
    ).json()) as { token: string; accountId: string };
    expect(login.accountId).toBe(accountId(googleIdentity));
    expect(login.accountId).not.toBe(owner.accountId);
    expect((await f.request("/_relay/v2/gateway", "GET", login.token)).status).toBe(200);
    for (const method of ["GET", "POST", "DELETE"])
      expect(
        (
          await f.request(
            "/_relay/v2/key/google-link",
            method,
            login.token,
            method === "POST" ? { identityToken: "another" } : undefined,
          )
        ).status,
      ).toBe(403);
    expect((await f.request("/_relay/v2/gateway", "POST", login.token, {})).status).toBe(403);
    for (const path of ["/_relay/v1/tunnel", "/_relay/v1/data"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(f.url.replace("http:", "ws:") + path, {
          headers: {
            authorization: `Bearer ${login.token}`,
            "x-omnesis-gateway-id": f.options.gatewayId,
          },
        });
        socket.once("unexpected-response", (_req, response) => {
          resolve(response.statusCode!);
          response.resume();
          socket.terminate();
        });
        socket.once("open", () => {
          socket.close();
          reject(new Error("Aliased identity gained gateway control"));
        });
        socket.once("error", () => {});
      });
      expect(status).toBe(403);
    }
    expect((await f.request("/_relay/v2/key/google-link", "DELETE", owner.token)).status).toBe(204);
    expect((await f.request("/_relay/v2/gateway", "GET", login.token)).status).toBe(404);
    await expect(registerGatewayKey(f.options)).resolves.toMatchObject({
      accountId: owner.accountId,
    });
  } finally {
    await f.close();
  }
});

test("Google-link handles disabled providers, strict bodies and stale gateway identity without changing the key owner", async () => {
  const verify = vi.fn(async () => googleIdentity);
  const f = await setup({ gatewayIdentity: { verify } });
  try {
    await f.invite();
    const owner = await registerGatewayKey(f.options);
    expect((await f.request("/_relay/v2/key/google-link", "PUT", owner.token)).status).toBe(405);
    expect((await f.request("/_relay/v2/key/google-link", "POST", owner.token)).status).toBe(415);
    expect(
      (
        await f.request("/_relay/v2/key/google-link", "POST", owner.token, {
          idToken: "wrong-field",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/_relay/v2/key/google-link", "POST", owner.token, {
          identityToken: "x".repeat(20_001),
        })
      ).status,
    ).toBe(413);
    verify.mockRejectedValueOnce(new Error("invalid issuer"));
    expect(
      (await f.request("/_relay/v2/key/google-link", "POST", owner.token, { identityToken: "bad" }))
        .status,
    ).toBe(400);
    verify.mockImplementationOnce(async () => {
      const binding = f.accounts.gatewayBinding(owner.accountId)!;
      f.accounts.registerBinding(owner.accountId, {
        ...binding,
        publicOrigin: "https://rotated.example.test",
      });
      return googleIdentity;
    });
    expect(
      (
        await f.request("/_relay/v2/key/google-link", "POST", owner.token, {
          identityToken: "raced",
        })
      ).status,
    ).toBe(409);
    expect(f.accounts.googleAccountForOwner(owner.accountId)).toBeUndefined();
  } finally {
    await f.close();
  }
  const disabled = await setup();
  try {
    await disabled.invite();
    const owner = await registerGatewayKey(disabled.options);
    expect(
      (
        await disabled.request("/_relay/v2/key/google-link", "POST", owner.token, {
          identityToken: "unused",
        })
      ).status,
    ).toBe(503);
  } finally {
    await disabled.close();
  }
});

test("exact legacy TLS ownership migrates once, closes the legacy control and cannot be reclaimed with that TLS key", async () => {
  const f = await setup();
  const legacy = await f.sessions.issue(googleIdentity);
  const certificate = await readFile(f.options.certificateFile, "utf8");
  try {
    f.accounts.registerAccount(legacy.accountId);
    f.accounts.registerBinding(legacy.accountId, {
      gatewayId: f.options.gatewayId.toUpperCase(),
      publicOrigin: f.options.publicOrigin,
      certificate,
      identityToken: "old-Google-proof",
    });
    const socket = new WebSocket(f.url.replace("http:", "ws:") + "/_relay/v1/tunnel", {
      headers: {
        authorization: `Bearer ${legacy.token}`,
        "x-omnesis-tunnel-protocol": "2",
        "x-omnesis-gateway-id": f.options.gatewayId.toUpperCase(),
      },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("message", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const owner = await registerGatewayKey(f.options);
    await closed;
    expect(f.accounts.resolveAccount(legacy.accountId)).toBe(owner.accountId);
    expect((await f.request("/_relay/v2/gateway", "GET", legacy.token)).status).toBe(200);
    await expect(
      registerGatewayKey({ ...f.options, sessionFile: join(directory, "attacker.json") }),
    ).rejects.toThrow("refused");
    expect(f.accounts.gatewayBinding(owner.accountId)).toMatchObject({ certificate });
    const { TunnelBroker } = await import("./tunnels.js");
    const broker = new TunnelBroker();
    broker.closeAccount("not-connected");
    broker.close();
  } finally {
    await f.close();
  }
});

test("synthetic recipient derivation rejects unbound, Unix and public listeners and canonicalizes IPv6", async () => {
  const f = await setup({ controlOrigin: undefined, allowLoopbackEnrollment: true });
  try {
    const body = {
      gatewayId: f.options.gatewayId,
      publicOrigin: f.options.publicOrigin,
      certificate: await readFile(f.options.certificateFile, "utf8"),
      ownerPublicKey: "invalid",
      relayOrigin: "http://[::1]:1000",
    };
    const address = vi.spyOn(f.relay.server, "address");
    for (const value of [
      null,
      "/tmp/unused-socket",
      { address: "0.0.0.0", family: "IPv4", port: 1000 },
    ]) {
      address.mockReturnValue(value);
      expect((await f.request("/_relay/v2/key/challenge", "POST", undefined, body)).status).toBe(
        503,
      );
    }
    address.mockReturnValue({ address: "::1", family: "IPv6", port: 1000 });
    // The recipient is accepted; the deliberately malformed owner key is rejected during registration validation.
    expect((await f.request("/_relay/v2/key/challenge", "POST", undefined, body)).status).toBe(400);
    address.mockRestore();
  } finally {
    await f.close();
  }
});

test("isolated HTTPS control derives its TLS recipient while verifying the actual local control certificate", async () => {
  const tls = tlsFiles(directory, "gateway.example.test");
  const certificate = await readFile(tls.certFile, "utf8"),
    key = await readFile(tls.keyFile, "utf8");
  const accounts = new RelayAccounts(":memory:");
  const relay = createCloudRelay({
    accounts,
    sessions: new RelaySessions(randomBytes(32)),
    allowLoopbackEnrollment: true,
    tls: { cert: certificate, key },
    hostnameProof: async () => true,
  });
  const url = (await listen(relay.server)).replace("http:", "https:");
  const transport: typeof fetch = async (input, init) =>
    new Promise((resolve, reject) => {
      const request = httpsRequest(
        String(input),
        {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          ca: certificate,
          rejectUnauthorized: true,
        },
        (response) => {
          const parts: Buffer[] = [];
          response.on("data", (chunk) => parts.push(chunk));
          response.on("end", () =>
            resolve(new Response(Buffer.concat(parts), { status: response.statusCode })),
          );
        },
      );
      request.on("error", reject);
      request.end(init?.body);
    });
  try {
    await expect(
      registerGatewayKey({
        relayUrl: url,
        sessionFile: join(directory, "tls-session"),
        gatewayId: randomUUID(),
        publicOrigin: "https://gateway.example.test",
        certificateFile: tls.certFile,
        privateKeyFile: tls.keyFile,
        fetch: transport,
      }),
    ).resolves.toHaveProperty("token");
  } finally {
    await relay.close();
    accounts.close();
  }
});

test("synthetic completion never treats unknown, Unix or public physical bindings as private admission", async () => {
  const f = await setup({ allowLoopbackEnrollment: true });
  const address = vi.spyOn(f.relay.server, "address");
  try {
    for (const value of [
      null,
      "/tmp/unbound-fixture",
      { address: "0.0.0.0", family: "IPv4", port: 1000 },
    ]) {
      address.mockReturnValue(value);
      await expect(registerGatewayKey(f.options)).rejects.toThrow("registration refused");
    }
  } finally {
    address.mockRestore();
    await f.close();
  }
});
