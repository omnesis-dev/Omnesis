// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPrivateKey, randomBytes, randomUUID, sign, X509Certificate } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { once } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { listen, until, closeServer } from "../test/support.js";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { GatewayTunnel } from "./tunnel-client.js";
import { RelayAccounts } from "./accounts.js";
import { createCloudRelay, type CloudRelayOptions } from "./server.js";
import { accountId, RelaySessions } from "./identity.js";
import {
  keyAuthenticationTranscript,
  gatewayKeyIdentity,
  type KeyChallenge,
} from "./gateway-key-auth.js";
import { createRecoveryAuthority, signRecoveryReceipt } from "./recovery-authority.js";
import type { AddressInfo } from "node:net";
import type { TrustedRecoveryPolicy } from "./recovery-verifier.js";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "server-recovery-"));
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function setup(
  policy?:
    false | ((fixture: Awaited<ReturnType<typeof recoveryFixture>>) => TrustedRecoveryPolicy),
  extra: Pick<CloudRelayOptions, "hostnameProof" | "legacyRoutes"> = {},
) {
  const logicalOrigin = "http://127.0.0.1:31999",
    f = await recoveryFixture(directory, logicalOrigin),
    path = join(directory, `relay-${randomUUID()}.sqlite`);
  const accounts = new RelayAccounts(path),
    sessions = new RelaySessions(randomBytes(32));
  const google = {
    issuer: "https://accounts.google.com",
    subject: "fictional-google-owner",
    expiresAt: f.now + 3600,
  };
  const gatewayIdentity = { verify: vi.fn(async (_token: string, _nonce?: string) => google) };
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: logicalOrigin,
    allowLoopbackEnrollment: true,
    hostnameProof: extra.hostnameProof ?? (() => Promise.resolve(true)),
    recoveryPolicy: policy === false ? undefined : (policy?.(f) ?? f.policy()),
    gatewayIdentity,
    legacyRoutes: extra.legacyRoutes,
  });
  expect(relay.metrics()).toContain("cloud_relay_recovery_policy_epoch ");
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  const request = (
    path: string,
    body?: unknown,
    token?: string,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(url + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const complete = async (
    receipt: unknown,
    extra: Record<string, unknown> = {},
    registration = f.registration,
    owner = f.owner.privateKey,
  ) => {
    const challengeResponse = await request("/_relay/v2/key/challenge", {
      ...registration,
      relayOrigin: logicalOrigin,
    });
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as KeyChallenge;
    return request("/_relay/v2/key/complete", {
      challengeId: challenge.challengeId,
      ownerSignature: sign(
        null,
        keyAuthenticationTranscript(registration, challenge, "owner"),
        createPrivateKey(owner),
      ).toString("base64url"),
      tlsSignature: sign(
        "sha256",
        keyAuthenticationTranscript(registration, challenge, "tls"),
        createPrivateKey(await readFile(f.files.keyFile)),
      ).toString("base64url"),
      ...(receipt === undefined ? {} : { recoveryReceipt: receipt }),
      ...extra,
    });
  };
  return { ...f, url, path, accounts, sessions, relay, request, complete, google, gatewayIdentity };
}
test("independent receipt is mandatory after an empty DB even with loopback enrollment or a valid old HMAC invitation", async () => {
  const f = await setup();
  expect((await f.complete(undefined)).status).toBe(403);
  const invitation = await f.sessions.issueEnrollmentInvitation(
    f.registration.gatewayId,
    "http://127.0.0.1:31999",
  );
  expect((await f.complete(undefined, { enrollmentToken: invitation })).status).toBe(403);
  const admitted = await f.complete(f.receipt());
  expect(admitted.status).toBe(200);
  const session = await admitted.json();
  expect(session.accountId).toBe(f.account);
  expect((await f.request("/_relay/v2/gateway", undefined, session.token)).status).toBe(200);
});
test("expired, stale-epoch, revoked and counterfeit receipt proofs never enroll and cannot consume the host", async () => {
  const f = await setup((value) =>
    value.policy({ revokedGatewayIds: [value.registration.gatewayId] }),
  );
  for (const receipt of [
    f.receipt(),
    f.receipt({ issuedAt: f.now - 100, expiresAt: f.now - 1 }),
    f.receipt({ recoveryEpoch: 1 }),
    { ...f.receipt(), signature: "A".repeat(86) },
  ])
    expect((await f.complete(receipt)).status).toBe(403);
  expect(f.accounts.gatewayBinding(f.account)).toBeUndefined();
  expect(f.accounts.accountForHostname("gateway.example.test")).toBeUndefined();
});
test("existing routing HMAC cannot bypass a revoked or replaced stored receipt at normal authentication", async () => {
  const f = await setup();
  const response = await f.complete(f.receipt());
  expect(response.status).toBe(200);
  const session = await response.json();
  const raw = new Database(f.path);
  try {
    for (const receipt of [
      "null",
      "{",
      "x".repeat(65537),
      JSON.stringify(f.receipt({ recoveryEpoch: 1 })),
    ]) {
      raw.prepare("UPDATE relay_gateway_recovery SET receipt=?").run(receipt);
      expect((await f.request("/_relay/v2/gateway", undefined, session.token)).status).toBe(401);
    }
    raw.prepare("DELETE FROM relay_gateway_recovery").run();
    expect((await f.request("/_relay/v2/gateway", undefined, session.token)).status).toBe(401);
  } finally {
    raw.close();
  }
});
test("policy expiry caps new routing sessions and invalidates an existing credential without changing a device key", async () => {
  const f = await setup((value) => value.policy({ expiresAt: value.now + 120 }));
  const response = await f.complete(f.receipt());
  expect(response.status).toBe(200);
  const session = await response.json();
  expect(session.expiresAt).toBeLessThanOrEqual(f.now + 120);
  expect(
    JSON.parse(Buffer.from(session.token.split(".")[1], "base64url").toString()).exp,
  ).toBeLessThanOrEqual(f.now + 120);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((f.now + 121) * 1000);
  expect((await f.request("/_relay/v2/gateway", undefined, session.token)).status).toBe(401);
});
test("restored Google alias rows are not authority; fresh owner+Google proof links discovery until explicit unlink", async () => {
  const f = await setup();
  const response = await f.complete(f.receipt());
  expect(response.status).toBe(200);
  const ownerSession = await response.json();
  const googleAccount = accountId(f.google),
    googleSession = await f.sessions.issue(f.google),
    raw = new Database(f.path);
  try {
    raw
      .prepare(
        "INSERT INTO relay_identity_aliases (identity_account_id, routing_account_id) VALUES (?,?)",
      )
      .run(googleAccount, f.account);
    expect((await f.request("/_relay/v2/gateway", undefined, googleSession.token)).status).not.toBe(
      200,
    );
    expect(
      (
        await f.request(
          "/_relay/v2/key/google-link",
          { identityToken: "fictional-web-token" },
          ownerSession.token,
        )
      ).status,
    ).toBe(204);
    expect(f.gatewayIdentity.verify).toHaveBeenCalledWith(
      "fictional-web-token",
      expect.any(String),
    );
    const discovered = await f.request("/_relay/v2/gateway", undefined, googleSession.token);
    expect(discovered.status).toBe(200);
    // Directory candidates are untrusted hints; local SAS comparison still authorizes device pairing.
    expect((await discovered.json()).identityToken).toBe(f.binding.identityToken);
    expect(
      (await f.request("/_relay/v2/key/google-link", undefined, ownerSession.token, "DELETE"))
        .status,
    ).toBe(204);
    expect((await f.request("/_relay/v2/gateway", undefined, googleSession.token)).status).not.toBe(
      200,
    );
  } finally {
    raw.close();
  }
});

test("fresh dual-key proof cannot use another owner's receipt, a wrong hostname or a different signing authority", async () => {
  const f = await setup(),
    otherOwner = createRecoveryAuthority();
  const attacker = await f.complete(
    f.receipt(),
    {},
    { ...f.registration, ownerPublicKey: otherOwner.publicKey },
    otherOwner.privateKey,
  );
  expect(attacker.status).toBe(403);
  for (const receipt of [
    f.receipt({ publicOrigin: "https://other.example.test" }),
    signRecoveryReceipt(f.receipt().payload, createRecoveryAuthority().privateKey),
  ])
    expect((await f.complete(receipt)).status).toBe(403);
  expect(f.accounts.gatewayBinding(f.account)).toBeUndefined();
  expect((await f.complete(f.receipt())).status).toBe(200);
});

test("SNI routing rechecks untrusted receipt rows before any application bytes enter a live gateway", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const f = await setup();
  const response = await f.complete(f.receipt());
  expect(response.status).toBe(200);
  const session = await response.json();
  let requests = 0;
  const gateway = createHttpsServer(
    { cert: f.registration.certificate, key: await readFile(f.files.keyFile) },
    (_req, res) => {
      requests++;
      res.end("fixture gateway");
    },
  );
  const gatewayUrl = (await listen(gateway)).replace("http:", "https:");
  cleanup.push(() => closeServer(gateway));
  f.relay.dataServer.listen(0, "127.0.0.1");
  await once(f.relay.dataServer, "listening");
  const tunnel = new GatewayTunnel({
    relayUrl: f.url,
    gatewayUrl,
    gatewayId: f.registration.gatewayId,
    session: () => Promise.resolve(session.token),
  });
  cleanup.push(async () => {
    tunnel.stop();
  });
  tunnel.start();
  await until(() => tunnel.status().state === "online");
  const exchange = () =>
    new Promise<number>((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: (f.relay.dataServer.address() as AddressInfo).port,
          servername: "gateway.example.test",
          ca: f.registration.certificate,
          agent: false,
          timeout: 3000,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error("fixture deadline")));
      request.end();
    });
  expect(await exchange()).toBe(200);
  expect(requests).toBe(1);
  const raw = new Database(f.path);
  try {
    raw.prepare("UPDATE relay_gateway_recovery SET receipt=?").run("null");
    await expect(exchange()).rejects.toThrow();
    expect(requests).toBe(1);
  } finally {
    raw.close();
  }
});

