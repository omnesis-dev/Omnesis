// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  gatewayPasskeyApprovalBinding,
  gatewayPasskeyChallenge,
  gatewayPasskeyPinBinding,
  gatewayPasskeySignInProofSchema,
  gatewayPasskeyStepUpBinding,
  googleProofNonce,
  passkeyProofChallenge,
  signInProofSchema,
  type GatewayPasskeyPurpose,
} from "./device-enrollment.js";
import {
  GATEWAY_PASSKEY_CHALLENGE_TTL_MS,
  GatewayPasskeyCeremonies,
} from "./gateway-passkey-ceremonies.js";
import {
  confirmedSignInSchema,
  GatewaySignInVerifier,
  type GatewayPasskeyKey,
  type SignInVerifierOptions,
} from "./gateway-sign-in-proof.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { googleIdentityProvider } from "./identity.js";

const RELAY = "https://relay.example.test";
const GATEWAY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GATEWAY = `https://${hostedGatewayHostname(GATEWAY_ID, "relay.example.test")}`;
const OTHER_GATEWAY = `https://${hostedGatewayHostname(randomUUID(), "relay.example.test")}`;
const ANDROID = `android:apk-key-hash:${randomBytes(32).toString("base64url")}`;
const VECTOR_ORIGIN = "https://g-abcdefgh.relay.example.test";
const VECTOR_CHALLENGE = "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw";
const VECTOR_DEVICE_KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGDyDirEL2lrGjSPy-YBjzDVmi8d4E-aXEboSjkFDnKjznab2Nbec2vu4J71RIvZmTL820xIfaxzOyXItT91cdQ";
const opaque = () => randomBytes(32).toString("base64url");

/**
 * Cross-platform vectors for `gateway-passkey`. The portal, iOS and Android reproduce these
 * functions; a change here must be made everywhere they do.
 */
describe("gateway passkey vectors", () => {
  test("each purpose's challenge names the purpose, the origin, the gateway value and the binding", () => {
    expect(
      gatewayPasskeyChallenge(
        "device-enrollment",
        VECTOR_ORIGIN,
        VECTOR_CHALLENGE,
        "omSCKSEVp23kSohLBrNIqacoYRMiGzYGcjIUhbS6Utw",
      ),
    ).toBe("N54-1Hc8nIzZyGGjgVB2es2v2ut0AeLrQLlHiV9NaXM");
    const approval = gatewayPasskeyApprovalBinding({
      requestId: "11111111-2222-4333-8444-555555555555",
      devicePublicKey: VECTOR_DEVICE_KEY,
      verificationCode: "123 456",
    });
    expect(approval).toBe("l0NtUMoLWQPEqbViKuTTcNl21YlGfRT9uywbHtmcvzg");
    expect(
      gatewayPasskeyApprovalBinding({
        requestId: "11111111-2222-4333-8444-555555555555",
        verificationCode: "123 456",
      }),
    ).toBe("pHSUrE_J7X5Z1pGhVpl7D-9FnTvxNzSa1y8pvgcauMk");
    expect(
      gatewayPasskeyChallenge("approve-request", VECTOR_ORIGIN, VECTOR_CHALLENGE, approval),
    ).toBe("s4TEruSndQL9XUX4vOZB8gLvPAjWmLWDn4hs6rqiev8");
    const pin = gatewayPasskeyPinBinding({
      gatewayId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      accountId: "a".repeat(64),
    });
    expect(pin).toBe("EAANDVb7NFK6CvK8jvrrt_qCOpVZtuhWoCGrICUHhsM");
    expect(gatewayPasskeyChallenge("pin-passkey", VECTOR_ORIGIN, VECTOR_CHALLENGE, pin)).toBe(
      "mofVzFt_O3rjnPh-MGYHJ_17o3SpvObuqvY5jOi1uX4",
    );
    const stepUp = gatewayPasskeyStepUpBinding({
      method: "post",
      path: "/admin/devices/pair",
      bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      deviceId: "device-1",
    });
    expect(stepUp).toBe("wAjeH2mnCBFwRS4nJrk5RaSmRfbLwLkGbSi1aF5o9bg");
    expect(gatewayPasskeyChallenge("step-up", VECTOR_ORIGIN, VECTOR_CHALLENGE, stepUp)).toBe(
      "uGxFctH1-FqRi73bqDy4iwjDPFJHx37qF8RGHMyJfnU",
    );
  });

  test("malformed parts are refused rather than hashed", () => {
    expect(() =>
      gatewayPasskeyChallenge("other" as GatewayPasskeyPurpose, GATEWAY, VECTOR_CHALLENGE, "x"),
    ).toThrow();
    expect(() => gatewayPasskeyChallenge("step-up", GATEWAY, "short", "x")).toThrow();
    expect(() =>
      gatewayPasskeyApprovalBinding({ requestId: randomUUID(), verificationCode: "123456" }),
    ).toThrow();
    expect(() =>
      gatewayPasskeyStepUpBinding({ method: "GET", path: "/", bodySha256: "x", deviceId: "d" }),
    ).toThrow();
  });

  test("a gateway passkey proof has its own shape and is no relay sign-in proof", () => {
    const authenticator = passkeyAuthenticator();
    const proof = {
      type: "gateway-passkey",
      challenge: opaque(),
      credential: authenticator.authentication(opaque(), "dXNlcg"),
    };
    expect(gatewayPasskeySignInProofSchema.safeParse(proof).success).toBe(true);
    expect(signInProofSchema.safeParse(proof).success).toBe(false);
    // It carries no time and no key of its own: nothing the relay could choose.
    for (const extra of [
      { issuedAt: "1794240000" },
      { salt: opaque() },
      { credentialPublicKey: "x" },
    ])
      expect(gatewayPasskeySignInProofSchema.safeParse({ ...proof, ...extra }).success).toBe(false);
  });
});

