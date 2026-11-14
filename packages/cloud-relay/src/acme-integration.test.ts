// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { expiredCertificate } from "../test/expired-certificate.js";
import { tlsFiles } from "../test/support.js";
import { brokerHarness } from "../test/dns-broker-owner.js";
import { acmeTrustedRoots, createGatewayAcmeController } from "./acme-integration.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import type { AcmeDnsChallenges as AcmeDnsService } from "./acme-dns.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-integration-"));
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function environment() {
  const tls = tlsFiles(directory),
    tokenFile = join(directory, "dns-token.json");
  await writeFile(tokenFile, JSON.stringify({ token: "fixture-dns-token" }));
  return {
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_TERMS_ACCEPTED: "1",
    OMNESIS_ACME_CERT_FILE: join(directory, "public.crt"),
    OMNESIS_TLS_CERT: tls.certFile,
    OMNESIS_TLS_KEY: tls.keyFile,
    OMNESIS_PUBLIC_BASE_URL: "https://owned.test",
    OMNESIS_CLOUD_RELAY_ENABLED: process.env.OMNESIS_CLOUD_RELAY_ENABLED,
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
    OMNESIS_ACME_DNS_PROVIDER: "cloudflare",
    OMNESIS_ACME_DNS_ZONE_ID: "a".repeat(32),
    OMNESIS_ACME_DNS_ZONE_NAME: "owned.test",
    OMNESIS_ACME_DNS_TOKEN_FILE: tokenFile,
  };
}
test("ACME absent or experimental disabled leaves all files, certificate contexts and provider activity untouched", async () => {
  const activate = vi.fn(async () => {}),
    fetch = vi.fn<typeof globalThis.fetch>();
  const prepared = await environment();
  const before = await readdir(directory);
  expect(
    await createGatewayAcmeController({}, { configDir: directory, activate, fetch }),
  ).toBeUndefined();
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  expect(
    await createGatewayAcmeController(
      { OMNESIS_ACME_DIRECTORY_URL: "malformed", OMNESIS_ACME_TERMS_ACCEPTED: "invalid" },
      { configDir: directory, activate, fetch },
    ),
  ).toBeUndefined();
  // Without the flag, neither the official broker nor a configured one is ever asked anything.
  for (const provider of [{}, { OMNESIS_ACME_DNS_PROVIDER: "broker" }])
    expect(
      await createGatewayAcmeController(
        {
          ...prepared,
          OMNESIS_CLOUD_RELAY_ENABLED: "0",
          OMNESIS_CLOUD_RELAY_URL: "https://relay.omnesis.app",
          OMNESIS_ACME_DNS_BROKER_URL: "https://dns.example.test",
          ...provider,
        },
        { configDir: directory, activate, fetch },
      ),
    ).toBeUndefined();
  expect(await readdir(directory)).toEqual(before);
  expect(activate).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
test("explicit opt-in requires terms agreement and a public certificate path distinct from all direct material", async () => {
  const env = await environment(),
    activate = vi.fn(async () => {});
  await expect(
    createGatewayAcmeController(
      { ...env, OMNESIS_ACME_TERMS_ACCEPTED: undefined },
      { configDir: directory, activate },
    ),
  ).rejects.toThrow();
  for (const path of [env.OMNESIS_TLS_CERT, env.OMNESIS_TLS_KEY])
    await expect(
      createGatewayAcmeController(
        { ...env, OMNESIS_ACME_CERT_FILE: path },
        { configDir: directory, activate },
      ),
    ).rejects.toThrow("own path");
});
test("provider outage during abandoned-journal cleanup stays contained and later renewal retries initialization", async () => {
  const env = await environment(),
    directCertificate = await readFile(env.OMNESIS_TLS_CERT, "utf8");
  const lease = {
    id: randomUUID(),
    accountId: "a".repeat(64),
    hostname: "owned.test",
    value: "b".repeat(43),
    expiresAt: Date.now() + 60000,
  };
  await writeFile(
    `${env.OMNESIS_ACME_CERT_FILE}.acme-account.dns-journal`,
    JSON.stringify([lease]),
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error("provider-down-sensitive-token"))
    .mockResolvedValue(Response.json({ success: true, result: [] }));
  const activate = vi.fn(async () => {}),
    module = await import("./acme-gateway.js");
  vi.spyOn(module.GatewayAcmeRenewal.prototype, "renew").mockResolvedValue(false);
  const keys = await import("./gateway-key-client.js");
  vi.spyOn(keys, "registerGatewayKey").mockResolvedValue({
    token: "owner-session",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  });
  const controller = await createGatewayAcmeController(env, {
    configDir: directory,
    activate,
    fetch,
  });
  try {
    expect(controller).toBeDefined();
    expect(controller!.fingerprintSha256()).toBeUndefined();
    expect(activate).not.toHaveBeenCalled();
    expect(await readFile(env.OMNESIS_TLS_CERT, "utf8")).toBe(directCertificate);
    expect(await controller!.renew(new AbortController().signal)).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
    expect(controller!.fingerprintSha256()).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await controller!.close();
  }
});
test("missing gateway-owned DNS configuration remains a contained retryable setup failure", async () => {
  const env = await environment(),
    activate = vi.fn(async () => {});
  const controller = await createGatewayAcmeController(
    { ...env, OMNESIS_ACME_DNS_ZONE_ID: undefined },
    { configDir: directory, activate },
  );
  try {
    await expect(controller!.renew(new AbortController().signal)).rejects.toThrow(
      "private token file",
    );
    expect(activate).not.toHaveBeenCalled();
  } finally {
    await controller!.close();
  }
});

test("gateway-owned DNS publishes only its apex digest and cancellation cleans it before controller shutdown", async () => {
  const env = await environment(),
    records = new Map<string, Record<string, unknown>>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const id = "b".repeat(32);
    if (init?.method === "POST") {
      const record = { id, ...JSON.parse(String(init.body)) };
      records.set(id, record);
      return Response.json({ success: true, result: record });
    }
    if (init?.method === "DELETE") {
      records.delete(String(url).split("/").at(-1)!);
      return Response.json({ success: true, result: { id } });
    }
    return Response.json({ success: true, result: [...records.values()] });
  });
  const keys = await import("./gateway-key-client.js");
  vi.spyOn(keys, "registerGatewayKey").mockResolvedValue({
    token: "raw-owner",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  });
  let entered!: () => void;
  const published = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = await createGatewayAcmeController(
    { ...env, OMNESIS_ACME_ACCOUNT_KEY_FILE: join(directory, "custom-account") },
    {
      configDir: directory,
      fetch,
      activate: async () => {},
      issuer: async (options) => {
        const lease = await options.presenter.create("a".repeat(43), options.signal);
        entered();
        try {
          await new Promise<void>((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            }),
          );
        } finally {
          await options.presenter.remove(lease.id, AbortSignal.timeout(15000));
        }
        throw new Error("cancelled");
      },
    },
  );
  const renewal = controller!.renew(new AbortController().signal),
    rejected = expect(renewal).rejects.toThrow("cancelled");
  await published;
  expect([...records.values()][0].name).toBe("_acme-challenge.owned.test");
  await controller!.close();
  await rejected;
  expect(records.size).toBe(0);
  await expect(controller!.renew(new AbortController().signal)).rejects.toThrow();
});

