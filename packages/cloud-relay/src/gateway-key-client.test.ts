// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  randomBytes,
  randomUUID,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir, symlink } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { dirname, join } from "node:path";
import * as core from "@omnesis/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tlsFiles, listen, until } from "../test/support.js";
import {
  registerGatewayKey,
  gatewayKeySessionSource,
  readOrCreateGatewayOwnerKey,
  prepareGatewayOwner,
} from "./gateway-key-client.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { KEY_BINDING_PREFIX } from "./gateway-key-auth.js";
import { CLOCK_SKEW_MS } from "./network.js";
import { GatewayTunnel } from "./tunnel-client.js";
import type { TrustedRecoveryPolicy } from "./recovery-verifier.js";
import type { AddressInfo } from "node:net";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, link: vi.fn(module.link) };
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-key-client-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
async function fixture(
  extra: Parameters<typeof createCloudRelay>[0]["hostnameProof"] = async () => true,
) {
  const tls = tlsFiles(directory, "gateway.example.test");
  const accounts = new RelayAccounts(":memory:");
  let relay = createCloudRelay({
    allowLoopbackEnrollment: true,
    accounts,
    sessions: new RelaySessions(randomBytes(32)),
    hostnameProof: extra,
  });
  const relayUrl = await listen(relay.server);
  const options = {
    relayUrl,
    sessionFile: join(directory, "session.json"),
    gatewayId: randomUUID(),
    publicOrigin: "https://gateway.example.test",
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
  };
  return {
    options,
    accounts,
    get relay() {
      return relay;
    },
    async rotate() {
      const port = (relay.server.address() as AddressInfo).port;
      await relay.close();
      relay = createCloudRelay({
        accounts,
        sessions: new RelaySessions(randomBytes(32)),
        hostnameProof: extra,
        allowLoopbackEnrollment: true,
      });
      relay.server.listen(port, "127.0.0.1");
      await once(relay.server, "listening");
    },
    async recovery(policy: TrustedRecoveryPolicy) {
      const port = (relay.server.address() as AddressInfo).port;
      await relay.close();
      relay = createCloudRelay({
        accounts,
        sessions: new RelaySessions(randomBytes(32)),
        hostnameProof: extra,
        allowLoopbackEnrollment: true,
        recoveryPolicy: policy,
      });
      relay.server.listen(port, "127.0.0.1");
      await once(relay.server, "listening");
    },
    async close() {
      await relay.close();
      accounts.close();
    },
  };
}