function verifier(options: Partial<SignInVerifierOptions> = {}) {
  return new GatewaySignInVerifier({
    google: () => undefined,
    relayOrigin: () => RELAY,
    passkeyOrigins: () => [ANDROID],
    trusted: () => [],
    gatewayOrigin: () => GATEWAY,
    ...options,
  });
}

function ceremony(
  authenticator: ReturnType<typeof passkeyAuthenticator>,
  options: {
    purpose?: GatewayPasskeyPurpose;
    origin?: string;
    counter?: number;
    key?: GatewayPasskeyKey | undefined;
    challengeOrigin?: string;
    /** Signed client data fields, as a browser reports them inside a cross-site frame. */
    clientData?: Record<string, unknown>;
  } = {},
) {
  const purpose = options.purpose ?? "pin-passkey";
  const challenge = opaque(),
    binding = opaque();
  const origin = options.origin ?? GATEWAY;
  const credential = authenticator.authentication(
    gatewayPasskeyChallenge(purpose, options.challengeOrigin ?? origin, challenge, binding),
    "dXNlcg",
    options.counter ?? 0,
    origin,
    0x1d,
    options.clientData ?? {},
  );
  const key = "key" in options ? options.key : { publicKey: authenticator.publicKey, counter: 0 };
  return {
    proof: { type: "gateway-passkey" as const, challenge, credential },
    input: {
      purpose,
      challenge,
      binding,
      key: (id: string) => (id === authenticator.id ? key : undefined),
    },
  };
}