test("failed initial SNI activation contains cleanup errors and rejects reusing direct private-key paths", async () => {
  const env = await environment(),
    { AcmeDnsChallenges } = await import("./acme-dns.js");
  const service = {
    close: vi.fn(async () => {
      throw new Error("cleanup-provider-secret");
    }),
  } as unknown as AcmeDnsService;
  vi.spyOn(AcmeDnsChallenges, "open").mockResolvedValue(service);
  const activate = vi.fn(async () => {
    throw new Error("initial activation failed");
  });
  const controller = await createGatewayAcmeController(env, { configDir: directory, activate });
  expect(controller!.fingerprintSha256()).toBeUndefined();
  expect(controller!.spkiFingerprintSha256()).toBeUndefined();
  await controller!.close();
  await expect(
    createGatewayAcmeController(
      { ...env, OMNESIS_ACME_KEY_FILE: env.OMNESIS_TLS_KEY },
      { configDir: directory, activate },
    ),
  ).rejects.toThrow("separate stable");
});

test("an expired public leaf recovers during a running gateway without rotating its stable public key or direct certificate", async () => {
  const env = await environment(),
    activate = vi.fn(async () => {}),
    keys = await import("./gateway-key-client.js"),
    module = await import("./acme-gateway.js");
  vi.spyOn(keys, "registerGatewayKey").mockResolvedValue({
    token: "owner",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  });
  vi.spyOn(module.GatewayAcmeRenewal.prototype, "renew").mockResolvedValue(false);
  const controller = await createGatewayAcmeController(env, { configDir: directory, activate });
  try {
    const pin = controller!.spkiFingerprintSha256(),
      key = await readFile(`${env.OMNESIS_ACME_CERT_FILE}.key`, "utf8"),
      direct = await readFile(env.OMNESIS_TLS_CERT, "utf8");
    const expired = join(directory, "expired.crt");
    expiredCertificate({
      certificateFile: env.OMNESIS_ACME_CERT_FILE,
      privateKeyFile: `${env.OMNESIS_ACME_CERT_FILE}.key`,
      outputFile: expired,
    });
    await writeFile(env.OMNESIS_ACME_CERT_FILE, await readFile(expired));
    expect(await controller!.renew(new AbortController().signal)).toBe(false);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(controller!.spkiFingerprintSha256()).toBe(pin);
    expect(await readFile(`${env.OMNESIS_ACME_CERT_FILE}.key`, "utf8")).toBe(key);
    expect(await readFile(env.OMNESIS_TLS_CERT, "utf8")).toBe(direct);
  } finally {
    await controller!.close();
  }
});

