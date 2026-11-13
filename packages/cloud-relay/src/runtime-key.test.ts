// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { tlsFiles } from "../test/support.js";
import { runRelayCommand, startRelayDaemon } from "./runtime.js";
import { RelaySessions } from "./identity.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import * as keyClient from "./gateway-key-client.js";
import * as googleLink from "./gateway-google-link.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-key-runtime-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
test("offline invitation command writes a private UUID/recipient bound token and never requires Google", async () => {
  const keyFile = join(directory, "relay-key"),
    tokenFile = join(directory, "invite.json");
  const key = randomBytes(32),
    uuid = randomUUID();
  await writeFile(keyFile, key);
  const log = vi.spyOn(console, "log");
  await runRelayCommand("issue-invite", {
    OMNESIS_CLOUD_RELAY_KEY_FILE: keyFile,
    OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: tokenFile,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: uuid,
    OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://relay.example.test",
  });
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  const { enrollmentToken } = JSON.parse(await readFile(tokenFile, "utf8"));
  await new RelaySessions(key).verifyEnrollmentInvitation(
    enrollmentToken,
    uuid,
    "https://relay.example.test",
  );
  expect(log).not.toHaveBeenCalled();
});
test("register-key runtime carries only explicit configuration to the key client and link dispatch remains available", async () => {
  const register = vi
    .spyOn(keyClient, "registerGatewayKey")
    .mockResolvedValue({ token: "private", accountId: "a".repeat(64), expiresAt: 4_000_000_000 });
  const uuid = randomUUID();
  const env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "/synthetic/session",
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: uuid,
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
    OMNESIS_TLS_CERT: "/synthetic/leaf",
    OMNESIS_TLS_KEY: "/synthetic/tls",
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: "/synthetic/owner",
    OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: "/synthetic/invite",
  };
  await runRelayCommand("register-key", env);
  expect(register).toHaveBeenCalledExactlyOnceWith({
    relayUrl: env.OMNESIS_CLOUD_RELAY_URL,
    sessionFile: env.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    gatewayId: uuid,
    publicOrigin: env.OMNESIS_PUBLIC_BASE_URL,
    certificateFile: env.OMNESIS_TLS_CERT,
    privateKeyFile: env.OMNESIS_TLS_KEY,
    ownerKeyFile: env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
    enrollmentTokenFile: env.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
  });
  const link = vi.spyOn(googleLink, "runGatewayGoogleLink").mockResolvedValue(undefined);
  await runRelayCommand("link-google", env);
  await runRelayCommand("unlink-google", env);
  expect(link.mock.calls).toEqual([
    ["link-google", env],
    ["unlink-google", env],
  ]);
});
test("isolated synthetic runtime auto-enrolls key-only gateways while ordinary unconfigured relay refuses recipients", async () => {
  const key = join(directory, "key");
  await writeFile(key, randomBytes(32));
  const uuid = randomUUID();
  const config = {
    OMNESIS_CLOUD_RELAY_KEY_FILE: key,
    OMNESIS_CLOUD_RELAY_DB: join(directory, "accounts.sqlite"),
    OMNESIS_CLOUD_RELAY_PORT: "0",
    OMNESIS_SYNTHETIC: "1",
    OMNESIS_CLOUD_RELAY_DOMAIN: "relay.example.test",
  };
  const tls = tlsFiles(directory, hostedGatewayHostname(uuid, "relay.example.test"));
  const daemon = await startRelayDaemon(config);
  try {
    const sessionFile = join(directory, "session.json");
    await runRelayCommand("register-key", {
      OMNESIS_CLOUD_RELAY_URL: daemon.url,
      OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
      OMNESIS_CLOUD_RELAY_GATEWAY_ID: uuid.toUpperCase(),
      OMNESIS_PUBLIC_BASE_URL: `https://${hostedGatewayHostname(uuid, "relay.example.test")}`,
      OMNESIS_TLS_CERT: tls.certFile,
      OMNESIS_TLS_KEY: tls.keyFile,
    });
    expect(JSON.parse(await readFile(sessionFile, "utf8")).authentication).toBe("gateway-key-v2");
  } finally {
    await daemon.close();
  }
  const ordinary = await startRelayDaemon({ ...config, OMNESIS_SYNTHETIC: undefined });
  try {
    const response = await fetch(`${ordinary.url}/_relay/v2/key/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gatewayId: uuid,
        publicOrigin: "https://gateway.example.test",
        certificate: await readFile(tls.certFile, "utf8"),
        ownerPublicKey: "unused",
        relayOrigin: ordinary.url,
      }),
    });
    expect(response.status).toBe(503);
  } finally {
    await ordinary.close();
  }
});

test("prepare-owner emits only machine-readable public enrollment details before any relay or Google setup", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const gatewayId = randomUUID();
  const sessionFile = join(directory, "prepared");
  await runRelayCommand("prepare-owner", {
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    OMNESIS_CLOUD_RELAY_SESSION_FILE: sessionFile,
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
  });
  const result = JSON.parse(String(stdout.mock.calls[0][0]));
  expect(result).toMatchObject({
    gatewayId,
    accountId: expect.stringMatching(/^[a-f0-9]{64}$/),
    publicOrigin: "https://gateway.example.test",
    dns: {
      name: "_omnesis-gateway.gateway.example.test",
      value: expect.stringContaining(gatewayId),
    },
  });
  expect((await stat(`${sessionFile}.owner-key`)).mode & 0o777).toBe(0o600);
  expect(String(stdout.mock.calls[0][0])).not.toContain("PRIVATE KEY");
});
