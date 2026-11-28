// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@omnesis/core";
import { afterEach, expect, test, vi } from "vitest";
import { tlsFiles, listen } from "../test/support.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { createCloudRelay } from "./server.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { GatewayUnregistered, registerGatewayKey } from "./gateway-key-client.js";
import { gatewayReleaseSchema, releaseGateway } from "./gateway-release.js";

afterEach(() => vi.unstubAllGlobals());
const record = gatewayReleaseSchema.parse({
  version: 1,
  relayUrl: "https://relay.example.test",
  gatewayId: "26435b2c-768a-4ce8-ae85-72ade9c2d529",
  publicOrigin: "https://gateway.example.test",
  sessionFile: "/synthetic/session.json",
  ownerKeyFile: "/synthetic/owner.key",
  certificateFile: "/synthetic/public.pem",
  privateKeyFile: "/synthetic/public.key",
  createdAt: 1,
});
const session = { token: "owner-session", accountId: "a".repeat(64), expiresAt: 4000000000 };

test("a disconnected gateway proves its keys and asks the relay to drop it", async () => {
  const register = vi.fn(async () => session),
    transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true })),
    signal = new AbortController().signal;
  await releaseGateway(record, { register, fetch: transport, signal });
  expect(register).toHaveBeenCalledExactlyOnceWith({
    relayUrl: record.relayUrl,
    gatewayId: record.gatewayId,
    publicOrigin: record.publicOrigin,
    sessionFile: record.sessionFile,
    ownerKeyFile: record.ownerKeyFile,
    certificateFile: record.certificateFile,
    privateKeyFile: record.privateKeyFile,
    fetch: transport,
    signal,
  });
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://relay.example.test/_relay/v3/account-browser/unlink");
  expect(init).toMatchObject({
    method: "POST",
    redirect: "error",
    body: "{}",
    headers: { "content-type": "application/json", authorization: "Bearer owner-session" },
  });
  // Without a transport of its own it uses the platform's.
  const platform = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", platform);
  await releaseGateway(record, { register, signal });
  expect(platform).toHaveBeenCalledOnce();
});

test("a relay that already forgot the gateway has nothing left to drop; any other failure is tried again", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    signal = new AbortController().signal;
  await releaseGateway(record, {
    register: async () => {
      throw new GatewayUnregistered();
    },
    fetch: transport,
    signal,
  });
  expect(transport).not.toHaveBeenCalled();
  await expect(
    releaseGateway(record, {
      register: async () => {
        throw new Error("fetch failed");
      },
      fetch: transport,
      signal,
    }),
  ).rejects.toThrow("fetch failed");
  expect(transport).not.toHaveBeenCalled();
  await expect(
    releaseGateway(record, { register: async () => session, fetch: transport, signal }),
  ).rejects.toThrow("The relay did not release this gateway");
});

test("encrypted-key release uses only the explicitly supplied configuration scope and the real relay", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-scoped-release-")));
  const accounts = new RelayAccounts(":memory:");
  const controlOrigin = "https://relay.example.test";
  const gatewayId = randomUUID();
  const hostname = hostedGatewayHostname(gatewayId, "relay.example.test");
  const sessions = new RelaySessions(randomBytes(32));
  // The existing account-deletion wire fixture maps this exact invented origin to its owned relay.
  const relay = createCloudRelay({
    accounts,
    controlOrigin,
    relayDomain: "relay.example.test",
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        controlOrigin,
        generateKeyPairSync("ed25519").privateKey,
      ),
    },
    sessions,
    hostnameProof: async () => true,
  });
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  core.clearSecretFileKeyCacheForTests();
  try {
    if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
    const tls = tlsFiles(directory, hostname);
    const loopback = await listen(relay.server);
    const sendToRelay: typeof fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== controlOrigin) throw new Error("Unexpected fixture relay origin");
      return fetch(new URL(target.pathname + target.search, loopback), init);
    };
    await core.ensureInstallRootKey({ backend: "file", configDir: directory });
    await core.primeSecretFileKeyCache({ backend: "file", configDir: directory });
    const pem = await readFile(tls.keyFile, "utf8");
    await core.writeSecretTextFile(tls.keyFile, pem, { configDir: directory });
    expect(core.isEncryptedSecretFile(await readFile(tls.keyFile, "utf8"))).toBe(true);
    const options = {
      relayUrl: controlOrigin,
      gatewayId,
      publicOrigin: `https://${hostname}`,
      sessionFile: join(directory, "session.json"),
      certificateFile: tls.certFile,
      privateKeyFile: tls.keyFile,
    };
    const invitation = join(directory, "invitation.json");
    await writeFile(
      invitation,
      JSON.stringify({
        enrollmentToken: await sessions.issueEnrollmentInvitation(gatewayId, controlOrigin),
      }),
      { mode: 0o600, flag: "wx" },
    );
    const registered = await registerGatewayKey({
      ...options,
      configDir: directory,
      fetch: sendToRelay,
      enrollmentTokenFile: invitation,
    });
    expect(accounts.registered(registered.accountId)).toBe(true);
    const journal = gatewayReleaseSchema.parse({ version: 1, ...options, createdAt: Date.now() });
    let requests = 0;
    const transport: typeof fetch = async (...args) => {
      requests++;
      return sendToRelay(...args);
    };
    const signal = AbortSignal.timeout(10_000);
    await expect(
      releaseGateway(journal, { register: registerGatewayKey, fetch: transport, signal }),
    ).rejects.toThrow("requires its configuration directory");
    expect(requests).toBe(0);
    const other = join(directory, "other");
    await mkdir(other);
    await expect(
      releaseGateway(journal, {
        register: registerGatewayKey,
        fetch: transport,
        signal,
        configDir: other,
      }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
    expect(accounts.registered(registered.accountId)).toBe(true);
    await releaseGateway(journal, {
      register: registerGatewayKey,
      fetch: transport,
      signal,
      configDir: directory,
    });
    expect(requests > 0).toBe(true);
    expect(accounts.registered(registered.accountId)).toBe(false);
    // Local configuration authority is not inferred from or persisted in the portable journal.
    expect("configDir" in journal).toBe(false);
  } finally {
    await relay.close();
    accounts.close();
    core.clearSecretFileKeyCacheForTests();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
