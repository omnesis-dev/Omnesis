// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runGatewayGoogleLink } from "./gateway-google-link.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { accountId } from "./identity.js";
import * as desktop from "./google-desktop.js";
import * as keyClient from "./gateway-key-client.js";

const vectors = JSON.parse(
  await readFile(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
);
const identity = {
  issuer: "https://accounts.google.com",
  subject: "fictional-owner",
  expiresAt: 4_000_000_000,
};
const google = {
  identity,
  idToken: "fictional-signed-google-proof",
  refreshToken: "unneeded-refresh-token",
};
const owner = {
  token: "fictional-owner-key-session",
  accountId: "a".repeat(64),
  expiresAt: 4_000_000_000,
};
let directory: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-google-link-"));
  env = {
    OMNESIS_CLOUD_RELAY_URL: "https://relay.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: join(directory, "session.json"),
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: vectors.gateway.gatewayId,
    OMNESIS_PUBLIC_BASE_URL: vectors.gateway.publicOrigin,
    OMNESIS_TLS_CERT: join(directory, "fullchain.pem"),
    OMNESIS_TLS_KEY: join(directory, "private-key.pem"),
    OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: join(directory, "owner.pem"),
    OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: join(directory, "invite.json"),
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: "fictional-dedicated-gateway-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: join(directory, "google.json"),
  };
  await writeFile(env.OMNESIS_TLS_CERT!, vectors.gateway.certificate + vectors.gateway.certificate);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

test("a raw key owner links independently verified Google identity without granting a device or storing refresh authority", async () => {
  const authorize = vi.fn<typeof desktop.authorizeGoogleDesktop>(async () => google);
  const registerKey = vi.fn<typeof keyClient.registerGatewayKey>(async () => owner);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toBe("https://relay.example.test/_relay/v2/key/google-link");
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("error");
    expect(init!.headers).toMatchObject({ authorization: `Bearer ${owner.token}` });
    expect(JSON.parse(init!.body as string)).toEqual({ identityToken: google.idToken });
    expect(init!.body).not.toContain("PRIVATE KEY");
    return new Response(null, { status: 204 });
  });
  await runGatewayGoogleLink("link-google", env, { authorize, registerKey, fetch });
  expect(registerKey).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerKeyFile: env.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
      enrollmentTokenFile: env.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
      privateKeyFile: env.OMNESIS_TLS_KEY,
    }),
  );
  expect(authorize).toHaveBeenCalledExactlyOnceWith({
    clientId: env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID,
    clientSecret: undefined,
    nonce: gatewayBindingNonce(vectors.gateway),
  });
  const saved = JSON.parse(
    await readFile(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE!, "utf8"),
  );
  expect(saved.accountId).toBe(accountId(identity));
  expect(saved).not.toHaveProperty("refreshToken");
  if (process.platform !== "win32") {
    expect((await stat(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE!)).mode & 0o777).toBe(0o600);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("unlinking remains independent of Google registration, OAuth secrets and provider availability", async () => {
  const authorize = vi.fn<typeof desktop.authorizeGoogleDesktop>();
  const registerKey = vi.fn<typeof keyClient.registerGatewayKey>(async () => owner);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(init!.method).toBe("DELETE");
    expect(init!.body).toBeUndefined();
    expect(init!.headers).toMatchObject({ authorization: `Bearer ${owner.token}` });
    return new Response(null, { status: 204 });
  });
  await runGatewayGoogleLink(
    "unlink-google",
    {
      ...env,
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: undefined,
      OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: "/nonexistent/unused-google-client.json",
    },
    { authorize, registerKey, fetch },
  );
  expect(authorize).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("installed-client secrets stay on the gateway backend with default drivers and transport", async () => {
  const secretFile = join(directory, "installed-client.json");
  await writeFile(
    secretFile,
    JSON.stringify({
      installed: {
        client_id: env.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID,
        client_secret: "fictional-backend-only-secret",
      },
    }),
  );
  vi.spyOn(keyClient, "registerGatewayKey").mockResolvedValue(owner);
  vi.spyOn(desktop, "authorizeGoogleDesktop").mockResolvedValue(google);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(init!.body).not.toContain("fictional-backend-only-secret");
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  await runGatewayGoogleLink("link-google", {
    ...env,
    OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE: secretFile,
  });
  expect(desktop.authorizeGoogleDesktop).toHaveBeenCalledWith(
    expect.objectContaining({ clientSecret: "fictional-backend-only-secret" }),
  );
});

test("invalid configuration and refused links never replace the local Google owner profile", async () => {
  const authorize = vi.fn<typeof desktop.authorizeGoogleDesktop>(async () => google);
  const registerKey = vi.fn<typeof keyClient.registerGatewayKey>(async () => owner);
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("fictional-sensitive-body", { status: 409 }),
  );
  await expect(
    runGatewayGoogleLink(
      "link-google",
      { ...env, OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: undefined },
      { authorize, registerKey, fetch },
    ),
  ).rejects.toThrow();
  expect(registerKey).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
  await expect(
    runGatewayGoogleLink("link-google", env, { authorize, registerKey, fetch }),
  ).rejects.toThrow("link change refused");
  await expect(stat(env.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("Google discovery links the public SNI identity without reading or replacing the direct certificate", async () => {
  const publicFile = join(directory, "public-sni.pem");
  await writeFile(publicFile, vectors.gateway.certificate);
  await writeFile(env.OMNESIS_TLS_CERT!, "fictional-direct-certificate-is-not-the-public-identity");
  const authorize = vi.fn<typeof desktop.authorizeGoogleDesktop>(async () => google);
  const registerKey = vi.fn<typeof keyClient.registerGatewayKey>(async () => owner);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  await runGatewayGoogleLink(
    "link-google",
    {
      ...env,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: env.OMNESIS_PUBLIC_BASE_URL,
      OMNESIS_PUBLIC_BASE_URL: "https://direct.example.test",
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
      OMNESIS_ACME_CERT_FILE: publicFile,
    },
    { authorize, registerKey, fetch },
  );
  expect(registerKey).toHaveBeenCalledWith(
    expect.objectContaining({ certificateFile: publicFile, privateKeyFile: `${publicFile}.key` }),
  );
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ nonce: gatewayBindingNonce(vectors.gateway) }),
  );
  expect(await readFile(env.OMNESIS_TLS_CERT!, "utf8")).toBe(
    "fictional-direct-certificate-is-not-the-public-identity",
  );
});