test("receiptless HMAC or Google account cannot reserve an unknown gateway UUID through the WebSocket control route", async () => {
  const f = await setup(),
    unbound = await f.sessions.issue(f.google);
  f.accounts.registerAccount(unbound.accountId);
  const status = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(f.url.replace("http:", "ws:") + "/_relay/v1/tunnel", {
      headers: {
        authorization: `Bearer ${unbound.token}`,
        "x-omnesis-gateway-id": f.registration.gatewayId,
        "x-omnesis-tunnel-protocol": "2",
      },
    });
    socket.once("open", () => {
      resolve(101);
      socket.terminate();
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      socket.terminate();
    });
    socket.once("error", reject);
  });
  expect([401, 403]).toContain(status);
  expect((await f.complete(f.receipt())).status).toBe(200);
});
test("revocation of a gateway or owner blocks normal HMAC authentication of restored bindings", async () => {
  for (const kind of ["gateway", "owner"] as const) {
    const f = await setup((value) =>
      value.policy(
        kind === "gateway"
          ? { revokedGatewayIds: [value.registration.gatewayId] }
          : { revokedOwnerSpkiFingerprints: [value.receipt().payload.ownerSpkiFingerprint] },
      ),
    );
    f.accounts.registerKeyBinding(f.account, f.binding, true, f.receipt());
    const session = await f.sessions.issue({
      issuer: "omnesis-gateway-owner-key-v2",
      subject: JSON.stringify([f.registration.gatewayId, f.receipt().payload.ownerSpkiFingerprint]),
      expiresAt: f.now + 3600,
    });
    expect((await f.request("/_relay/v2/gateway", undefined, session.token)).status).toBe(401);
  }
});