test("a Google-free relay registers both key proofs, stores only public metadata and writes private local credentials", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>(async (url, init) => fetch(url, init));
  try {
    const session = await registerGatewayKey({ ...f.options, fetch: transport });
    if (process.platform !== "win32") {
      expect((await stat(f.options.sessionFile)).mode & 0o777).toBe(0o600);
    }
    const ownerFile = `${f.options.sessionFile}.owner-key`;
    if (process.platform !== "win32") {
      expect((await stat(ownerFile)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(await readFile(f.options.sessionFile, "utf8"))).toMatchObject({
      authentication: "gateway-key-v2",
      accountId: session.accountId,
    });
    const binding = f.accounts.gatewayBinding(session.accountId)!;
    expect(binding.identityToken.startsWith(KEY_BINDING_PREFIX)).toBe(true);
    expect(binding.publicOrigin).toBe(f.options.publicOrigin);
    const bodies = transport.mock.calls.map((call) => call[1]?.body).join("\n");
    expect(bodies).not.toContain("PRIVATE KEY");
    expect(bodies).not.toContain(await readFile(f.options.privateKeyFile, "utf8"));
    expect(bodies).not.toContain(await readFile(ownerFile, "utf8"));
    expect(
      (
        await fetch(`${f.options.relayUrl}/_relay/v1/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    const directory = await fetch(`${f.options.relayUrl}/_relay/v2/gateway`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(await directory.json()).toEqual(binding);
    expect(directory.headers.get("cache-control")).toBe("no-store");
  } finally {
    await f.close();
  }
});

test("local full-chain and CRLF files publish only the canonical public leaf", async () => {
  const f = await fixture();
  try {
    const leaf = (await readFile(f.options.certificateFile, "utf8")).replace(/\r?\n/g, "\r\n");
    const fullChain = leaf + leaf;
    await writeFile(f.options.certificateFile, fullChain);
    const session = await registerGatewayKey(f.options);
    expect(f.accounts.gatewayBinding(session.accountId)!.certificate).toBe(
      new X509Certificate(leaf).toString(),
    );
    expect(await readFile(f.options.certificateFile, "utf8")).toBe(fullChain);
  } finally {
    await f.close();
  }
});

test("owner-key creation is exclusive under concurrency and a lost persisted identity is never replaced", async () => {
  const path = join(directory, "identity", "owner.pem");
  const identities = await Promise.all(
    Array.from({ length: 6 }, () => readOrCreateGatewayOwnerKey(path)),
  );
  expect(
    new Set(
      identities.map((key) =>
        createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
      ),
    ).size,
  ).toBe(1);
  expect(await readdir(join(directory, "identity"))).toEqual(["owner.pem"]);
  const f = await fixture();
  try {
    await registerGatewayKey(f.options);
    const ownerFile = `${f.options.sessionFile}.owner-key`;
    await rm(ownerFile);
    await expect(registerGatewayKey(f.options)).rejects.toThrow("restore the original key");
    await expect(stat(ownerFile)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(f.options.sessionFile, "invalid JSON");
    await expect(registerGatewayKey(f.options)).rejects.toThrow("Invalid private credential file");
  } finally {
    await f.close();
  }
});

test("single-flight key sessions refresh independently of Google and preserve accounts through TLS key rotation", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>(async (url, init) => fetch(url, init));
  try {
    const source = gatewayKeySessionSource({ ...f.options, fetch: transport });
    const tokens = await Promise.all([source(), source(), source()]);
    expect(new Set(tokens).size).toBe(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await source()).toBe(tokens[0]);
    expect(transport).toHaveBeenCalledTimes(2);
    const first = JSON.parse(await readFile(f.options.sessionFile, "utf8"));
    const owner = await readFile(`${f.options.sessionFile}.owner-key`, "utf8");
    tlsFiles(directory, "gateway.example.test");
    await source();
    expect(transport).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await readFile(f.options.sessionFile, "utf8")).accountId).toBe(
      first.accountId,
    );
    expect(await readFile(`${f.options.sessionFile}.owner-key`, "utf8")).toBe(owner);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_700_000 });
    await source();
    expect(transport).toHaveBeenCalledTimes(6);
  } finally {
    await f.close();
  }
});

test("mismatched TLS files, unsupported owner keys and oversized inputs fail without leaking private bytes", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>();
  try {
    const alternate = join(directory, "other");
    await mkdir(alternate);
    const other = tlsFiles(alternate, "gateway.example.test");
    await expect(
      registerGatewayKey({ ...f.options, privateKeyFile: other.keyFile, fetch: transport }),
    ).rejects.toThrow("do not match");
    expect(transport).not.toHaveBeenCalled();
    const ownerPath = `${f.options.sessionFile}.owner-key`;
    await writeFile(ownerPath, await readFile(f.options.privateKeyFile));
    await expect(registerGatewayKey(f.options)).rejects.toThrow("Ed25519 private key");
    await writeFile(ownerPath, "x".repeat(65_537));
    if (process.platform === "win32")
      await expect(registerGatewayKey(f.options)).rejects.toMatchObject({ code: "EPRIVATE" });
    else await expect(registerGatewayKey(f.options)).rejects.toThrow("too large");
    await rm(ownerPath);
    await writeFile(f.options.certificateFile, "x".repeat(65_537));
    await expect(registerGatewayKey(f.options)).rejects.toThrow("too large");
    const failed = join(directory, "publication-error");
    if (process.platform === "win32")
      vi.spyOn(core, "writeWindowsPrivateFileAtomicStream").mockRejectedValueOnce(
        new Error("Synthetic publication failure"),
      );
    else vi.mocked(files.link).mockRejectedValueOnce(new Error("Synthetic publication failure"));
    await expect(readOrCreateGatewayOwnerKey(failed)).rejects.toThrow(
      "Synthetic publication failure",
    );
    expect((await readdir(directory)).some((name) => name.startsWith("publication-error"))).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test("a malicious relay cannot change challenge recipients, extend expiry or substitute the returned account", async () => {
  const f = await fixture();
  try {
    const realFetch = fetch;
    for (const alteration of ["recipient", "expired", "future", "account", "error", "malformed"]) {
      const transport = vi.fn<typeof fetch>(async (url, init) => {
        if (alteration === "error") return new Response(null, { status: 403 });
        if (alteration === "malformed") return Response.json({});
        const response = await realFetch(url, init);
        const value = await response.json();
        if (String(url).endsWith("/challenge")) {
          if (alteration === "recipient") value.relayOrigin = "https://another-relay.example.test";
          if (alteration === "expired") value.expiresAt = Date.now() - CLOCK_SKEW_MS - 1;
          if (alteration === "future") value.expiresAt = Date.now() + CLOCK_SKEW_MS + 61_000;
        } else if (alteration === "account") value.accountId = "a".repeat(64);
        return Response.json(value);
      });
      await expect(registerGatewayKey({ ...f.options, fetch: transport })).rejects.toThrow();
      if (["recipient", "expired", "future"].includes(alteration))
        expect(transport).toHaveBeenCalledTimes(1);
    }
  } finally {
    await f.close();
  }
});

test("key enrollment enforces routing hostname proof and rejects malformed public HTTP requests", async () => {
  const f = await fixture(async () => false);
  try {
    await expect(registerGatewayKey(f.options)).rejects.toThrow("refused");
    const post = (path: string, body: string, contentType = "application/json") =>
      fetch(f.options.relayUrl + path, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    for (const path of ["/_relay/v2/key/challenge", "/_relay/v2/key/complete"]) {
      expect((await fetch(f.options.relayUrl + path)).status).toBe(405);
      expect((await post(path, "{}", "text/plain")).status).toBe(415);
      expect((await post(path, "bad JSON")).status).toBe(400);
      expect((await post(path, "x".repeat(40_001))).status).toBe(413);
      expect((await post(path, "{}")).status).toBe(400);
    }
    const rejected = await post(
      "/_relay/v2/key/complete",
      JSON.stringify({
        challengeId: randomUUID(),
        ownerSignature: "invalid",
        tlsSignature: "invalid",
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).toBe("");
  } finally {
    await f.close();
  }
});

test("a malformed enrollment credential file fails locally instead of silently omitting operator admission", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>();
  const invitation = join(directory, "bad-invite.json");
  await writeFile(invitation, JSON.stringify({ enrollmentToken: 42 }));
  try {
    await expect(
      registerGatewayKey({ ...f.options, enrollmentTokenFile: invitation, fetch: transport }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("offline owner preparation returns canonical public DNS details and shares the enrolled-key loss barrier", async () => {
  const gatewayId = randomUUID(),
    sessionFile = join(directory, "prepared-session");
  const bare = await prepareGatewayOwner({ gatewayId: gatewayId.toUpperCase(), sessionFile });
  expect(bare).toEqual({ gatewayId, accountId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const origin = await prepareGatewayOwner({
    gatewayId,
    sessionFile,
    publicOrigin: "https://Gateway.Example.Test:443/",
  });
  expect(origin).toEqual({
    ...bare,
    publicOrigin: "https://gateway.example.test",
    dns: {
      name: "_omnesis-gateway.gateway.example.test",
      value: `omnesis-relay-v2:${bare.accountId}:${gatewayId}`,
    },
  });
  const privateKey = await readFile(`${sessionFile}.owner-key`, "utf8");
  expect(JSON.stringify(origin)).not.toContain(privateKey);
  expect(JSON.stringify(origin)).not.toContain("PRIVATE KEY");
  await expect(
    prepareGatewayOwner({ gatewayId, sessionFile, publicOrigin: "http://gateway.example.test" }),
  ).rejects.toThrow();
  await writeFile(sessionFile, JSON.stringify({ authentication: "gateway-key-v2" }));
  await rm(`${sessionFile}.owner-key`);
  await expect(prepareGatewayOwner({ gatewayId, sessionFile })).rejects.toThrow(
    "restore the original key",
  );
  await expect(stat(`${sessionFile}.owner-key`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a certificate/key changed during delayed enrollment is re-registered before persisting a session, with at most one retry", async () => {
  const f = await fixture();
  let completions = 0;
  let rotatedCertificate = "";
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith("/complete") && ++completions === 1) {
      const rotated = tlsFiles(directory, "gateway.example.test");
      const certificate = await readFile(rotated.certFile, "utf8");
      rotatedCertificate = certificate.replace(/\r?\n/g, "\r\n");
      await writeFile(rotated.certFile, rotatedCertificate);
    }
    return response;
  });
  try {
    const session = await registerGatewayKey({ ...f.options, fetch: transport });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(rotatedCertificate).toContain("\r\n");
    expect(f.accounts.gatewayBinding(session.accountId)!.certificate).toBe(
      new X509Certificate(rotatedCertificate).toString(),
    );
    expect(await readFile(f.options.certificateFile, "utf8")).toBe(rotatedCertificate);
    const original = await readFile(f.options.sessionFile, "utf8");
    const continuous = vi.fn<typeof fetch>(async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/complete")) tlsFiles(directory, "gateway.example.test");
      return response;
    });
    await expect(registerGatewayKey({ ...f.options, fetch: continuous })).rejects.toThrow(
      "changed repeatedly",
    );
    expect(continuous).toHaveBeenCalledTimes(4);
    expect(await readFile(f.options.sessionFile, "utf8")).toBe(original);
  } finally {
    await f.close();
  }
});

test("caller cancellation prevents further proof requests and credential persistence, including session-source refresh", async () => {
  const f = await fixture();
  try {
    for (const endpoint of ["/challenge", "/complete"]) {
      const abort = new AbortController();
      const transport = vi.fn<typeof fetch>(async (url, init) => {
        const response = await fetch(url, init);
        if (String(url).endsWith(endpoint)) abort.abort(new Error("pairing cancelled"));
        return response;
      });
      await expect(
        registerGatewayKey({ ...f.options, fetch: transport, signal: abort.signal }),
      ).rejects.toThrow("cancelled");
      expect(transport).toHaveBeenCalledTimes(endpoint === "/challenge" ? 1 : 2);
      await expect(stat(f.options.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const abort = new AbortController();
    abort.abort(new Error("refresh cancelled"));
    const transport = vi.fn<typeof fetch>();
    const source = gatewayKeySessionSource({ ...f.options, fetch: transport });
    await expect(source(abort.signal)).rejects.toThrow("cancelled");
    const bounded = gatewayKeySessionSource({
      ...f.options,
      fetch: transport,
      signal: abort.signal,
    });
    await expect(bounded(new AbortController().signal)).rejects.toThrow("cancelled");
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("key-source invalidation forces a fresh dual-key exchange and carries recovery receipts on already-enrolled registrations", async () => {
  const f = await fixture();
  const { createRecoveryAuthority, signRecoveryReceipt } = await import("./recovery-authority.js");
  const { prepareGatewayRecoveryRequest } = await import("./gateway-key-client.js");
  const authority = createRecoveryAuthority();
  try {
    await prepareGatewayOwner(f.options);
    const draft = await prepareGatewayRecoveryRequest(f.options);
    const { signRecoveryPolicy } = await import("./recovery-authority.js");
    const { recoveryPolicyDigest } = await import("./recovery-contract.js");
    const { loadTrustedRecoveryPolicy } = await import("./recovery-verifier.js");
    const policy = signRecoveryPolicy(
      {
        protocol: "omnesis-relay-recovery-policy",
        version: 1,
        keyId: "independent",
        relayOrigin: f.options.relayUrl,
        relayDomain: "relay.example.test",
        epoch: 1,
        minimumReceiptEpoch: 1,
        minimumReceiptVersion: 1,
        issuedAt: Math.floor(Date.now() / 1000) - 10,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        revokedGatewayIds: [],
        revokedOwnerSpkiFingerprints: [],
      },
      authority.privateKey,
    );
    await f.recovery(
      loadTrustedRecoveryPolicy(policy, {
        publicKey: authority.publicKey,
        keyId: "independent",
        relayOrigin: f.options.relayUrl,
        relayDomain: "relay.example.test",
        policySha256: recoveryPolicyDigest(policy),
        minimumPolicyEpoch: 1,
      }),
    );
    const receipt = signRecoveryReceipt(
      {
        ...draft,
        keyId: "independent",
        relayDomain: "relay.example.test",
        recoveryEpoch: 1,
        issuedAt: Math.floor(Date.now() / 1000) - 10,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      authority.privateKey,
    );
    await writeFile(`${f.options.sessionFile}.recovery.json`, JSON.stringify(receipt));
    const transport = vi.fn<typeof fetch>(async (url, init) => fetch(url, init));
    const source = gatewayKeySessionSource({ ...f.options, fetch: transport });
    await source();
    await source();
    expect(transport).toHaveBeenCalledTimes(2);
    source.invalidate();
    await source();
    expect(transport).toHaveBeenCalledTimes(4);
    const proofs = transport.mock.calls.filter((call) => String(call[0]).endsWith("/complete"));
    expect(proofs.map((call) => JSON.parse(String(call[1]!.body)).recoveryReceipt)).toEqual([
      receipt,
      receipt,
    ]);
    await writeFile(`${f.options.sessionFile}.recovery.json`, "{}");
    source.invalidate();
    await expect(source()).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(4);
    const saved = await readFile(f.options.sessionFile, "utf8");
    await writeFile(
      `${f.options.sessionFile}.recovery.json`,
      JSON.stringify({ ...receipt, signature: Buffer.alloc(64).toString("base64url") }),
    );
    await expect(source()).rejects.toThrow("registration refused");
    expect(await readFile(f.options.sessionFile, "utf8")).toBe(saved);
    const revoked = signRecoveryPolicy(
      {
        ...policy.payload,
        epoch: 2,
        revokedOwnerSpkiFingerprints: [receipt.payload.ownerSpkiFingerprint],
      },
      authority.privateKey,
    );
    await f.recovery(
      loadTrustedRecoveryPolicy(revoked, {
        publicKey: authority.publicKey,
        keyId: "independent",
        relayOrigin: f.options.relayUrl,
        relayDomain: "relay.example.test",
        policySha256: recoveryPolicyDigest(revoked),
        minimumPolicyEpoch: 2,
      }),
    );
    await writeFile(`${f.options.sessionFile}.recovery.json`, JSON.stringify(receipt));
    await expect(source()).rejects.toThrow("registration refused");
    expect(await readFile(f.options.sessionFile, "utf8")).toBe(saved);
    await rm(`${f.options.sessionFile}.owner-key`);
    await rm(f.options.sessionFile);
    await expect(registerGatewayKey(f.options)).rejects.toThrow("owner identity key is missing");
    await expect(readFile(`${f.options.sessionFile}.owner-key`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.close();
  }
});

test("a cancelled invalidated generation cannot overwrite replacement routing credentials or clear its pending exchange", async () => {
  const f = await fixture();
  let enterOld!: () => void, enterNew!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    enterOld = resolve;
  });
  const newStarted = new Promise<void>((resolve) => {
    enterNew = resolve;
  });
  let finishOld!: (response: Response) => void, finishNew!: (response: Response) => void;
  const oldReply = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const newReply = new Promise<Response>((resolve) => {
    finishNew = resolve;
  });
  let oldResponse!: Response,
    newResponse!: Response,
    completed = 0;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith("/complete")) return response;
    completed++;
    if (completed === 1) {
      oldResponse = response;
      enterOld();
      return oldReply;
    }
    newResponse = response;
    enterNew();
    return newReply;
  });
  try {
    const source = gatewayKeySessionSource({ ...f.options, fetch: transport });
    const old = source();
    const rejected = expect(old).rejects.toThrow("invalidated");
    await oldStarted;
    source.invalidate();
    const replacement = source();
    await newStarted;
    finishOld(oldResponse);
    await rejected;
    expect(source()).toBe(replacement);
    finishNew(newResponse);
    await replacement;
    const bytes = await readFile(f.options.sessionFile, "utf8");
    expect(await source()).toBe(JSON.parse(bytes).token);
    expect(transport).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});

test("a real tunnel recovers a relay restart with a rotated HMAC by reproving stable keys instead of retrying the cached session", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const f = await fixture();
  const transport = vi.fn<typeof fetch>((url, init) => fetch(url, init));
  const source = gatewayKeySessionSource({ ...f.options, fetch: transport });
  const invalidate = vi.fn(() => source.invalidate());
  const tunnel = new GatewayTunnel({
    relayUrl: f.options.relayUrl,
    gatewayUrl: "https://localhost:1",
    gatewayId: f.options.gatewayId,
    session: source,
    invalidateSession: invalidate,
    reconnectMs: 20,
  });
  try {
    tunnel.start();
    await until(() => tunnel.status().state === "online");
    const tls = await readFile(f.options.privateKeyFile, "utf8"),
      owner = await readFile(`${f.options.sessionFile}.owner-key`, "utf8");
    expect(transport).toHaveBeenCalledTimes(2);
    await f.rotate();
    await until(() => invalidate.mock.calls.length === 1 && tunnel.status().state === "online");
    expect(transport).toHaveBeenCalledTimes(4);
    expect(await readFile(f.options.privateKeyFile, "utf8")).toBe(tls);
    expect(await readFile(`${f.options.sessionFile}.owner-key`, "utf8")).toBe(owner);
    const session = JSON.parse(await readFile(f.options.sessionFile, "utf8"));
    expect(f.accounts.gatewayBinding(session.accountId)!.gatewayId).toBe(f.options.gatewayId);
  } finally {
    tunnel.stop();
    await f.close();
  }
});

test("caller cancellation releases a pending key exchange immediately while its late finally cannot clear a newer one", async () => {
  const f = await fixture();
  let entered!: () => void, finished!: (response: Response) => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = new Promise<Response>((resolve) => {
    finished = resolve;
  });
  let first!: Response,
    pending = true;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith("/complete") && pending) {
      pending = false;
      first = response;
      entered();
      return delayed;
    }
    return response;
  });
  try {
    const source = gatewayKeySessionSource({ ...f.options, fetch: transport });
    const abort = new AbortController();
    const old = source(abort.signal),
      rejected = expect(old).rejects.toThrow("caller cancelled");
    await began;
    abort.abort(new Error("caller cancelled"));
    const replacement = source();
    finished(first);
    await rejected;
    await replacement;
    expect(await source()).toBe(JSON.parse(await readFile(f.options.sessionFile, "utf8")).token);
  } finally {
    await f.close();
  }
});

test("optional missing enrollment artifacts stay optional and supplied invitations accompany proof without leaking owner secrets", async () => {
  const f = await fixture();
  const tokenFile = join(directory, "invitation.json");
  const transport = vi.fn<typeof fetch>((url, init) => fetch(url, init));
  try {
    await registerGatewayKey({ ...f.options, enrollmentTokenFile: tokenFile, fetch: transport });
    await rm(f.options.sessionFile);
    await writeFile(
      tokenFile,
      JSON.stringify({ enrollmentToken: "development-fixture-invitation" }),
    );
    await registerGatewayKey({ ...f.options, enrollmentTokenFile: tokenFile, fetch: transport });
    expect(JSON.parse(String(transport.mock.calls.at(-1)![1]!.body)).enrollmentToken).toBe(
      "development-fixture-invitation",
    );
  } finally {
    await f.close();
  }
});

test("Windows owner creation uses bounded private reads and atomic create-only publication", async () => {
  const path = join(directory, "owned-winner.pem");
  const winner = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const read = vi
    .spyOn(core, "readWindowsPrivateFile")
    .mockRejectedValueOnce(Object.assign(new Error("Invented absent owner"), { code: "ENOENT" }))
    .mockResolvedValueOnce(Buffer.from(winner));
  const publish = vi
    .spyOn(core, "writeWindowsPrivateFileAtomicStream")
    .mockImplementationOnce(async (target, source, length, options) => {
      expect(target).toBe(path);
      expect(options).toMatchObject({ replaceExisting: false, timeoutMs: 30_000 });
      const chunks: Buffer[] = [];
      for await (const chunk of source as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toHaveLength(length);
      await writeFile(path, winner, { mode: 0o600 });
      throw Object.assign(new Error("Invented concurrent winner"), { code: "EEXIST" });
    });
  vi.mocked(files.link).mockClear();
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const selected = await readOrCreateGatewayOwnerKey(path);
    expect(createPublicKey(selected).export({ type: "spki", format: "pem" })).toBe(
      createPublicKey(winner).export({ type: "spki", format: "pem" }),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(path, 65_536);
    expect(publish).toHaveBeenCalledOnce();
    expect(files.link).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(winner);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test.each(["EACCES", "EIO"])(
  "uncertain recovery artifact metadata %s cannot mint or register another owner",
  async (code) => {
    const f = await fixture();
    const failure = Object.assign(new Error("Invented receipt metadata failure"), { code });
    const transport = vi.fn<typeof fetch>();
    try {
      if (process.platform === "win32")
        vi.spyOn(core, "readWindowsRegularFilePrefix").mockRejectedValueOnce(failure);
      else vi.spyOn(files, "lstat").mockRejectedValueOnce(failure);
      await expect(registerGatewayKey({ ...f.options, fetch: transport })).rejects.toBe(failure);
      expect(transport).not.toHaveBeenCalled();
      await expect(stat(`${f.options.sessionFile}.owner-key`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(f.options.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.close();
    }
  },
);

test("a recovery artifact below a non-directory ancestor refuses registration without minting a key", async () => {
  const f = await fixture();
  const obstruction = join(directory, "owned-receipt-obstruction");
  const transport = vi.fn<typeof fetch>();
  try {
    await writeFile(obstruction, "invented receipt path obstruction");
    await expect(
      registerGatewayKey({
        ...f.options,
        recoveryReceiptFile: join(obstruction, "receipt.json"),
        fetch: transport,
      }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await expect(stat(`${f.options.sessionFile}.owner-key`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(obstruction, "utf8")).toBe("invented receipt path obstruction");
  } finally {
    await f.close();
  }
});

test("an existing recovery artifact blocks new owner creation without parsing its bytes", async () => {
  const sessionFile = join(directory, "artifact-session");
  const ownerPath = `${sessionFile}.owner-key`;
  const receipt = `${sessionFile}.recovery.json`;
  await readOrCreateGatewayOwnerKey(ownerPath);
  const original = await readFile(ownerPath, "utf8");
  await writeFile(receipt, "invented non-JSON receipt bytes");
  const gatewayId = randomUUID();
  expect(await prepareGatewayOwner({ sessionFile, gatewayId })).toMatchObject({ gatewayId });
  expect(await readFile(ownerPath, "utf8")).toBe(original);
  expect(await readFile(receipt, "utf8")).toBe("invented non-JSON receipt bytes");
  await rm(ownerPath);
  await expect(prepareGatewayOwner({ sessionFile, gatewayId })).rejects.toThrow(
    "restore the original key",
  );
  await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform !== "win32")(
  "Windows atomic owner publication preserves a winner that appears after the missing read",
  async () => {
    const path = join(directory, "winner", "owner.pem");
    await core.ensurePrivateDirs([dirname(path)]);
    const winner = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    vi.spyOn(core, "readWindowsPrivateFile").mockImplementationOnce(async () => {
      await core.createWindowsPrivateFile(path, Buffer.from(winner));
      throw Object.assign(new Error("Invented stale missing result"), { code: "ENOENT" });
    });
    const selected = await readOrCreateGatewayOwnerKey(path);
    expect(createPublicKey(selected).export({ type: "spki", format: "pem" })).toBe(
      createPublicKey(winner).export({ type: "spki", format: "pem" }),
    );
    expect(await readFile(path, "utf8")).toBe(winner);
    expect(await readdir(dirname(path))).toEqual(["owner.pem"]);
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows enrollment accepts a public certificate but refuses an unsafe private TLS key",
  async () => {
    const f = await fixture();
    const acl = (path: string) =>
      core.execWindowsJob(join(process.env.SystemRoot!, "System32", "icacls.exe"), [
        path,
        "/grant",
        "*S-1-1-0:(R)",
        "/Q",
      ]);
    try {
      await acl(f.options.certificateFile);
      expect(core.inspectWindowsPrivatePathSync(f.options.certificateFile, "file").private).toBe(
        false,
      );
      const session = await registerGatewayKey(f.options);
      expect(f.accounts.gatewayBinding(session.accountId)).toBeDefined();
      const saved = await readFile(f.options.sessionFile, "utf8");
      const key = await readFile(f.options.privateKeyFile, "utf8");
      await acl(f.options.privateKeyFile);
      const transport = vi.fn<typeof fetch>();
      await expect(registerGatewayKey({ ...f.options, fetch: transport })).rejects.toMatchObject({
        code: "EPRIVATE",
      });
      expect(transport).not.toHaveBeenCalled();
      expect(await readFile(f.options.sessionFile, "utf8")).toBe(saved);
      expect(await readFile(f.options.privateKeyFile, "utf8")).toBe(key);
    } finally {
      try {
        const restored = await core.inspectWindowsPrivatePaths(
          [
            { path: f.options.certificateFile, kind: "file" },
            { path: f.options.privateKeyFile, kind: "file" },
          ],
          { repair: true, protect: true },
        );
        expect(restored.every((entry) => entry.private)).toBe(true);
      } finally {
        await f.close();
      }
    }
  },
);

test("an unsafe or dangling recovery artifact cannot authorize a new owner", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>();
  try {
    let recoveryReceiptFile: string;
    if (process.platform === "win32") {
      const target = join(directory, "owned-empty-receipt-target");
      const alias = join(directory, "owned-receipt-junction");
      await mkdir(target);
      await symlink(target, alias, "junction");
      recoveryReceiptFile = join(alias, "missing-receipt.json");
    } else {
      recoveryReceiptFile = `${f.options.sessionFile}.recovery.json`;
      await symlink(join(directory, "missing-receipt-target"), recoveryReceiptFile);
    }
    await expect(
      registerGatewayKey({ ...f.options, recoveryReceiptFile, fetch: transport }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    await expect(stat(`${f.options.sessionFile}.owner-key`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(f.options.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});
