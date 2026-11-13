// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { listen, localToken, tlsFiles } from "../test/support.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { RelayAccounts } from "./accounts.js";
import { gatewayBindingNonce } from "./gateway-binding.js";
import { registerGatewayKey } from "./gateway-key-client.js";
import { keyBindingOwnerAccount } from "./gateway-key-auth.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { RelaySessions, localIdentityProvider } from "./identity.js";
import { createCloudRelay } from "./server.js";

/**
 * Plays someone the sign-up policy does not admit, against a relay configured the way a public
 * one is: an allowlist that names somebody else, Google audiences configured for sign-in, hosted
 * gateway names, and a single free account slot. They walk the whole pre-account path with their
 * own Google identity and a self-signed certificate, and must come away with nothing.
 */
const origin = "https://relay.example.test";
const relayDomain = "relay.example.test";

let directory: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-legacy-attack-"));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await rm(directory, { recursive: true, force: true });
});

async function publicRelay() {
  const googleKey = randomBytes(32);
  const allowlistFile = join(directory, "allowlist.json");
  // The only admitted sign-in belongs to somebody else.
  await writeFile(
    allowlistFile,
    JSON.stringify({
      googleSubjects: [createHash("sha256").update("fictional-admitted-person").digest("hex")],
    }),
    { mode: 0o600 },
  );
  const accounts = new RelayAccounts(":memory:", 1);
  const sessions = new RelaySessions(randomBytes(32));
  const relay = createCloudRelay({
    accounts,
    sessions,
    controlOrigin: origin,
    relayDomain,
    // One verifier for every configured audience, as Google's is.
    identity: localIdentityProvider(googleKey, "127.0.0.1"),
    gatewayIdentity: localIdentityProvider(googleKey, "127.0.0.1"),
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
      signup: { policy: "allowlist", allowlistFile },
    },
  });
  const url = await listen(relay.server);
  cleanup.push(async () => {
    await relay.close();
    accounts.close();
  });
  // Everything addressed to the public origin reaches this relay.
  const transport: typeof fetch = async (input, init) =>
    fetch(`${url}${new URL(String(input)).pathname}`, init);
  return { accounts, sessions, url, googleKey, transport };
}

/** The HTTP status a tunnel upgrade gets; 101 means it opened. */
function tunnelStatus(url: string, token: string, gatewayId: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url.replace("http:", "ws:") + "/_relay/v1/tunnel", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-omnesis-tunnel-protocol": "2",
        "x-omnesis-gateway-id": gatewayId,
      },
    });
    socket.once("upgrade", () => {
      resolve(101);
      socket.terminate();
    });
    socket.once("unexpected-response", (_req, response) => {
      resolve(response.statusCode!);
      response.resume();
      socket.terminate();
    });
    socket.once("error", () => {});
  });
}

test("someone the sign-up policy refuses gets no account, routed gateway, owner key or account slot through the pre-account routes", async () => {
  const relay = await publicRelay();
  const gatewayId = randomUUID();
  const hostname = hostedGatewayHostname(gatewayId, relayDomain);
  const tls = tlsFiles(directory, hostname);
  const certificate = await readFile(tls.certFile, "utf8");

  // 1. Exchange their own Google ID token for a relay session.
  const login = await fetch(`${relay.url}/_relay/v1/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: await localToken(relay.googleKey, "fictional-intruder") }),
  });
  const token = login.ok ? ((await login.json()) as { token: string }).token : "none";

  // 2. Register a routed gateway on a hosted name with a self-signed certificate.
  const binding = { gatewayId, publicOrigin: `https://${hostname}`, certificate };
  const identityToken = await new SignJWT({ nonce: gatewayBindingNonce(binding) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("omnesis-local-test")
    .setSubject("fictional-intruder")
    .setAudience("omnesis-cloud-relay")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(relay.googleKey);
  const registration = await fetch(`${relay.url}/_relay/v2/gateway`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...binding, identityToken }),
  });

  // 3. Open the gateway tunnel for it.
  const tunnel = await tunnelStatus(relay.url, token, gatewayId);

  // 4. Move it to an owner key with the same TLS key and no invitation.
  const enrollment = await registerGatewayKey({
    relayUrl: origin,
    sessionFile: join(directory, "intruder-session.json"),
    gatewayId,
    publicOrigin: `https://${hostname}`,
    certificateFile: tls.certFile,
    privateKeyFile: tls.keyFile,
    fetch: relay.transport,
  }).then(
    (session) => session.accountId,
    () => undefined,
  );

  const owner = relay.accounts.ownerForGateway(gatewayId);
  const bound = owner === undefined ? undefined : relay.accounts.gatewayBinding(owner);
  expect({
    accounts: relay.accounts.snapshot().accounts,
    gatewayBindings: relay.accounts.snapshot().gatewayBindings,
    routedHostname: relay.accounts.accountForHostname(hostname),
    gatewayOwner: owner,
    ownerKeyBinding: bound === undefined ? undefined : keyBindingOwnerAccount(bound),
    enrolledAccount: enrollment,
  }).toEqual({
    accounts: 0,
    gatewayBindings: 0,
    routedHostname: undefined,
    gatewayOwner: undefined,
    ownerKeyBinding: undefined,
    enrolledAccount: undefined,
  });
  expect({
    login: login.status,
    registration: registration.status,
    tunnel,
  }).toEqual({ login: 404, registration: 404, tunnel: 401 });

  // The one account slot is still there for a gateway the operator invited.
  const invitedId = randomUUID();
  const invitedHost = hostedGatewayHostname(invitedId, relayDomain);
  await mkdir(join(directory, "invited"));
  const invitedTls = tlsFiles(join(directory, "invited"), invitedHost);
  const enrollmentTokenFile = join(directory, "invitation.json");
  await writeFile(
    enrollmentTokenFile,
    JSON.stringify({
      enrollmentToken: await relay.sessions.issueEnrollmentInvitation(invitedId, origin),
    }),
  );
  const invited = await registerGatewayKey({
    relayUrl: origin,
    sessionFile: join(directory, "invited-session.json"),
    gatewayId: invitedId,
    publicOrigin: `https://${invitedHost}`,
    certificateFile: invitedTls.certFile,
    privateKeyFile: invitedTls.keyFile,
    enrollmentTokenFile,
    fetch: relay.transport,
  });
  expect(relay.accounts.accountForHostname(invitedHost)).toBe(invited.accountId);
  expect(relay.accounts.snapshot().accounts).toBe(1);
});
