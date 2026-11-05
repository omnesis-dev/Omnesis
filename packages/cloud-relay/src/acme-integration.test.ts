// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { createGatewayAcmeController } from "./acme-integration.js";
import type { AcmeDnsChallenges as AcmeDnsService } from "./acme-dns.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-acme-integration-"));
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
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
  const before = await readdir(directory);
  expect(
    await createGatewayAcmeController({}, { configDir: directory, activate, fetch }),
  ).toBeUndefined();
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  expect(
    await createGatewayAcmeController(
      { OMNESIS_ACME_DIRECTORY_URL: "malformed", OMNESIS_ACME_TERMS_ACCEPTED: "invalid" },
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
    execFileSync(
      "openssl",
      [
        "x509",
        "-in",
        env.OMNESIS_ACME_CERT_FILE,
        "-signkey",
        `${env.OMNESIS_ACME_CERT_FILE}.key`,
        "-days",
        "-1",
        "-out",
        expired,
      ],
      { stdio: "ignore" },
    );
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
  } finally {
    await controller!.close();
  }
});