test("renewal DNS cooperation recovers its own cached routing session after a real empty relay restart and HMAC rotation", async () => {
  const [
    { recoveryFixture },
    { AcmeDnsChallenges },
    { createCloudRelay },
    { RelayAccounts },
    { RelaySessions },
    { gatewayKeySessionSource },
    { relayDnsPresenter },
    { listen },
  ] = await Promise.all([
    import("../test/recovery-fixture.js"),
    import("./acme-dns.js"),
    import("./server.js"),
    import("./accounts.js"),
    import("./identity.js"),
    import("./gateway-key-client.js"),
    import("./acme-gateway.js"),
    import("../test/support.js"),
  ]);
  const { randomBytes } = await import("node:crypto");
  const f = await recoveryFixture(directory),
    sessionFile = join(directory, "routing.json"),
    ownerKeyFile = join(directory, "owner.key"),
    receiptFile = join(directory, "receipt.json");
  await writeFile(ownerKeyFile, f.owner.privateKey, { mode: 0o600 });
  await writeFile(receiptFile, JSON.stringify(f.receipt()), { mode: 0o600 });
  let relay: ReturnType<typeof createCloudRelay> | undefined,
    accounts: InstanceType<typeof RelayAccounts> | undefined,
    url = "",
    cycle = 0,
    created = 0,
    removed = 0;
  const responses: Array<{ path: string; status: number }> = [];
  const start = async () => {
    accounts = new RelayAccounts(":memory:");
    const acmeDns = await AcmeDnsChallenges.open({
      file: join(directory, `dns-${cycle++}.json`),
      suffix: "example.test",
      provider: {
        async create() {
          created++;
        },
        async remove() {
          removed++;
        },
      },
    });
    relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      controlOrigin: "https://control.example.test",
      hostnameProof: async () => true,
      recoveryPolicy: f.policy(),
      acmeDns,
    });
    url = await listen(relay.server);
  };
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname,
      response = await fetch(url + path, init);
    responses.push({ path, status: response.status });
    return response;
  };
  const session = gatewayKeySessionSource({
    relayUrl: "https://control.example.test",
    gatewayId: f.registration.gatewayId,
    publicOrigin: f.registration.publicOrigin,
    sessionFile,
    ownerKeyFile,
    recoveryReceiptFile: receiptFile,
    certificateFile: f.files.certFile,
    privateKeyFile: f.files.keyFile,
    fetch: transport,
  });
  const invalidateSession = vi.fn(() => session.invalidate()),
    presenter = relayDnsPresenter({
      relayUrl: "https://control.example.test",
      session,
      invalidateSession,
      fetch: transport,
    }),
    signal = AbortSignal.timeout(10000);
  try {
    await start();
    const first = await presenter.create("a".repeat(43), signal);
    await presenter.remove(first.id, signal);
    const prior = await session(signal);
    await relay!.close();
    accounts!.close();
    relay = undefined;
    accounts = undefined;
    await start();
    const second = await presenter.create("b".repeat(43), signal);
    expect(invalidateSession).toHaveBeenCalledOnce();
    expect(await session(signal)).not.toBe(prior);
    expect(accounts!.gatewayBinding(f.account)?.gatewayId).toBe(f.registration.gatewayId);
    await presenter.remove(second.id, signal);
    expect(created).toBe(2);
    expect(removed).toBe(2);
    expect(
      responses
        .filter((item) => item.path === "/_relay/v2/acme/challenge")
        .map((item) => item.status),
    ).toEqual([200, 204, 401, 200, 204]);
  } finally {
    await relay?.close();
    accounts?.close();
  }
});

