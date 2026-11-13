// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { runRelayCommand, startRelayDaemon } from "./runtime.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { RelayAccounts } from "./accounts.js";
import * as relayServer from "./server.js";
import * as keys from "./gateway-key-client.js";
import * as cloudflare from "./cloudflare-dns.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-runtime-acme-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
async function environment() {
  const keyFile = join(directory, "relay.key"),
    tokenFile = join(directory, "dns.json");
  await writeFile(keyFile, randomBytes(32));
  await writeFile(tokenFile, JSON.stringify({ token: "synthetic-relay-held-DNS-token" }), {
    mode: 0o600,
  });
  return {
    OMNESIS_CLOUD_RELAY_KEY_FILE: keyFile,
    OMNESIS_CLOUD_RELAY_DB: join(directory, "accounts.sqlite"),
    OMNESIS_CLOUD_RELAY_PORT: "0",
    OMNESIS_SYNTHETIC: "1",
    OMNESIS_CLOUD_RELAY_DOMAIN: "relay.example.test",
    OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: "a".repeat(32),
    OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: "relay.example.test",
    OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: tokenFile,
    OMNESIS_CLOUD_RELAY_ACME_JOURNAL: join(directory, "dns-journal"),
  };
}
test("managed relay DNS remains disabled unless every operator-owned setting is present", async () => {
  const env = await environment();
  const fields = [
    "OMNESIS_CLOUD_RELAY_ACME_ZONE_ID",
    "OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME",
    "OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE",
    "OMNESIS_CLOUD_RELAY_ACME_JOURNAL",
    "OMNESIS_CLOUD_RELAY_DOMAIN",
  ] as const;
  for (const field of fields)
    await expect(startRelayDaemon({ ...env, [field]: undefined })).rejects.toThrow("requires zone");
  for (const field of fields.slice(0, 4)) {
    const partial = Object.fromEntries(
      Object.entries(env).filter(
        ([name]) => !fields.slice(0, 4).includes(name as (typeof fields)[number]),
      ),
    );
    await expect(startRelayDaemon({ ...partial, [field]: env[field] })).rejects.toThrow(
      "requires zone",
    );
  }
  const daemon = await startRelayDaemon(env);
  try {
    expect((await fetch(`${daemon.url}/_relay/v2/acme/challenge`, { method: "POST" })).status).toBe(
      401,
    );
  } finally {
    await daemon.close();
  }
});
test("DNS setup cleanup failures do not leak SQLite or leave a partially started relay", async () => {
  const env = await environment(),
    close = vi.fn(async () => {
      throw new Error("DNS provider unavailable");
    });
  vi.spyOn(AcmeDnsChallenges, "open").mockResolvedValue({ close } as unknown as AcmeDnsChallenges);
  await expect(
    startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_MAX_STREAMS: "2147483647" }),
  ).rejects.toThrow("limits");
  expect(close).toHaveBeenCalledOnce();
});
test.each([false, true])(
  "a failed first listener drains inline DNS and SQLite while retaining the bind error (DNS cleanup fails: %s)",
  async (cleanupFails) => {
    const env = await environment();
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    const originalClose = AcmeDnsChallenges.prototype.close;
    const dnsClose = vi
      .spyOn(AcmeDnsChallenges.prototype, "close")
      .mockImplementation(async function (this: AcmeDnsChallenges) {
        await originalClose.call(this);
        if (cleanupFails) throw new Error("Synthetic DNS cleanup failure");
      });
    const accountsClose = vi.spyOn(RelayAccounts.prototype, "close");
    try {
      await expect(
        startRelayDaemon({ ...env, OMNESIS_CLOUD_RELAY_PORT: String(address.port) }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(dnsClose).toHaveBeenCalledOnce();
      expect(accountsClose).toHaveBeenCalledOnce();
      // A new daemon can reuse the same files after the failed startup.
      dnsClose.mockRestore();
      const restarted = await startRelayDaemon(env);
      await restarted.close();
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
test("normal shutdown releases SQLite even when a drained relay reports a close error", async () => {
  const env = await environment();
  const create = relayServer.createCloudRelay;
  const factory = vi.spyOn(relayServer, "createCloudRelay").mockImplementation((options) => {
    const relay = create(options);
    return {
      ...relay,
      async close() {
        await relay.close();
        throw new Error("Synthetic drained listener failure");
      },
    };
  });
  const accountsClose = vi.spyOn(RelayAccounts.prototype, "close");
  const daemon = await startRelayDaemon(env);
  await expect(daemon.close()).rejects.toThrow("Synthetic drained listener failure");
  expect(accountsClose).toHaveBeenCalledOnce();
  factory.mockRestore();
  const restarted = await startRelayDaemon(env);
  await restarted.close();
});
test("register-key prepares only independent public SNI material and refuses direct certificate/key path collisions", async () => {
  const tls = tlsFiles(directory),
    publicCertificate = join(directory, "public.crt");
  const register = vi.spyOn(keys, "registerGatewayKey").mockResolvedValue({
    token: "private-owner",
    accountId: "a".repeat(64),
    expiresAt: 4000000000,
  });
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
    OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://public.example.test",
    OMNESIS_PUBLIC_BASE_URL: "https://old-direct.example.test",
    OMNESIS_TLS_CERT: tls.certFile,
    OMNESIS_TLS_KEY: tls.keyFile,
    OMNESIS_CONFIG_DIR: directory,
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_CERT_FILE: publicCertificate,
  };
  const direct = await readFile(tls.certFile, "utf8"),
    privateKey = await readFile(tls.keyFile, "utf8");
  for (const path of [tls.certFile, tls.keyFile])
    await expect(
      runRelayCommand("register-key", { ...env, OMNESIS_ACME_CERT_FILE: path }),
    ).rejects.toThrow("own path");
  for (const path of [tls.certFile, tls.keyFile, publicCertificate])
    await expect(
      runRelayCommand("register-key", { ...env, OMNESIS_ACME_KEY_FILE: path }),
    ).rejects.toThrow("separate stable");
  await runRelayCommand("register-key", {
    ...env,
    OMNESIS_TLS_CERT: undefined,
    OMNESIS_TLS_KEY: undefined,
  });
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({
      certificateFile: publicCertificate,
      privateKeyFile: `${publicCertificate}.key`,
      publicOrigin: env.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN,
    }),
  );
  // The fallback only classifies direct paths; mock it so this fixture cannot consult operator TLS files.
  const core = await import("@omnesis/core");
  const classify = vi
    .spyOn(core, "resolveTlsMaterial")
    .mockReturnValue({ ownership: "external", certPath: tls.certFile, keyPath: tls.keyFile });
  await runRelayCommand("register-key", { ...env, OMNESIS_CONFIG_DIR: undefined });
  expect(classify).toHaveBeenCalledWith({
    configDir: core.DEFAULT_CONFIG_DIR,
    certPath: tls.certFile,
    keyPath: tls.keyFile,
  });
  classify.mockRestore();
  expect(await readFile(tls.certFile, "utf8")).toBe(direct);
  expect(await readFile(tls.keyFile, "utf8")).toBe(privateKey);
});
test("offline prepare-owner without an origin emits no DNS claim and a disabled broker endpoint stays explicitly unavailable", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await runRelayCommand("prepare-owner", {
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: randomUUID(),
  });
  expect(JSON.parse(String(stdout.mock.calls[0][0]))).not.toHaveProperty("dns");
  stdout.mockRestore();
  const env = await environment();
  const disabled = {
    ...env,
    OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: undefined,
    OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: undefined,
    OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: undefined,
    OMNESIS_CLOUD_RELAY_ACME_JOURNAL: undefined,
  };
  const daemon = await startRelayDaemon(disabled);
  try {
    expect((await fetch(`${daemon.url}/_relay/v2/acme/challenge`, { method: "POST" })).status).toBe(
      503,
    );
  } finally {
    await daemon.close();
  }
});

test("dedicated gateway web attestation is optional, distinct from ordinary clients and usable without desktop Google configuration", async () => {
  const env = await environment(),
    gatewayWeb = "dedicated-gateway-browser";
  const disabledDns = {
    ...env,
    OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: undefined,
    OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: undefined,
    OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: undefined,
    OMNESIS_CLOUD_RELAY_ACME_JOURNAL: undefined,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: gatewayWeb,
  };
  for (const field of [
    "OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID",
    "OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID",
    "OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID",
    "OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID",
  ]) {
    await expect(startRelayDaemon({ ...disabledDns, [field]: gatewayWeb })).rejects.toThrow(
      "separate",
    );
  }
  await expect(
    startRelayDaemon({
      ...disabledDns,
      OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE: env.OMNESIS_CLOUD_RELAY_KEY_FILE,
    }),
  ).rejects.toThrow("never both");
  const identity = await import("./identity.js"),
    provider = vi.spyOn(identity, "googleIdentityProvider");
  const daemon = await startRelayDaemon(disabledDns);
  try {
    expect(provider).toHaveBeenCalledWith([gatewayWeb]);
  } finally {
    await daemon.close();
  }
});

test("a loopback relay may point managed DNS at a loopback fixture API, and no other relay may", async () => {
  const env = await environment();
  const provider = vi.spyOn(cloudflare, "cloudflareDnsProvider");
  const daemon = await startRelayDaemon({
    ...env,
    OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL: "http://127.0.0.1:9/client/v4/",
  });
  await daemon.close();
  expect(provider).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiUrl: "http://127.0.0.1:9/client/v4" }),
  );
  await startRelayDaemon(env).then((plain) => plain.close());
  expect(provider.mock.lastCall![0]).not.toHaveProperty("apiUrl");
  await expect(
    startRelayDaemon({
      ...env,
      OMNESIS_CLOUD_RELAY_BIND: "0.0.0.0",
      OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL: "http://127.0.0.1:9/client/v4",
    }),
  ).rejects.toThrow("loopback relay listener");
});
