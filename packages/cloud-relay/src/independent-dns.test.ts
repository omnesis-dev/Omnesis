// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles, listen } from "../test/support.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { prepareGatewayOwner, prepareGatewayRecoveryRequest } from "./gateway-key-client.js";
import { gatewayKeyAccount } from "./gateway-key-auth.js";
import {
  createRecoveryAuthority,
  signRecoveryReceipt,
  signRecoveryPolicy,
} from "./recovery-authority.js";
import { recoveryPolicyDigest } from "./recovery-contract.js";
import { loadTrustedRecoveryPolicy } from "./recovery-verifier.js";
import { IndependentDnsService } from "./independent-dns-service.js";
import { createIndependentDnsBroker } from "./independent-dns-server.js";
import { independentDnsPresenter } from "./independent-dns-client.js";
import {
  independentDnsRequestDigest,
  independentDnsTranscript,
} from "./independent-dns-contract.js";
import type { IndependentDnsRequest, IndependentDnsChallenge } from "./independent-dns-contract.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-independent-dns-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(
  policyLifetime = 3600,
  options: { certificateHostname?: string; publicOrigin?: string; suffix?: string } = {},
) {
  const tls = tlsFiles(directory, options.certificateHostname ?? "gateway.relay.example.test");
  const gateway = {
    relayUrl: "https://relay.example.test",
    gatewayId: randomUUID(),
    publicOrigin: options.publicOrigin ?? "https://gateway.relay.example.test",
    sessionFile: join(directory, "gateway-session.json"),
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
  };
  await prepareGatewayOwner(gateway);
  const owner = createPrivateKey(await readFile(`${gateway.sessionFile}.owner-key`)),
    tlsKey = createPrivateKey(await readFile(tls.keyFile));
  const draft = await prepareGatewayRecoveryRequest(gateway),
    authority = createRecoveryAuthority();
  const now = Math.floor(Date.now() / 1000);
  const receipt = signRecoveryReceipt(
    {
      ...draft,
      keyId: "independent",
      relayDomain: "relay.example.test",
      recoveryEpoch: 1,
      issuedAt: now - 10,
      expiresAt: now + 7200,
    },
    authority.privateKey,
  );
  await writeFile(`${gateway.sessionFile}.recovery.json`, JSON.stringify(receipt));
  const document = signRecoveryPolicy(
    {
      protocol: "omnesis-relay-recovery-policy",
      version: 1,
      keyId: "independent",
      relayOrigin: gateway.relayUrl,
      relayDomain: "relay.example.test",
      epoch: 1,
      minimumReceiptEpoch: 1,
      minimumReceiptVersion: 1,
      issuedAt: now - 10,
      expiresAt: now + policyLifetime,
      revokedGatewayIds: [],
      revokedOwnerSpkiFingerprints: [],
    },
    authority.privateKey,
  );
  const policy = loadTrustedRecoveryPolicy(document, {
    publicKey: authority.publicKey,
    keyId: "independent",
    relayOrigin: gateway.relayUrl,
    relayDomain: "relay.example.test",
    policySha256: recoveryPolicyDigest(document),
    minimumPolicyEpoch: 1,
  });
  const records = new Map<string, string>();
  const provider = {
    create: vi.fn(async (lease: { id: string; value: string }, signal: AbortSignal) => {
      signal.throwIfAborted();
      records.set(lease.id, lease.value);
    }),
    remove: vi.fn(async (lease: { id: string }, signal: AbortSignal) => {
      signal.throwIfAborted();
      records.delete(lease.id);
    }),
  };
  const dns = await AcmeDnsChallenges.open({
    file: join(directory, "broker-journal.json"),
    suffix: options.suffix ?? "relay.example.test",
    provider,
  });
  const input: IndependentDnsRequest = {
    registration: {
      gatewayId: gateway.gatewayId,
      publicOrigin: gateway.publicOrigin,
      certificate: await readFile(tls.certFile, "utf8"),
      ownerPublicKey: createPublicKey(owner).export({ type: "spki", format: "pem" }).toString(),
    },
    recoveryReceipt: receipt,
    operation: { type: "create", value: "a".repeat(43) },
  };
  const service = new IndependentDnsService({ origin: "https://broker.example.test", policy, dns });
  let broker: ReturnType<typeof createIndependentDnsBroker> | undefined;
  const proof = (challenge: IndependentDnsChallenge) => ({
    challengeId: challenge.challengeId,
    ownerSignature: sign(null, independentDnsTranscript(challenge, "owner"), owner).toString(
      "base64url",
    ),
    tlsSignature: sign("sha256", independentDnsTranscript(challenge, "tls"), tlsKey).toString(
      "base64url",
    ),
  });
  return {
    authority,
    gateway,
    policy,
    dns,
    records,
    provider,
    input,
    service,
    proof,
    async http(extra: Partial<Parameters<typeof createIndependentDnsBroker>[0]> = {}) {
      let url = "http://127.0.0.1";
      broker = createIndependentDnsBroker({ origin: () => url, policy, dns, ...extra });
      url = await listen(broker.server);
      return { url, broker };
    },
    async close() {
      service.close();
      if (broker) await broker.close();
      else await dns.close();
    },
  };
}
const alive = () => new AbortController().signal;