test("receipts are not silently ignored by an installation without independent recovery configuration", async () => {
  const f = await setup(false);
  expect((await f.complete(f.receipt())).status).toBe(503);
  expect(f.accounts.gatewayBinding(f.account)).toBeUndefined();
});
test("recovery owner sessions cannot publish legacy Google-only replacement bindings", async () => {
  for (const [legacyRoutes, status] of [
    [false, 404],
    [true, 403],
  ] as const) {
    const f = await setup(undefined, { legacyRoutes });
    const certificate = f.registration.certificate.replace(/\r?\n/g, "\r\n");
    f.registration.certificate = certificate;
    f.binding.certificate = certificate;
    await writeFile(f.files.certFile, certificate);
    const response = await f.complete(f.receipt());
    expect(response.status).toBe(200);
    const session = await response.json();
    expect((await f.request("/_relay/v2/gateway", f.binding, session.token)).status).toBe(status);
    expect(f.accounts.gatewayBinding(f.account)).toEqual({
      ...f.binding,
      certificate: new X509Certificate(certificate).toString(),
    });
    expect(f.registration.certificate).toBe(certificate);
    expect(await readFile(f.files.certFile, "utf8")).toBe(certificate);
  }
});
test("fresh Google aliases allow multiple gateways across independent owner sessions and unlink does not affect another owner", async () => {
  const f = await setup(),
    enrolled = await f.complete(f.receipt());
  expect(enrolled.status).toBe(200);
  const first = await enrolled.json();
  const secondDirectory = await mkdtemp(join(directory, "second-")),
    second = await recoveryFixture(
      secondDirectory,
      "http://127.0.0.1:31999",
      "https://other.example.test",
    );
  const secondReceipt = f.receipt({
    gatewayId: second.registration.gatewayId,
    publicOrigin: second.registration.publicOrigin,
    ownerPublicKey: second.owner.publicKey,
    ownerSpkiFingerprint: second.receipt().payload.ownerSpkiFingerprint,
    accountId: second.account,
  });
  f.accounts.registerKeyBinding(second.account, second.binding, true, secondReceipt);
  const other = await f.sessions.issue(gatewayKeyIdentity(second.registration, f.now + 3600));
  const link = (token: string) =>
    f.request("/_relay/v2/key/google-link", { identityToken: "fictional-web-token" }, token);
  expect((await link(first.token)).status).toBe(204);
  expect(
    await (await f.request("/_relay/v2/key/google-link", undefined, first.token)).json(),
  ).toEqual({ googleAccountId: accountId(f.google) });
  expect((await link(other.token)).status).toBe(204);
  const googleSession = await f.sessions.issue(f.google);
  const choices = await f.request("/_relay/v2/gateways", undefined, googleSession.token);
  expect(choices.status).toBe(200);
  expect(choices.headers.get("cache-control")).toBe("no-store");
  expect(
    (await choices.json()).gateways.map((value: { gatewayId: string }) => value.gatewayId).sort(),
  ).toEqual([f.registration.gatewayId, second.registration.gatewayId].sort());
  expect((await f.request("/_relay/v2/gateway", undefined, googleSession.token)).status).toBe(409);
  for (const gatewayId of [f.registration.gatewayId, second.registration.gatewayId]) {
    const selected = await f.request(
      `/_relay/v2/gateway?gatewayId=${gatewayId}`,
      undefined,
      googleSession.token,
    );
    expect(selected.status).toBe(200);
    expect((await selected.json()).gatewayId).toBe(gatewayId);
  }
  expect(
    (
      await f.request(
        `/_relay/v2/gateway?gatewayId=${randomUUID()}`,
        undefined,
        googleSession.token,
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.request("/_relay/v2/gateways?after=invalid", undefined, googleSession.token)).status,
  ).toBe(400);
  expect((await f.request("/_relay/v2/gateways", {}, googleSession.token)).status).toBe(405);
  const stranger = await f.sessions.issue({ ...f.google, subject: "fictional-unrelated-account" });
  expect(
    (
      await f.request(
        `/_relay/v2/gateway?gatewayId=${f.registration.gatewayId}`,
        undefined,
        stranger.token,
      )
    ).status,
  ).toBe(404);
  expect((await f.request("/_relay/v2/gateways", undefined, stranger.token)).status).toBe(200);
  expect((await f.request("/_relay/v2/gateway", {}, googleSession.token)).status).toBe(404);
  const anotherGoogle = { ...f.google, subject: "second-fictional-google" };
  f.gatewayIdentity.verify.mockResolvedValue(anotherGoogle);
  expect((await link(first.token)).status).toBe(409);
  expect((await link(other.token)).status).toBe(409);
  expect(
    (await f.request("/_relay/v2/key/google-link", undefined, other.token, "DELETE")).status,
  ).toBe(204);
  expect((await link(other.token)).status).toBe(204);
  expect(
    (await f.request("/_relay/v2/key/google-link", undefined, first.token, "DELETE")).status,
  ).toBe(204);
  expect(
    await (await f.request("/_relay/v2/key/google-link", undefined, other.token)).json(),
  ).toEqual({ googleAccountId: accountId(anotherGoogle) });
  // The injected provider contract may be misconfigured; a raw owner issuer is never a Google alias.
  f.gatewayIdentity.verify.mockResolvedValue(gatewayKeyIdentity(second.registration, f.now + 3600));
  expect((await link(other.token)).status).toBe(409);
});

test.each(["receipt", "policy"] as const)(
  "a %s expiring during asynchronous hostname proof cannot commit a recovery registration",
  async (kind) => {
    let entered!: () => void, release!: () => void;
    const checking = new Promise<void>((resolve) => (entered = resolve)),
      proof = new Promise<void>((resolve) => (release = resolve));
    const f = await setup(
      kind === "policy" ? (value) => value.policy({ expiresAt: value.now + 10 }) : undefined,
      {
        hostnameProof: async () => {
          entered();
          await proof;
          return true;
        },
      },
    );
    const pending = f.complete(
      kind === "receipt" ? f.receipt({ expiresAt: f.now + 10 }) : f.receipt(),
    );
    await checking;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((f.now + 11) * 1000);
    release();
    expect((await pending).status).toBe(403);
    expect(f.accounts.gatewayBinding(f.account)).toBeUndefined();
    expect(f.accounts.accountForHostname("gateway.example.test")).toBeUndefined();
  },
);

test("normal relay restart preserves sealed Google discovery; secret rotation requires fresh linking", async () => {
  const f = await setup();
  const response = await f.complete(f.receipt());
  const owner = await response.json();
  expect(
    (
      await f.request(
        "/_relay/v2/key/google-link",
        { identityToken: "fictional-web-token" },
        owner.token,
      )
    ).status,
  ).toBe(204);
  // A second daemon opens the durable registry with the same stable control identity.
  for (const [sessions, expected] of [
    [f.sessions, 1],
    [new RelaySessions(randomBytes(32)), 0],
  ] as const) {
    const accounts = new RelayAccounts(f.path);
    const relay = createCloudRelay({
      accounts,
      sessions,
      controlOrigin: "http://127.0.0.1:31999",
      recoveryPolicy: f.policy(),
    });
    const url = await listen(relay.server);
    try {
      const token = await sessions.issue(f.google);
      const response = await fetch(url + "/_relay/v2/gateways", {
        headers: { authorization: `Bearer ${token.token}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).gateways).toHaveLength(expected);
    } finally {
      await relay.close();
      accounts.close();
    }
  }
});