describe("gateway passkey verification", () => {
  test("an assertion made on this gateway's own origin verifies against the key the gateway chose", async () => {
    const authenticator = passkeyAuthenticator();
    const { proof, input } = ceremony(authenticator, { counter: 7 });
    expect(await verifier().verifyGatewayPasskey(proof, input)).toEqual({
      id: authenticator.id,
      publicKey: authenticator.publicKey,
      counter: 7,
      channel: "gateway-origin",
    });
  });

  test("an assertion from the official Android app verifies as made in the app", async () => {
    const authenticator = passkeyAuthenticator();
    const { proof, input } = ceremony(authenticator, { origin: ANDROID });
    expect(await verifier().verifyGatewayPasskey(proof, input)).toMatchObject({
      channel: "android-app",
    });
    // Without an origin of its own (a custom domain), only the app can make one.
    const app = ceremony(authenticator, { origin: ANDROID });
    expect(
      await verifier({ gatewayOrigin: () => undefined }).verifyGatewayPasskey(app.proof, app.input),
    ).toMatchObject({ channel: "android-app" });
    const page = ceremony(authenticator);
    expect(
      await verifier({ gatewayOrigin: () => undefined }).verifyGatewayPasskey(
        page.proof,
        page.input,
      ),
    ).toBeUndefined();
  });

  test("a relay page, another gateway's page or an unlisted app can't make one", async () => {
    const authenticator = passkeyAuthenticator();
    for (const origin of [
      RELAY,
      OTHER_GATEWAY,
      "https://evil.example.test",
      `android:apk-key-hash:${opaque()}`,
    ]) {
      const { proof, input } = ceremony(authenticator, { origin });
      expect(await verifier().verifyGatewayPasskey(proof, input)).toBeUndefined();
    }
    // Nor by naming this gateway in the challenge while the browser was elsewhere.
    const named = ceremony(authenticator, { origin: OTHER_GATEWAY, challengeOrigin: GATEWAY });
    expect(await verifier().verifyGatewayPasskey(named.proof, named.input)).toBeUndefined();
  });

  test("an assertion made inside another site's frame is refused", async () => {
    const authenticator = passkeyAuthenticator();
    for (const clientData of [{ crossOrigin: true }, { topOrigin: "https://evil.example.test" }]) {
      const { proof, input } = ceremony(authenticator, { clientData });
      expect(await verifier().verifyGatewayPasskey(proof, input)).toBeUndefined();
    }
    for (const text of ["not json", "null", "1"]) {
      const garbled = ceremony(authenticator);
      garbled.proof.credential.response.clientDataJSON = Buffer.from(text).toString("base64url");
      expect(await verifier().verifyGatewayPasskey(garbled.proof, garbled.input)).toBeUndefined();
    }
  });

  test("the purpose, the gateway's value and the binding must all be the ones it was made for", async () => {
    const authenticator = passkeyAuthenticator();
    const base = ceremony(authenticator);
    for (const changed of [
      { ...base.input, purpose: "step-up" as const },
      { ...base.input, binding: opaque() },
    ])
      expect(await verifier().verifyGatewayPasskey(base.proof, changed)).toBeUndefined();
    // A proof naming another challenge than the one being spent is refused before any check.
    expect(
      await verifier().verifyGatewayPasskey(
        { ...base.proof, challenge: opaque() },
        { ...base.input },
      ),
    ).toBeUndefined();
    expect(await verifier().verifyGatewayPasskey({ type: "passkey" }, base.input)).toBeUndefined();
  });

  test("only a key the gateway holds is used; an assertion can't bring its own", async () => {
    const authenticator = passkeyAuthenticator();
    const unknown = ceremony(authenticator, { key: undefined });
    expect(await verifier().verifyGatewayPasskey(unknown.proof, unknown.input)).toBeUndefined();
    const other = passkeyAuthenticator();
    const wrong = ceremony(authenticator, { key: { publicKey: other.publicKey, counter: 0 } });
    expect(await verifier().verifyGatewayPasskey(wrong.proof, wrong.input)).toBeUndefined();
  });

  test("a signature counter that does not move forward is refused", async () => {
    const authenticator = passkeyAuthenticator();
    const replay = ceremony(authenticator, {
      counter: 5,
      key: { publicKey: authenticator.publicKey, counter: 5 },
    });
    expect(await verifier().verifyGatewayPasskey(replay.proof, replay.input)).toBeUndefined();
    const forward = ceremony(authenticator, {
      counter: 6,
      key: { publicKey: authenticator.publicKey, counter: 5 },
    });
    expect(await verifier().verifyGatewayPasskey(forward.proof, forward.input)).toMatchObject({
      counter: 6,
    });
    // Passkeys that never count (most synced ones) keep presenting 0.
    const synced = ceremony(authenticator, { counter: 0 });
    expect(await verifier().verifyGatewayPasskey(synced.proof, synced.input)).toMatchObject({
      counter: 0,
    });
  });

  test("a confirmed sign-in records how it was confirmed and its counter", () => {
    const passkey = {
      type: "passkey",
      id: "abc",
      publicKey: "def",
      counter: 0,
      at: 1,
      via: "gateway-origin",
    };
    expect(confirmedSignInSchema.safeParse(passkey).success).toBe(true);
    expect(confirmedSignInSchema.safeParse({ ...passkey, counter: -1 }).success).toBe(false);
    expect(confirmedSignInSchema.safeParse({ ...passkey, via: "link-page" }).success).toBe(false);
    expect(
      confirmedSignInSchema.safeParse({
        type: "google",
        id: "a".repeat(64),
        at: 1,
        via: "native-google-approval",
      }).success,
    ).toBe(true);
  });
});