test("the controller's relay presenter invalidates its own session source on explicit 401", async () => {
  const env = await environment(),
    keys = await import("./gateway-key-client.js"),
    module = await import("./acme-gateway.js"),
    id = randomUUID();
  const source = Object.assign(() => Promise.resolve("fixture-owner"), { invalidate: vi.fn() });
  vi.spyOn(keys, "gatewayKeySessionSource").mockReturnValue(source);
  const presenters = vi.spyOn(module, "relayDnsPresenter");
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ id }));
  const controller = await createGatewayAcmeController(
    { ...env, OMNESIS_ACME_DNS_PROVIDER: "relay" },
    { configDir: directory, activate: () => Promise.resolve(), fetch: transport },
  );
  try {
    expect(presenters).toHaveBeenCalledOnce();
    const presenter = presenters.mock.results[0].value as ReturnType<
      typeof module.relayDnsPresenter
    >;
    expect(await presenter.create("a".repeat(43), new AbortController().signal)).toEqual({ id });
    expect(source.invalidate).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
    // Through the relay, the gateway sets no CAA record and expects none.
    expect(await controller!.expectedCaa!()).toBeUndefined();
  } finally {
    await controller!.close();
  }
});

test("an operator's ACME CA file adds its roots to the public ones, and holds only CA certificates", async () => {
  const { execFileSync } = await import("node:child_process");
  const { rootCertificates } = await import("node:tls");
  const caKey = join(directory, "private-ca.key"),
    caCert = join(directory, "private-ca.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-subj",
      "/CN=Fictional private ACME authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  const pem = await readFile(caCert, "utf8");
  const roots = acmeTrustedRoots(pem);
  expect(roots).toHaveLength(rootCertificates.length + 1);
  expect(roots.at(-1)!.trim()).toBe(pem.trim());
  expect(() => acmeTrustedRoots("")).toThrow("holds no certificate");
  const leafKey = join(directory, "leaf.key"),
    leafCert = join(directory, "leaf.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKey,
      "-out",
      leafCert,
      "-days",
      "1",
      "-subj",
      "/CN=leaf.example.test",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    { stdio: "ignore" },
  );
  expect(() => acmeTrustedRoots(pem + readFileSync(leafCert, "utf8"))).toThrow("non-CA");
});

test("the operator's ACME CA file reaches renewal as trusted roots, and a non-CA file stops setup", async () => {
  const { execFileSync } = await import("node:child_process");
  const { rootCertificates } = await import("node:tls");
  const certificate = (name: string, ca: boolean) => {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(directory, `${name}.key`),
        "-out",
        join(directory, `${name}.pem`),
        "-days",
        "1",
        "-subj",
        `/CN=Fictional ${name}`,
        "-addext",
        `basicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}`,
      ],
      { stdio: "ignore" },
    );
    return join(directory, `${name}.pem`);
  };
  const caCert = certificate("operator-ca", true);
  const env = { ...(await environment()), OMNESIS_ACME_CA_FILE: caCert },
    keys = await import("./gateway-key-client.js"),
    module = await import("./acme-gateway.js");
  vi.spyOn(keys, "registerGatewayKey").mockResolvedValue({
    token: "owner",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  });
  let roots: readonly string[] | undefined;
  vi.spyOn(module.GatewayAcmeRenewal.prototype, "renew").mockImplementation(async function (
    this: InstanceType<typeof module.GatewayAcmeRenewal>,
  ) {
    roots = (this as unknown as { options: { trustedRoots?: readonly string[] } }).options
      .trustedRoots;
    return false;
  });
  const controller = await createGatewayAcmeController(env, {
    configDir: directory,
    activate: async () => {},
  });
  try {
    expect(await controller!.renew(new AbortController().signal)).toBe(false);
    expect(roots).toHaveLength(rootCertificates.length + 1);
    expect(roots!.at(-1)!.trim()).toBe((await readFile(caCert, "utf8")).trim());
  } finally {
    await controller!.close();
  }
  await expect(
    createGatewayAcmeController(
      { ...env, OMNESIS_ACME_CA_FILE: certificate("operator-leaf", false) },
      { configDir: directory, activate: async () => {} },
    ),
  ).rejects.toThrow("non-CA");
});