test("a signed receipt for another origin cannot remove a lease with the same owner, UUID, account and TLS key", async () => {
  const f = await fixture(3600, {
    certificateHostname: "*.example.test",
    publicOrigin: "https://gateway.example.test",
    suffix: "example.test",
  });
  try {
    const lease = await f.service.complete(f.proof(f.service.challenge(f.input)), alive());
    if (!("id" in lease)) throw new Error("Expected a DNS lease");
    const publicOrigin = "https://alternate.example.test";
    const alternate: IndependentDnsRequest = {
      registration: { ...f.input.registration, publicOrigin },
      recoveryReceipt: signRecoveryReceipt(
        { ...f.input.recoveryReceipt.payload, publicOrigin },
        f.authority.privateKey,
      ),
      operation: { type: "remove", leaseId: lease.id },
    };
    expect(alternate.registration.gatewayId).toBe(f.input.registration.gatewayId);
    expect(alternate.registration.ownerPublicKey).toBe(f.input.registration.ownerPublicKey);
    expect(alternate.registration.certificate).toBe(f.input.registration.certificate);
    expect(alternate.recoveryReceipt.payload.accountId).toBe(
      f.input.recoveryReceipt.payload.accountId,
    );
    await expect(
      f.service.complete(f.proof(f.service.challenge(alternate)), alive()),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.records.has(lease.id)).toBe(true);
    expect(f.provider.remove).not.toHaveBeenCalled();
    const authorized = { ...f.input, operation: alternate.operation };
    await expect(
      f.service.complete(f.proof(f.service.challenge(authorized)), alive()),
    ).resolves.toEqual({ removed: true });
    expect(f.records.has(lease.id)).toBe(false);
  } finally {
    await f.close();
  }
});

test("a receipt for another gateway cannot remove an existing lease even with the same owner and TLS keys", async () => {
  const f = await fixture();
  try {
    const lease = await f.service.complete(f.proof(f.service.challenge(f.input)), alive());
    if (!("id" in lease)) throw new Error("Expected a DNS lease");
    const gatewayId = randomUUID();
    const other: IndependentDnsRequest = {
      registration: { ...f.input.registration, gatewayId },
      recoveryReceipt: signRecoveryReceipt(
        {
          ...f.input.recoveryReceipt.payload,
          gatewayId,
          accountId: gatewayKeyAccount({ ...f.input.registration, gatewayId }),
        },
        f.authority.privateKey,
      ),
      operation: { type: "remove", leaseId: lease.id },
    };
    await expect(
      f.service.complete(f.proof(f.service.challenge(other)), alive()),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.records.has(lease.id)).toBe(true);
    expect(f.provider.remove).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("independent owner/TLS proofs alone publish/remove the receipt's exact TXT hostname, with one-use replay rejection", async () => {
  const f = await fixture();
  try {
    const challenge = f.service.challenge(f.input),
      proof = f.proof(challenge);
    const lease = await f.service.complete(proof, alive());
    expect(lease).toHaveProperty("id");
    expect(f.provider.create).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "gateway.relay.example.test", value: "a".repeat(43) }),
      expect.any(AbortSignal),
    );
    expect(f.records.size).toBe(1);
    await expect(f.service.complete(proof, alive())).rejects.toThrow("missing or expired");
    const remove = f.service.challenge({
      ...f.input,
      operation: { type: "remove", leaseId: (lease as { id: string }).id },
    });
    expect(await f.service.complete(f.proof(remove), alive())).toEqual({ removed: true });
    expect(f.records.size).toBe(0);
    expect(independentDnsRequestDigest(f.input)).not.toBe(
      independentDnsRequestDigest({
        ...f.input,
        operation: { type: "remove", leaseId: randomUUID() },
      }),
    );
    expect(independentDnsTranscript(challenge, "owner")).not.toEqual(
      independentDnsTranscript(challenge, "tls"),
    );
  } finally {
    await f.close();
  }
});

