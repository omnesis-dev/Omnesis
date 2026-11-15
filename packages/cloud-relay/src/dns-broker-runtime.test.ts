// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:net";
import { request } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { tlsFiles } from "../test/support.js";
import { brokerCall, brokerOwner } from "../test/dns-broker-owner.js";
import { fakeCloudflare, serveFakeCloudflare } from "../test/fake-cloudflare.js";
import { assertRelayDnsIsolation, startIndependentDnsDaemon } from "./dns-broker-runtime.js";
import { runRelayCommand, startRelayDaemon } from "./runtime.js";
import { signRecoveryPolicy } from "./recovery-authority.js";
import { recoveryPolicyDigest } from "./recovery-contract.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import type { AddressInfo } from "node:net";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-independent-dns-runtime-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function environment() {
  const f = await recoveryFixture(directory);
  const { version, keyId, relayOrigin, relayDomain, issuedAt, expiresAt } = f.receipt().payload;
  const policy = signRecoveryPolicy(
    {
      version,
      keyId,
      relayOrigin,
      relayDomain,
      issuedAt,
      expiresAt,
      protocol: "omnesis-relay-recovery-policy",
      epoch: 4,
      minimumReceiptEpoch: 2,
      minimumReceiptVersion: 1,
      revokedGatewayIds: [],
      revokedOwnerSpkiFingerprints: [],
    },
    f.authority.privateKey,
  );
  const publicFile = join(directory, "authority.pub"),
    policyFile = join(directory, "policy.json"),
    tokenFile = join(directory, "dns-token.json");
  await writeFile(publicFile, f.authority.publicKey);
  await writeFile(policyFile, JSON.stringify(policy));
  await writeFile(tokenFile, JSON.stringify({ token: "fixture-dns-edit-token" }));
  return {
    OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test",
    OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT: "0",
    OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE: publicFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE: policyFile,
    OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_SHA256: recoveryPolicyDigest(policy),
    OMNESIS_CLOUD_RELAY_RECOVERY_MIN_POLICY_EPOCH: "4",
    OMNESIS_CLOUD_RELAY_RECOVERY_KEY_ID: keyId,
    OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: relayOrigin,
    OMNESIS_CLOUD_RELAY_DOMAIN: relayDomain,
    OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: "a".repeat(32),
    OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: "example.test",
    OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: tokenFile,
    OMNESIS_CLOUD_RELAY_ACME_JOURNAL: join(directory, "dns-journal.json"),
    OMNESIS_CLOUD_RELAY_DNS_BROKER_REGISTRY: join(directory, "dns-registry.json"),
  };
}

test("independent DNS daemon needs no relay database or HMAC and closes its owned listener", async () => {
  const env = await environment();
  const daemon = await runRelayCommand("serve-dns-broker", env);
  if (!daemon) throw new Error("Expected an independent DNS listener");
  try {
    const response = await fetch(daemon.url);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("fixture-dns-edit-token");
    // Version 1 (receipts) and version 2 (registry) side by side.
    expect((await fetch(`${daemon.url}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${daemon.url}/_dns/v2/health`)).json()).toMatchObject({
      protocol: "omnesis-dns-broker-v2",
    });
  } finally {
    await daemon.close();
  }
  await daemon.close();
});

test("the exposed relay refuses DNS secrets in independent mode before reading keys or opening SQLite", async () => {
  expect(() => assertRelayDnsIsolation({})).not.toThrow();
  expect(() => assertRelayDnsIsolation({ OMNESIS_ACME_DNS_PROVIDER: "independent" })).not.toThrow();
  expect(() =>
    assertRelayDnsIsolation({ OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: "inline-zone" }),
  ).not.toThrow();
  const env = await environment(),
    database = join(directory, "must-not-open.sqlite");
  await expect(
    startRelayDaemon({
      ...env,
      OMNESIS_CLOUD_RELAY_DB: database,
      OMNESIS_CLOUD_RELAY_KEY_FILE: "unread-session.key",
    }),
  ).rejects.toThrow("removing DNS credentials");
  await expect(stat(database)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() =>
    assertRelayDnsIsolation({
      OMNESIS_ACME_DNS_PROVIDER: "independent",
      OMNESIS_CLOUD_RELAY_ACME_JOURNAL: "isolated-only.json",
    }),
  ).toThrow("removing DNS credentials");
});

test("public listeners require TLS and independent current trust before reading DNS credentials", async () => {
  const env = await environment();
  await expect(
    startIndependentDnsDaemon({
      ...env,
      OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE: "unread.pem",
    }),
  ).rejects.toThrow("certificate and key");
  await expect(
    startIndependentDnsDaemon({ ...env, OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND: "0.0.0.0" }),
  ).rejects.toThrow("require TLS");
  await expect(
    startIndependentDnsDaemon({ ...env, OMNESIS_CLOUD_RELAY_ACME_JOURNAL: undefined }),
  ).rejects.toThrow("challenge journal");
});