/** A gateway of the given relay on its hosted name, with its owner key in place. */
async function hostedEnvironment(relayUrl: string, extra: NodeJS.ProcessEnv = {}) {
  const env = await environment();
  const gatewayId = randomUUID();
  const ownerKeyFile = join(directory, "owner.key");
  const { readOrCreateGatewayOwnerKey } = await import("./gateway-key-client.js");
  const owner = await readOrCreateGatewayOwnerKey(ownerKeyFile);
  return {
    owner,
    gatewayId,
    env: {
      ...env,
      OMNESIS_ACME_DNS_PROVIDER: undefined,
      OMNESIS_ACME_DNS_ZONE_ID: undefined,
      OMNESIS_ACME_DNS_ZONE_NAME: undefined,
      OMNESIS_ACME_DNS_TOKEN_FILE: undefined,
      OMNESIS_PUBLIC_BASE_URL: `https://${hostedGatewayHostname(gatewayId, new URL(relayUrl).hostname)}`,
      OMNESIS_CLOUD_RELAY_URL: relayUrl,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
      OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: ownerKeyFile,
      ...extra,
    },
  };
}

test("until the official broker answers, the official relay's gateways publish DNS-01 through the relay", async () => {
  const { env } = await hostedEnvironment("https://relay.omnesis.app");
  const keys = await import("./gateway-key-client.js"),
    client = await import("./dns-broker-client.js");
  vi.spyOn(keys, "gatewayKeySessionSource").mockReturnValue(
    Object.assign(() => Promise.resolve("fixture-owner"), { invalidate: vi.fn() }),
  );
  const presenters = vi.spyOn(client, "brokerOrRelayPresenter");
  const id = randomUUID();
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).startsWith("https://dns.omnesis.app/")
      ? Promise.reject(new TypeError("fetch failed"))
      : Response.json({ id }),
  );
  const controller = await createGatewayAcmeController(env, {
    configDir: directory,
    activate: () => Promise.resolve(),
    fetch: transport,
  });
  try {
    const presenter = presenters.mock.results[0]!.value as ReturnType<
      typeof client.brokerOrRelayPresenter
    >;
    expect(await presenter.create("a".repeat(43), new AbortController().signal)).toEqual({ id });
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://dns.omnesis.app/_dns/v2/health",
      "https://relay.omnesis.app/_relay/v2/acme/challenge",
    ]);
  } finally {
    await controller!.close();
  }
});