describe("where a relay-challenge sign-in was made", () => {
  test("a passkey assertion is from a relay page unless an official app origin made it", async () => {
    const authenticator = passkeyAuthenticator();
    const pinned = [
      {
        type: "passkey" as const,
        id: authenticator.id,
        publicKey: authenticator.publicKey,
        addedAt: 1,
        source: "link-page" as const,
      },
    ];
    const nonce = opaque();
    const proof = (origin: string, extra: Record<string, unknown> = {}) => {
      const salt = opaque(),
        issuedAt = String(Math.floor(Date.now() / 1000));
      return {
        type: "passkey" as const,
        salt,
        issuedAt,
        credential: authenticator.authentication(
          passkeyProofChallenge(salt, issuedAt, nonce),
          "dXNlcg",
          0,
          origin,
          0x1d,
          extra,
        ),
      };
    };
    const check = verifier({ trusted: () => pinned });
    expect(await check.verify(proof(RELAY), "device-enrollment", nonce)).toMatchObject({
      trusted: true,
      channel: "relay-page",
    });
    expect(await check.verify(proof(ANDROID), "device-enrollment", nonce)).toMatchObject({
      trusted: true,
      channel: "android-app",
    });
    // A relay page framed by another site is refused outright.
    expect(
      await check.verify(proof(RELAY, { crossOrigin: true }), "device-enrollment", nonce),
    ).toBeUndefined();
  });

  test("a registration made in the app is classified as the app's", async () => {
    const authenticator = passkeyAuthenticator();
    const nonce = opaque(),
      salt = opaque(),
      issuedAt = String(Math.floor(Date.now() / 1000));
    const registration = (origin: string) => ({
      type: "passkey-registration" as const,
      salt,
      issuedAt,
      credential: authenticator.registration(passkeyProofChallenge(salt, issuedAt, nonce), origin),
    });
    expect(
      await verifier().verify(registration(ANDROID), "device-enrollment", nonce),
    ).toMatchObject({
      channel: "android-app",
      trusted: false,
    });
    expect(await verifier().verify(registration(RELAY), "device-enrollment", nonce)).toMatchObject({
      channel: "relay-page",
    });
  });
});