test("without a recovery policy the daemon serves the name registry only", async () => {
  const env = await environment();
  const registryOnly: NodeJS.ProcessEnv = { ...env, OMNESIS_CLOUD_RELAY_ACME_JOURNAL: undefined };
  for (const name of Object.keys(registryOnly))
    if (name.includes("RECOVERY_")) delete registryOnly[name];
  const daemon = await startIndependentDnsDaemon(registryOnly);
  try {
    expect((await fetch(`${daemon.url}/healthz`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/_dns/v1/challenge`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${daemon.url}/_dns/v2/health`)).status).toBe(200);
  } finally {
    await daemon.close();
  }
});

test("a gateway claims and leases through the daemon against a loopback DNS API", async () => {
  const cloudflare = fakeCloudflare();
  const api = await serveFakeCloudflare(cloudflare);
  const env = await environment();
  const importToken = join(directory, "import-token.json");
  await writeFile(importToken, JSON.stringify({ token: "i".repeat(40) }));
  const daemon = await startIndependentDnsDaemon({
    ...env,
    OMNESIS_ACME_DNS_BROKER_URL: "http://127.0.0.1:8789",
    OMNESIS_CLOUD_RELAY_DNS_BROKER_FIXTURE_DNS_API_URL: api.url,
    OMNESIS_CLOUD_RELAY_DNS_BROKER_IMPORT_TOKEN_FILE: importToken,
    OMNESIS_CLOUD_RELAY_DNS_BROKER_CAA_ACCOUNT_URI_PREFIX: "https://ca.example.test/acct/",
  });
  try {
    const owner = brokerOwner(env.OMNESIS_CLOUD_RELAY_DOMAIN);
    const handle = (request: Request) =>
      fetch(new URL(new URL(request.url).pathname, daemon.url), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        duplex: "half",
      } as RequestInit);
    expect(await brokerCall(handle, owner, { type: "claim" }, "http://127.0.0.1:8789")).toEqual({
      status: 200,
      body: { claimed: true },
    });
    expect(
      (
        await brokerCall(
          handle,
          owner,
          { type: "txt-create", value: "a".repeat(43) },
          "http://127.0.0.1:8789",
        )
      ).status,
    ).toBe(200);
    expect(cloudflare.records).toMatchObject([
      { type: "TXT", name: `_acme-challenge.${owner.hostname}` },
    ]);
    expect(await (await fetch(`${daemon.url}/_dns/v2/health`)).json()).toMatchObject({
      caa: { accountUriPrefix: "https://ca.example.test/acct/" },
    });
  } finally {
    await daemon.close();
  }
  // A restart keeps a lease that hasn't expired yet.
  const again = await startIndependentDnsDaemon({
    ...env,
    OMNESIS_CLOUD_RELAY_DNS_BROKER_FIXTURE_DNS_API_URL: api.url,
  });
  await again.close();
  expect(cloudflare.records).toMatchObject([{ type: "TXT" }]);
  await api.close();
});

test.each([false, true])(
  "construction and occupied-port failures drain DNS resources and preserve the original failure (cleanup fails: %s)",
  async (cleanupFails) => {
    const env = await environment(),
      originalClose = AcmeDnsChallenges.prototype.close,
      closed = vi.spyOn(AcmeDnsChallenges.prototype, "close").mockImplementation(async function (
        this: AcmeDnsChallenges,
      ) {
        await originalClose.call(this);
        if (cleanupFails) throw new Error("Synthetic DNS cleanup failure");
      });
    await expect(
      startIndependentDnsDaemon({
        ...env,
        OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test/path",
      }),
    ).rejects.toThrow("origin");
    expect(closed).toHaveBeenCalledTimes(0);
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    try {
      await expect(
        startIndependentDnsDaemon({
          ...env,
          OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT: String((occupied.address() as AddressInfo).port),
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  },
);

test("IPv6 loopback and a TLS listener use only their own isolated network endpoints", async () => {
  const env = await environment();
  const ipv6 = await startIndependentDnsDaemon({
    ...env,
    OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND: "::1",
  });
  try {
    expect(ipv6.url).toMatch(/^http:\/\/\[::1\]:/);
  } finally {
    await ipv6.close();
  }
  const tls = tlsFiles(directory, "localhost"),
    ca = await readFile(tls.certFile, "utf8");
  const secure = await startIndependentDnsDaemon({
    ...env,
    OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE: tls.certFile,
    OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_KEY_FILE: tls.keyFile,
  });
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(secure.url, { ca, servername: "localhost" }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      call.once("error", reject);
      call.end();
    });
    expect(status).toBe(404);
  } finally {
    await secure.close();
  }
});
