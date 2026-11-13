// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID, sign } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";
import {
  GoogleBrowserBroker,
  type GoogleBrowserBrokerOptions,
  type GoogleBrowserOwnerAuthorization,
} from "../src/google-browser-broker.js";
import {
  googleBrowserStartTranscript,
  GOOGLE_BROWSER_PROTOCOL,
  GOOGLE_BROWSER_PATH,
  googleBrowserCallbackPath,
  type GoogleBrowserPurpose,
  type GoogleBrowserUnsignedStart,
} from "../src/google-browser-contract.js";
import { gatewayBindingNonce } from "../src/gateway-binding.js";
import { tlsSpkiFingerprint } from "../src/pinned-key.js";
import { googleIdentityProvider } from "../src/identity.js";
import { recoveryFixture } from "./recovery-fixture.js";

const keyPair = generateKeyPair("RS256");

/** The synthetic Google provider signs original OIDC JWTs and enforces the code/PKCE/client-secret exchange. */
export async function googleBrowserFixture(
  directory: string,
  origin = "https://relay.example.test",
) {
  const f = await recoveryFixture(directory, origin);
  const keys = await keyPair,
    jwk = await exportJWK(keys.publicKey);
  const issuer = (audience: string) =>
    googleIdentityProvider(
      audience,
      createLocalJWKSet({ keys: [{ ...jwk, kid: "synthetic-google-key", alg: "RS256" }] }),
    );
  const owner: GoogleBrowserOwnerAuthorization = {
    relayOrigin: origin,
    accountId: f.account,
    gatewayId: f.registration.gatewayId,
    publicOrigin: f.registration.publicOrigin,
    tlsSpkiFingerprint: tlsSpkiFingerprint(f.registration.certificate),
    ownerPublicKey: f.owner.publicKey,
    certificate: f.registration.certificate,
    sessionExpiresAt: f.now + 3600,
  };
  let current: GoogleBrowserOwnerAuthorization | undefined = owner;
  const codes = new Map<
    string,
    { nonce: string; clientId: string; challenge: string; redirectUri: string }
  >();
  const token = async (
    nonce: string,
    clientId = "fixture-owner-client",
    overrides: { nonce?: string; audience?: string; issuedAt?: number } = {},
  ) =>
    new SignJWT({ nonce, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-google-key" })
      .setIssuer("https://accounts.google.com")
      .setSubject("synthetic-google-account")
      .setAudience(overrides.audience ?? clientId)
      .setIssuedAt(overrides.issuedAt ?? Math.floor(Date.now() / 1000))
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  const exchange = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) !== "https://oauth2.googleapis.com/token")
      throw new Error("Unexpected provider endpoint");
    const form = init!.body as URLSearchParams;
    const code = form.get("code")!,
      pending = codes.get(code);
    if (
      !pending ||
      form.get("client_id") !== pending.clientId ||
      form.get("redirect_uri") !== pending.redirectUri ||
      form.get("client_secret") !== `synthetic-secret-${pending.clientId}` ||
      createHash("sha256").update(form.get("code_verifier")!).digest("base64url") !==
        pending.challenge
    )
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    codes.delete(code);
    return Response.json({
      id_token: await token(pending.nonce, pending.clientId),
      token_type: "Bearer",
    });
  });
  const oauth = (clientId: string) => ({
    clientId,
    clientSecret: `synthetic-secret-${clientId}`,
    identity: issuer(clientId),
    fetch: exchange,
  });
  const configuration: GoogleBrowserBrokerOptions = {
    origin,
    ownerLink: oauth("fixture-owner-client"),
    deviceEnrollment: oauth("fixture-device-client"),
    deviceClientIds: ["fixture-device-client", "fixture-ios-client"],
    deviceAuthorizedParties: [
      "fixture-device-client",
      "fixture-ios-client",
      "fixture-android-client",
    ],
    currentOwner: (account) => (account === current?.accountId ? current : undefined),
  };
  const broker = new GoogleBrowserBroker(configuration);
  function request(
    purpose: GoogleBrowserPurpose = "owner-link",
    overrides: Partial<GoogleBrowserUnsignedStart> = {},
  ) {
    const secret = randomBytes(32).toString("base64url");
    const issuedAt = Math.floor(Date.now() / 1000);
    const unsigned: GoogleBrowserUnsignedStart = {
      protocol: GOOGLE_BROWSER_PROTOCOL,
      operationId: randomUUID(),
      purpose,
      nonce:
        purpose === "owner-link"
          ? gatewayBindingNonce(owner)
          : randomBytes(32).toString("base64url"),
      callbackUrl: "https://direct.example.test" + googleBrowserCallbackPath(purpose),
      browserState: randomBytes(32).toString("base64url"),
      redemptionSha256: createHash("sha256").update(secret).digest("hex"),
      issuedAt,
      expiresAt: issuedAt + 300,
      ...overrides,
    };
    const input = {
      ...unsigned,
      ownerSignature: sign(
        null,
        googleBrowserStartTranscript(owner, unsigned),
        f.owner.privateKey,
      ).toString("base64url"),
    };
    return { input, secret };
  }
  function providerCallback(authorizeUrl: string) {
    const authorize = new URL(authorizeUrl),
      code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: authorize.searchParams.get("client_id")!,
      nonce: authorize.searchParams.get("nonce")!,
      challenge: authorize.searchParams.get("code_challenge")!,
      redirectUri: authorize.searchParams.get("redirect_uri")!,
    });
    const callback = new URL(GOOGLE_BROWSER_PATH + "/callback", origin);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", code);
    return callback;
  }
  function launch(target = broker, purpose: GoogleBrowserPurpose = "owner-link") {
    const pending = request(purpose),
      started = target.start(owner, pending.input),
      url = new URL(started.authorizeUrl);
    const launched = target.launch(pending.input.operationId, url.searchParams.get("ticket")!);
    return { ...pending, started, launched, callback: providerCallback(launched.authorizeUrl) };
  }
  return {
    ...f,
    ownerKeys: f.owner,
    owner,
    broker,
    configuration,
    issuer,
    exchange,
    token,
    request,
    providerCallback,
    launch,
    setCurrent(value: GoogleBrowserOwnerAuthorization | undefined) {
      current = value;
    },
  };
}