test("a compromised relay HMAC, altered operation/recipient, wrong TLS proof, missing receipt and stale current policy cannot authorize DNS", async () => {
  const f = await fixture(10);
  try {
    for (const mutation of [
      (c: IndependentDnsChallenge) => ({
        ...f.proof(c),
        ownerSignature: Buffer.alloc(32).toString("base64url"),
      }),
      (c: IndependentDnsChallenge) => ({
        ...f.proof(c),
        tlsSignature: Buffer.alloc(64).toString("base64url"),
      }),
      (c: IndependentDnsChallenge) =>
        f.proof({ ...c, brokerOrigin: "https://compromised-relay.example.test" }),
      (c: IndependentDnsChallenge) => f.proof({ ...c, requestDigest: "0".repeat(64) }),
    ]) {
      const challenge = f.service.challenge(f.input);
      await expect(f.service.complete(mutation(challenge), alive())).rejects.toThrow(
        "proof was refused",
      );
    }
    expect(() => f.service.challenge({ ...f.input, recoveryReceipt: undefined })).toThrow();
    expect(() =>
      f.service.challenge({
        ...f.input,
        recoveryReceipt: {
          ...f.input.recoveryReceipt,
          signature: Buffer.alloc(64).toString("base64url"),
        },
      }),
    ).toThrow("signature");
    const challenge = f.service.challenge(f.input);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11000);
    await expect(f.service.complete(f.proof(challenge), alive())).rejects.toThrow("not current");
    clock.mockRestore();
    expect(f.provider.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("challenge admission, expiry and broker shutdown remain bounded and do not permit stale proof reuse", async () => {
  const f = await fixture();
  try {
    for (const values of [
      { maxChallenges: 0 },
      { maxChallenges: 1.5 },
      { maxChallenges: 33 },
      { challengeTtlMs: 0 },
      { challengeTtlMs: 60001 },
    ])
      expect(
        () =>
          new IndependentDnsService({
            origin: "https://broker.example.test",
            policy: f.policy,
            dns: f.dns,
            ...values,
          }),
      ).toThrow("limits");
    expect(
      () => new IndependentDnsService({ origin: "bad", policy: f.policy, dns: f.dns }),
    ).toThrow();
    const service = new IndependentDnsService({
      origin: "https://broker.example.test",
      policy: f.policy,
      dns: f.dns,
      maxChallenges: 1,
      challengeTtlMs: 10,
    });
    const old = service.challenge(f.input);
    expect(() => service.challenge(f.input)).toThrow("capacity");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20);
    await expect(service.complete(f.proof(old), alive())).rejects.toThrow("expired");
    const next = service.challenge(f.input);
    clock.mockRestore();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(service.complete(f.proof(next), abort.signal)).rejects.toThrow("cancelled");
    service.close();
    expect(() => service.challenge(f.input)).toThrow("closed");
    await expect(service.complete(f.proof(next), alive())).rejects.toThrow("closed");
    const cleanup = new IndependentDnsService({
      origin: "https://broker.example.test",
      policy: f.policy,
      dns: f.dns,
      maxChallenges: 1,
      challengeTtlMs: 10,
    });
    cleanup.challenge(f.input);
    const expired = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20);
    expect(() => cleanup.challenge(f.input)).not.toThrow();
    expired.mockRestore();
    cleanup.close();
  } finally {
    await f.close();
  }
});

test("real broker HTTP and gateway presenter use direct signed requests without a relay session/provider token and clean up after cancellation", async () => {
  const f = await fixture();
  try {
    const { url } = await f.http();
    const transport = vi.fn<typeof fetch>((url, init) => fetch(url, init));
    const presenter = independentDnsPresenter({
      brokerUrl: url,
      gateway: { ...f.gateway, ownerKeyFile: `${f.gateway.sessionFile}.owner-key` },
      fetch: transport,
    });
    const lease = await presenter.create("c".repeat(43), alive());
    expect(f.records.size).toBe(1);
    const aborted = new AbortController();
    aborted.abort();
    await presenter.remove(lease.id, aborted.signal);
    expect(f.records.size).toBe(0);
    expect(transport).toHaveBeenCalledTimes(4);
    for (const call of transport.mock.calls) {
      expect(String(call[0])).toMatch(/^http:\/\/127\.0\.0\.1/);
      expect(call[1]!.signal!.aborted).toBe(false);
      expect(JSON.stringify(call[1]!.headers)).not.toMatch(/authorization|session|token/i);
      expect(String(call[1]!.body)).not.toContain("PRIVATE KEY");
      expect(call[1]!.redirect).toBe("error");
    }
    await expect(presenter.create("d".repeat(43), aborted.signal)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(4);
    await rm(`${f.gateway.sessionFile}.recovery.json`);
    await expect(presenter.create("c".repeat(43), alive())).rejects.toThrow(
      "existing signed recovery receipt",
    );
  } finally {
    await f.close();
  }
});

test("broker HTTP refuses unbounded bodies, malformed messages and unsupported method/path, and bounds unauthenticated admission", async () => {
  const f = await fixture();
  // Keep the admission window fixed while real HTTP requests cross the transport boundary.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const { url } = await f.http({ loginLimits: { maxConcurrent: 1, maxPerMinute: 12 } });
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    expect((await fetch(url + "/unknown", { method: "POST" })).status).toBe(404);
    expect((await fetch(url + "/_dns/v1/challenge", { method: "POST", body: "{}" })).status).toBe(
      415,
    );
    const post = (body: string) =>
      fetch(url + "/_dns/v1/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await fetch(url + "/_dns/v1/challenge", { method: "POST" })).status).toBe(415);
    expect((await post("bad-json")).status).toBe(400);
    expect((await post("{}")).status).toBe(400);
    expect((await post("x".repeat(40001))).status).toBe(413);
    for (let i = 0; i < 5; i++) await post("{}");
    expect((await post("{}")).status).toBe(429);
  } finally {
    await f.close();
    clock.mockRestore();
  }
});

test("a synthetic RFC8555 authority issues through the independent broker and gateway ACME selector, keeping account/TLS keys off the broker", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const f = await fixture();
  const { localAcmeAuthority } = await import("../test/acme-authority.js");
  const { issueAcmeCertificate } = await import("./acme-client.js");
  const { createGatewayAcmeController } = await import("./acme-integration.js");
  const { validateAcmeCertificate } = await import("./acme-gateway.js");
  const keys = await import("./gateway-key-client.js");
  const authority = await localAcmeAuthority(directory, "gateway.relay.example.test", f.records);
  let controller: Awaited<ReturnType<typeof createGatewayAcmeController>>;
  try {
    const { url } = await f.http();
    vi.spyOn(keys, "registerGatewayKey").mockResolvedValue({
      token: "existing-relay-authority",
      accountId: f.input.recoveryReceipt.payload.accountId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const transport = vi.fn<typeof fetch>((url, init) => fetch(url, init));
    const activate = vi.fn(async () => {});
    controller = await createGatewayAcmeController(
      {
        OMNESIS_ACME_DIRECTORY_URL: authority.directoryUrl,
        OMNESIS_ACME_TERMS_ACCEPTED: "1",
        OMNESIS_ACME_CERT_FILE: f.gateway.certificateFile,
        OMNESIS_ACME_KEY_FILE: f.gateway.privateKeyFile,
        OMNESIS_ACME_DNS_PROVIDER: "independent",
        OMNESIS_ACME_DNS_BROKER_URL: url,
        OMNESIS_CLOUD_RELAY_URL: f.gateway.relayUrl,
        OMNESIS_CLOUD_RELAY_SESSION_FILE: f.gateway.sessionFile,
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: f.gateway.gatewayId,
        OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: f.gateway.publicOrigin,
      },
      {
        configDir: directory,
        activate,
        fetch: transport,
        trustedRoots: [authority.root],
        issuer: (options) =>
          issueAcmeCertificate({
            ...options,
            lookup: async (_host, value) => [...f.records.values()].includes(value),
          }),
      },
    );
    expect(await controller!.renew(alive())).toBe(true);
    const pem = await readFile(f.gateway.certificateFile, "utf8"),
      privateKey = await readFile(f.gateway.privateKeyFile, "utf8");
    expect(
      validateAcmeCertificate(pem, privateKey, "gateway.relay.example.test", [authority.root])
        .subjectAltName,
    ).toBe("DNS:gateway.relay.example.test");
    expect(authority.requests).toContain("/finalize");
    expect(authority.requests).toContain("/certificate");
    expect(f.records.size).toBe(0);
    expect(
      transport.mock.calls.every(([requestUrl]) => new URL(String(requestUrl)).origin === url),
    ).toBe(true);
    expect(transport.mock.calls.map((call) => String(call[1]!.body)).join("\n")).not.toContain(
      "PRIVATE KEY",
    );
    expect(activate).toHaveBeenCalled();
  } finally {
    await controller?.close();
    await authority.close();
    await f.close();
    vi.unstubAllEnvs();
  }
});

test("independent mode requires an operator broker URL and refuses a local DNS-provider token", async () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  const { createGatewayAcmeController } = await import("./acme-integration.js");
  const base = {
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_TERMS_ACCEPTED: "1",
    OMNESIS_ACME_CERT_FILE: join(directory, "public.pem"),
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
    OMNESIS_ACME_DNS_PROVIDER: "independent",
  };
  try {
    for (const patch of [
      {},
      {
        OMNESIS_ACME_DNS_BROKER_URL: "https://broker.example.test",
        OMNESIS_ACME_DNS_TOKEN_FILE: "/private/broker-only-token",
      },
    ])
      await expect(
        createGatewayAcmeController(
          { ...base, ...patch },
          { configDir: directory, activate: async () => {} },
        ),
      ).rejects.toThrow("no local provider token");
    await expect(
      createGatewayAcmeController(
        {
          ...base,
          OMNESIS_ACME_DNS_PROVIDER: "relay",
          OMNESIS_ACME_DNS_BROKER_URL: "https://broker.example.test",
        },
        { configDir: directory, activate: async () => {} },
      ),
    ).rejects.toThrow("requires the independent DNS provider");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("closing an independent broker is idempotent before listen and still closes a listener when provider cleanup fails", async () => {
  const f = await fixture();
  const broker = createIndependentDnsBroker({
    origin: "https://broker.example.test",
    policy: f.policy,
    dns: f.dns,
  });
  const close = vi.spyOn(f.dns, "close");
  await Promise.all([broker.close(), broker.close()]);
  expect(close).toHaveBeenCalledOnce();
  await f.close();
  const second = await fixture();
  try {
    const { broker: active } = await second.http();
    vi.spyOn(second.dns, "close").mockRejectedValueOnce(new Error("private-provider-fixture"));
    await expect(active.close()).rejects.toThrow("private-provider-fixture");
    expect(active.server.listening).toBe(false);
  } finally {
    await second.dns.close();
  }
});

test("gateway client refuses swapped broker recipient, operation digest, expiry, wrong private key and oversized material before completing proof", async () => {
  const f = await fixture();
  try {
    const { url } = await f.http();
    for (const patch of [
      { brokerOrigin: "https://another-broker.example.test" },
      { requestDigest: "0".repeat(64) },
      { expiresAt: Date.now() - 1 },
      { expiresAt: Date.now() + 120_000 },
    ]) {
      const transport = vi.fn<typeof fetch>(async (url, init) => {
        const response = await fetch(url, init);
        return Response.json({ ...(await response.json()), ...patch });
      });
      await expect(
        independentDnsPresenter({ brokerUrl: url, gateway: f.gateway, fetch: transport }).create(
          "a".repeat(43),
          alive(),
        ),
      ).rejects.toThrow("does not match");
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const unavailable = vi.fn<typeof fetch>(
      async () => new Response("private-provider-detail", { status: 503 }),
    );
    await expect(
      independentDnsPresenter({ brokerUrl: url, gateway: f.gateway, fetch: unavailable }).create(
        "a".repeat(43),
        alive(),
      ),
    ).rejects.toThrow("broker refused");
    expect(f.provider.create).not.toHaveBeenCalled();
    const tls = await readFile(f.gateway.privateKeyFile, "utf8");
    const other = await import("node:crypto");
    await writeFile(
      f.gateway.privateKeyFile,
      other
        .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    await expect(
      independentDnsPresenter({ brokerUrl: url, gateway: f.gateway }).create(
        "a".repeat(43),
        alive(),
      ),
    ).rejects.toThrow("do not match");
    await writeFile(f.gateway.privateKeyFile, "x".repeat(65_537));
    await expect(
      independentDnsPresenter({ brokerUrl: url, gateway: f.gateway }).create(
        "a".repeat(43),
        alive(),
      ),
    ).rejects.toThrow("too large");
    await writeFile(f.gateway.privateKeyFile, tls);
    const aborted = new AbortController();
    const cancel = vi.fn<typeof fetch>(async (url, init) => {
      const reply = await fetch(url, init);
      const body = await reply.json();
      aborted.abort(new Error("cancelled after challenge"));
      return Response.json(body);
    });
    await expect(
      independentDnsPresenter({ brokerUrl: url, gateway: f.gateway, fetch: cancel }).create(
        "a".repeat(43),
        aborted.signal,
      ),
    ).rejects.toThrow("cancelled after challenge");
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test("HTTP disconnect cancels an accepted publication and bounded admission prevents an unbounded queue", async () => {
  const f = await fixture();
  try {
    const { url, broker } = await f.http({ loginLimits: { maxConcurrent: 1, maxPerMinute: 60 } });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.provider.create.mockImplementationOnce(async (_lease, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const stop = new AbortController();
    const presenter = independentDnsPresenter({ brokerUrl: url, gateway: f.gateway });
    const operation = presenter.create("a".repeat(43), stop.signal);
    const cancelled = expect(operation).rejects.toThrow();
    await started;
    expect(
      (
        await fetch(url + "/_dns/v1/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(f.input),
        })
      ).status,
    ).toBe(429);
    stop.abort();
    await cancelled;
    const { until } = await import("../test/support.js");
    await until(() => f.provider.remove.mock.calls.length > 0);
    expect(f.records.size).toBe(0);
    // Explicitly exercise the accepted TCP reset boundary without logging peer details.
    const { connect } = await import("node:net");
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
    const connected = once(socket, "connect");
    const connection = await new Promise<import("node:net").Socket>((resolve) =>
      broker.server.once("connection", resolve),
    );
    await connected;
    connection.emit("error", new Error("synthetic reset"));
    socket.destroy();
  } finally {
    await f.close();
  }
});

test("HTTP body deadlines destroy slow peers, preserve sent response status, and close failures never skip DNS cleanup", async () => {
  const f = await fixture();
  try {
    const { url, broker } = await f.http();
    broker.server.prependOnceListener("request", (_req, res) => res.writeHead(202));
    expect(
      (
        await fetch(url + "/_dns/v1/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "bad-json",
        })
      ).status,
    ).toBe(202);
    const { connect } = await import("node:net");
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
    socket.on("error", () => {});
    await once(socket, "connect");
    const accepted = once(broker.server, "request");
    vi.useFakeTimers();
    socket.write(
      "POST /_dns/v1/challenge HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
    );
    await accepted;
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    await vi.advanceTimersByTimeAsync(15000);
    await closed;
    vi.useRealTimers();
    const original = broker.server.close.bind(broker.server);
    const close = vi.spyOn(broker.server, "close").mockImplementation((callback) => {
      callback?.(new Error("synthetic server close failure"));
      return broker.server;
    });
    await expect(broker.close()).rejects.toThrow("synthetic server close failure");
    close.mockRestore();
    await new Promise<void>((resolve, reject) =>
      original((error) => (error ? reject(error) : resolve())),
    );
  } finally {
    await f.dns.close();
  }
});

test("public broker health reports only independently verified policy freshness and fails closed at expiry", async () => {
  const f = await fixture();
  try {
    const { url } = await f.http();
    const response = await fetch(url + "/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      protocol: "omnesis-independent-dns-v1",
      recovery: { epoch: 1, expiresAt: f.policy.expiresAt, state: "current" },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.policy.expiresAt * 1000);
    const expired = await fetch(url + "/healthz");
    expect(expired.status).toBe(503);
    expect(await expired.json()).toEqual({
      ok: false,
      protocol: "omnesis-independent-dns-v1",
      recovery: { epoch: 1, expiresAt: f.policy.expiresAt, state: "expired" },
    });
    clock.mockRestore();
    expect(f.provider.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("broker factory serves real verified TLS and treats an empty JSON body as malformed", async () => {
  const f = await fixture();
  try {
    const tls = tlsFiles(directory, "localhost"),
      cert = await readFile(tls.certFile, "utf8"),
      key = await readFile(tls.keyFile, "utf8");
    const { url } = await f.http({ tls: { cert, key } });
    const https = await import("node:https");
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = https.request(
        {
          host: "127.0.0.1",
          port: Number(new URL(url).port),
          servername: "localhost",
          ca: cert,
          rejectUnauthorized: true,
          method: "POST",
          path: "/_dns/v1/challenge",
          headers: { "content-type": "application/json", "content-length": 0 },
        },
        (reply) => {
          const parts: Buffer[] = [];
          reply.on("data", (chunk) => parts.push(chunk));
          reply.on("end", () =>
            resolve({ status: reply.statusCode!, body: Buffer.concat(parts).toString("utf8") }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(response).toEqual({ status: 400, body: "" });
  } finally {
    await f.close();
  }
});