describe("native Google sign-ins", () => {
  const WEB = "web-client.apps.googleusercontent.com",
    IOS = "ios-client.apps.googleusercontent.com",
    ANDROID_CLIENT = "android-client.apps.googleusercontent.com",
    UNKNOWN = "unknown-type.apps.googleusercontent.com";
  let key: CryptoKey;
  let keys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    key = pair.privateKey as CryptoKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "1", alg: "RS256" };
    keys = createLocalJWKSet({ keys: [jwk] });
  });
  const token = (nonce: string, aud: string | string[], azp?: string) => {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ nonce, ...(azp ? { azp } : {}) })
      .setProtectedHeader({ alg: "RS256", kid: "1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(aud)
      .setSubject("google-subject")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
  };
  const classify = async (
    aud: string | string[],
    azp: string | undefined,
    clients: { ios: string[]; android: string[] } | null = {
      ios: [IOS],
      android: [ANDROID_CLIENT],
    },
  ) => {
    const nonce = opaque(),
      salt = opaque();
    const check = verifier({
      google: () =>
        googleIdentityProvider([WEB, IOS, UNKNOWN], keys, {
          authorizedParties: [WEB, IOS, UNKNOWN, ANDROID_CLIENT],
        }),
      ...(clients === null ? {} : { nativeGoogleClients: () => clients }),
    });
    const verified = await check.verify(
      { type: "google", salt, idToken: await token(googleProofNonce(salt, nonce), aud, azp) },
      "device-enrollment",
      nonce,
    );
    return verified?.channel;
  };

  test("the Android app's token is for the web client and presented by the Android client", async () => {
    expect(await classify(WEB, ANDROID_CLIENT)).toBe("native-google");
  });
  test("the iOS app's token is for and presented by the iOS client", async () => {
    expect(await classify(IOS, IOS)).toBe("native-google");
    expect(await classify([IOS, WEB], IOS)).toBe("native-google");
  });
  test("a web token, a token without a presenter or one from a client of unknown type is not native", async () => {
    expect(await classify(WEB, WEB)).toBe("web-google");
    expect(await classify(IOS, undefined)).toBe("web-google");
    expect(await classify(UNKNOWN, UNKNOWN)).toBe("web-google");
    // The iOS client presenting a token for another audience is not the iOS app's sign-in.
    expect(await classify(WEB, IOS)).toBe("web-google");
    // Without a registry nothing is native.
    expect(await classify(WEB, ANDROID_CLIENT, null)).toBe("web-google");
  });
});

describe("gateway passkey challenges", () => {
  test("a challenge is spent once, for its purpose and binding only, while it lives", () => {
    let now = 1_000_000;
    const store = new GatewayPasskeyCeremonies(() => now);
    const first = store.issue("pin-passkey", "binding");
    expect(first.expiresAt).toBe(now + GATEWAY_PASSKEY_CHALLENGE_TTL_MS);
    expect(store.take("pin-passkey", first.challenge, "binding")).toBe(true);
    expect(store.take("pin-passkey", first.challenge, "binding")).toBe(false);
    // Using it for anything else spends it too, so a wrong guess costs the attempt.
    const second = store.issue("approve-request", "binding");
    expect(store.take("step-up", second.challenge, "binding")).toBe(false);
    expect(store.take("approve-request", second.challenge, "binding")).toBe(false);
    const third = store.issue("approve-request", "binding");
    expect(store.take("approve-request", third.challenge, "other")).toBe(false);
    const late = store.issue("step-up", "binding");
    now += GATEWAY_PASSKEY_CHALLENGE_TTL_MS;
    expect(store.take("step-up", late.challenge, "binding")).toBe(false);
    expect(store.take("step-up", opaque(), "binding")).toBe(false);
  });

  test("outstanding challenges are bounded and expired ones are pruned", () => {
    let now = 0;
    const store = new GatewayPasskeyCeremonies(() => now, 2);
    const oldest = store.issue("step-up", "a");
    const kept = store.issue("step-up", "b");
    const newest = store.issue("step-up", "c");
    expect(store.take("step-up", oldest.challenge, "a")).toBe(false);
    expect(store.take("step-up", kept.challenge, "b")).toBe(true);
    now += GATEWAY_PASSKEY_CHALLENGE_TTL_MS + 1;
    store.issue("step-up", "d");
    expect(store.take("step-up", newest.challenge, "c")).toBe(false);
    const fallback = new GatewayPasskeyCeremonies();
    const issued = fallback.issue("pin-passkey", "x");
    vi.useFakeTimers({ now: issued.expiresAt });
    expect(fallback.take("pin-passkey", issued.challenge, "x")).toBe(false);
    vi.useRealTimers();
  });
});