test("a gateway with the broker provider issues through the broker only, and only for its hosted name", async () => {
  const harness = await brokerHarness();
  const { env } = await hostedEnvironment("https://relay.example.test", {
    OMNESIS_ACME_DNS_PROVIDER: "broker",
    OMNESIS_ACME_DNS_BROKER_URL: harness.origin,
  });
  const client = await import("./dns-broker-client.js");
  const presenters = vi.spyOn(client, "brokerOrRelayPresenter");
  const controller = await createGatewayAcmeController(env, {
    configDir: directory,
    activate: () => Promise.resolve(),
    fetch: harness.fetch,
  });
  try {
    const presenter = presenters.mock.results[0]!.value as ReturnType<
      typeof client.brokerOrRelayPresenter
    >;
    const lease = await presenter.create("a".repeat(43), new AbortController().signal);
    expect(harness.cloudflare.records.filter((record) => record.type === "TXT")).toHaveLength(1);
    await presenter.remove(lease.id, new AbortController().signal);
    // Claimed, with no CAA record yet; then the account the record was set to bind.
    expect(await controller!.expectedCaa!()).toBeUndefined();
    const { savePrivateJson } = await import("./google-credentials.js");
    await savePrivateJson(`${env.OMNESIS_ACME_CERT_FILE}.acme-account.dns-broker.json`, {
      claimedAt: 1,
      accountUri: "https://acme-v02.api.letsencrypt.org/acme/acct/42",
    });
    expect(await controller!.expectedCaa!()).toBe(
      "https://acme-v02.api.letsencrypt.org/acme/acct/42",
    );
    expect(harness.calls).toEqual([
      "/_dns/v2/health",
      "/_dns/v2/challenge",
      "/_dns/v2/complete",
      "/_dns/v2/challenge",
      "/_dns/v2/complete",
      "/_dns/v2/challenge",
      "/_dns/v2/complete",
    ]);
  } finally {
    await controller!.close();
  }
  presenters.mockClear();
  const custom = await createGatewayAcmeController(
    {
      ...env,
      OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.org",
      OMNESIS_ACME_CERT_FILE: join(directory, "custom.crt"),
    },
    {
      configDir: join(directory, "custom"),
      activate: () => Promise.resolve(),
      fetch: harness.fetch,
    },
  );
  try {
    await expect(custom!.renew(new AbortController().signal)).rejects.toThrow(
      "only the gateway's hosted name",
    );
    expect(presenters).not.toHaveBeenCalled();
  } finally {
    await custom!.close();
  }
});

test("the broker presenter signs with the owner key beside the session when none is configured", async () => {
  const harness = await brokerHarness();
  const { env } = await hostedEnvironment("https://relay.example.test", {
    OMNESIS_ACME_DNS_PROVIDER: "broker",
    OMNESIS_ACME_DNS_BROKER_URL: harness.origin,
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: undefined,
  });
  const { readOrCreateGatewayOwnerKey } = await import("./gateway-key-client.js");
  await readOrCreateGatewayOwnerKey(`${env.OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`);
  const client = await import("./dns-broker-client.js");
  const presenters = vi.spyOn(client, "brokerOrRelayPresenter");
  const controller = await createGatewayAcmeController(env, {
    configDir: directory,
    activate: () => Promise.resolve(),
    fetch: harness.fetch,
  });
  try {
    const presenter = presenters.mock.results[0]!.value as ReturnType<
      typeof client.brokerOrRelayPresenter
    >;
    await presenter.create("a".repeat(43), new AbortController().signal);
    expect(harness.cloudflare.records.filter((record) => record.type === "TXT")).toHaveLength(1);
  } finally {
    await controller!.close();
  }
});
