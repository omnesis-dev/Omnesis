// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  enrollmentNonce,
  enrollmentSignatureTranscript,
  googleProofNonce,
  passkeyProofChallenge,
  signDeviceTranscript,
  type SignInProof,
} from "./device-enrollment.js";
import { EnrollmentChallenges } from "./enrollment-challenges.js";
import {
  GatewaySignInVerifier,
  SIGN_IN_PROOF_MAX_AGE_SECONDS,
  type TrustedSignIn,
} from "./gateway-sign-in-proof.js";
import {
  googlePairingNonce,
  GooglePairingRequests,
  type EnrollmentPolicy,
  type GatewayEnrollment,
} from "./google-pairing.js";
import { accountId, googleIdentityProvider, type IdentityProvider } from "./identity.js";

const AUDIENCE = "client.example.apps.googleusercontent.com";
const RELAY = "https://relay.example.test";
const GATEWAY_SPKI = "a".repeat(64);
const ATTACKER_SPKI = "b".repeat(64);
const SUBJECT = "google-subject-1";
const OWNER = accountId({
  issuer: `${RELAY}/_relay/account`,
  subject: "c".repeat(64),
  expiresAt: 1,
});
const SIGN_IN_DIGEST = accountId({
  issuer: "https://accounts.google.com",
  subject: SUBJECT,
  expiresAt: 1,
});

let googleKey: CryptoKey;
let googleKeys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  googleKey = pair.privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "1", alg: "RS256" };
  googleKeys = createLocalJWKSet({ keys: [jwk] });
});

const googleToken = (
  nonce: string,
  options: { subject?: string; audience?: string; issuedAt?: number; key?: CryptoKey } = {},
) => {
  const iat = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: "RS256", kid: "1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(options.subject ?? SUBJECT)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(options.key ?? googleKey);
};

function makeDevice() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
}
function makeRequest(devicePublicKey: string, kind: "ios" | "collector" = "ios") {
  const value = {
    requestId: randomUUID(),
    kind,
    name: "fictional test phone",
    secret: randomBytes(32).toString("hex"),
    devicePublicKey,
  };
  return { value, nonce: enrollmentNonce(value) };
}

function setup(
  options: {
    policy?: EnrollmentPolicy;
    pins?: TrustedSignIn[];
    attest?: IdentityProvider["verify"];
    spki?: string;
    onVerify?: () => void;
    /** The relay's passkey list for the account; undefined means it can't be read. */
    relayPasskeys?: Array<{ id: string; publicKey: string }>;
  } = {},
) {
  const pins: TrustedSignIn[] = options.pins ?? [
    { type: "google", id: SIGN_IN_DIGEST, addedAt: 1, source: "link-page" },
  ];
  const challenges = new EnrollmentChallenges();
  const verifier = new GatewaySignInVerifier({
    google: () => googleIdentityProvider(AUDIENCE, googleKeys, { authorizedParties: [AUDIENCE] }),
    relayOrigin: () => RELAY,
    passkeyOrigins: () => [],
    trusted: () => pins,
  });
  const policy = { current: options.policy ?? ("automatic" as EnrollmentPolicy) };
  const enrollment: GatewayEnrollment = {
    policy: () => policy.current,
    spkiFingerprint: () => options.spki ?? GATEWAY_SPKI,
    challenges,
    verifyProof: async (proof, nonce, key) => {
      options.onVerify?.();
      return verifier.verify(proof, nonce, key);
    },
    // As GatewayAccountLink decides it: Google by its signature, a passkey only as the relay lists it.
    canTrust: async (signIn) =>
      !signIn.trusted &&
      (signIn.pin.type === "google" ||
        (options.relayPasskeys?.some(
          (listed) =>
            signIn.pin.type === "passkey" &&
            listed.id === signIn.pin.id &&
            listed.publicKey === signIn.pin.publicKey,
        ) ??
          false)),
    trustSignIn: async (signIn, source) => {
      pins.push({ ...signIn.pin, source });
    },
  };
  const createPairing = vi.fn(async (request: { expiresAt: number }) => ({
    pairingCode: "fictional-pairing-code",
    expiresAt: request.expiresAt,
  }));
  const onPending = vi.fn();
  const verify =
    options.attest ??
    vi.fn(async () => {
      throw new Error("attestation refused");
    });
  const requests = new GooglePairingRequests({
    identity: { verify },
    ownerAccountId: OWNER,
    gatewayFingerprint: () => "d".repeat(64),
    enrollment,
    createPairing,
    onPending,
  });
  return { requests, createPairing, onPending, policy, challenges, pins, verify };
}

/** What an honest device sends after signing for the certificate it was shown. */
function evidence(
  device: ReturnType<typeof makeDevice>,
  request: ReturnType<typeof makeRequest>,
  challenge: string,
  spki = GATEWAY_SPKI,
) {
  return {
    publicKey: device.publicKey,
    challenge,
    signature: signDeviceTranscript(
      device.privateKey,
      enrollmentSignatureTranscript({
        requestId: request.value.requestId,
        kind: request.value.kind,
        name: request.value.name,
        gatewaySpkiFingerprint: spki,
        challenge,
        devicePublicKey: device.publicKey,
      }),
    ),
  };
}
const body = (request: ReturnType<typeof makeRequest>) => {
  const { devicePublicKey: _omit, ...value } = request.value;
  return value;
};
async function googleProof(nonce: string, subject?: string): Promise<SignInProof> {
  const salt = randomBytes(32).toString("base64url");
  return {
    type: "google",
    salt,
    idToken: await googleToken(googleProofNonce(salt, nonce), subject ? { subject } : {}),
  };
}

describe("joining without a person", () => {
  test("a trusted, device-bound Google sign-in joins immediately", async () => {
    const { requests, createPairing, onPending } = setup();
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const result = await requests.start({
      ...body(request),
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: await googleProof(request.nonce),
    });
    expect(result.status).toBe("approved");
    expect(result.pairingCode).toBe("fictional-pairing-code");
    expect(onPending).not.toHaveBeenCalled();
    expect(createPairing.mock.calls[0]![0]).toMatchObject({
      enrollment: { method: "automatic", signIn: "google", devicePublicKey: device.publicKey },
    });
  });

  test("Ask me first holds a perfect proof", async () => {
    const attest = vi.fn(async () => ({
      issuer: `${RELAY}/_relay/account`,
      subject: "c".repeat(64),
      expiresAt: 1,
    }));
    const { requests, createPairing, onPending } = setup({ policy: "ask", attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const result = await requests.start({
      ...body(request),
      identityToken: "attestation",
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: await googleProof(request.nonce),
    });
    expect(result.status).toBe("pending");
    expect(createPairing).not.toHaveBeenCalled();
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledWith("attestation", request.nonce);
  });

  test("a device that asks for approval is held even with a trusted sign-in", async () => {
    const attest = vi.fn(async () => ({
      issuer: `${RELAY}/_relay/account`,
      subject: "c".repeat(64),
      expiresAt: 1,
    }));
    const { requests } = setup({ attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const result = await requests.start({
      ...body(request),
      identityToken: "attestation",
      requireApproval: true,
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: await googleProof(request.nonce),
    });
    expect(result.status).toBe("pending");
  });

  test("the setting is read when the request arrives", async () => {
    const { requests, policy, createPairing } = setup({ policy: "ask" });
    policy.current = "automatic";
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    await requests.start({
      ...body(request),
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: await googleProof(request.nonce),
    });
    expect(createPairing).toHaveBeenCalledTimes(1);
  });
});

describe("timing", () => {
  test("a request that expires while its proof is checked never joins", async () => {
    const { requests, createPairing } = setup({
      onVerify: () => vi.setSystemTime(Date.now() + 601_000),
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const device = makeDevice(),
        request = makeRequest(device.publicKey);
      const deviceKey = evidence(device, request, requests.issueChallenge().challenge);
      const proof = await googleProof(request.nonce);
      await expect(requests.start({ ...body(request), deviceKey, proof })).rejects.toThrow(
        "expired",
      );
      expect(createPairing).not.toHaveBeenCalled();
      expect(requests.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what a compromised relay can try", () => {
  test("its own attestation only ever produces a held request", async () => {
    // The relay holds this signing key, so it can make this call succeed for any account.
    const attest = vi.fn(async () => ({
      issuer: `${RELAY}/_relay/account`,
      subject: "c".repeat(64),
      expiresAt: 1,
    }));
    const { requests, createPairing } = setup({ attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const result = await requests.start({
      ...body(request),
      identityToken: "forged-by-relay",
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
    });
    expect(result.status).toBe("pending");
    expect(result.pairingCode).toBeUndefined();
    expect(createPairing).not.toHaveBeenCalled();
  });

  test("a forged Google token signed by another key does not join", async () => {
    const attest = vi.fn(async () => ({
      issuer: `${RELAY}/_relay/account`,
      subject: "c".repeat(64),
      expiresAt: 1,
    }));
    const { requests, createPairing } = setup({ attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const salt = randomBytes(32).toString("base64url");
    const attacker = await generateKeyPair("RS256");
    const result = await requests.start({
      ...body(request),
      identityToken: "forged-by-relay",
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: {
        type: "google",
        salt,
        idToken: await googleToken(googleProofNonce(salt, request.nonce), {
          key: attacker.privateKey as CryptoKey,
        }),
      },
    });
    expect(result.status).toBe("pending");
    expect(createPairing).not.toHaveBeenCalled();
  });

  test("forwarding a request signed for a swapped certificate is refused outright", async () => {
    const attest = vi.fn(async () => ({
      issuer: `${RELAY}/_relay/account`,
      subject: "c".repeat(64),
      expiresAt: 1,
    }));
    const { requests, createPairing, onPending } = setup({ attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    await expect(
      requests.start({
        ...body(request),
        identityToken: "attestation",
        deviceKey: evidence(device, request, requests.issueChallenge().challenge, ATTACKER_SPKI),
        proof: await googleProof(request.nonce),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(createPairing).not.toHaveBeenCalled();
    expect(onPending).not.toHaveBeenCalled();
  });

  test("substituting its own device key breaks the proof's commitment", async () => {
    const { requests, createPairing } = setup();
    const victim = makeDevice(),
      attacker = makeDevice();
    const victimRequest = makeRequest(victim.publicKey);
    const captured = await googleProof(victimRequest.nonce);
    const attackerRequest = {
      value: { ...victimRequest.value, devicePublicKey: attacker.publicKey },
      nonce: victimRequest.nonce,
    };
    await expect(
      requests.start({
        ...body(attackerRequest),
        deviceKey: evidence(attacker, attackerRequest, requests.issueChallenge().challenge),
        proof: captured,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(createPairing).not.toHaveBeenCalled();
  });

  test("replaying a captured request fails on its spent challenge", async () => {
    const { requests } = setup();
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const deviceKey = evidence(device, request, requests.issueChallenge().challenge);
    const proof = await googleProof(request.nonce);
    await requests.start({ ...body(request), deviceKey, proof });
    const again = { ...request.value, requestId: randomUUID() };
    const { devicePublicKey: _omit, ...replayed } = again;
    await expect(requests.start({ ...replayed, deviceKey, proof })).rejects.toMatchObject({
      status: 409,
    });
  });

  test("a made-up challenge is refused", async () => {
    const { requests } = setup();
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    await expect(
      requests.start({
        ...body(request),
        deviceKey: evidence(device, request, randomBytes(32).toString("base64url")),
        proof: await googleProof(request.nonce),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("a gateway with no public key available refuses instead of skipping the check", async () => {
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const refuse = new GooglePairingRequests({
      identity: { verify: async () => ({ issuer: "x", subject: "y", expiresAt: 1 }) },
      ownerAccountId: OWNER,
      gatewayFingerprint: () => "d".repeat(64),
      enrollment: {
        policy: () => "automatic",
        spkiFingerprint: () => undefined,
        challenges: new EnrollmentChallenges(),
        verifyProof: async () => undefined,
        canTrust: async () => false,
        trustSignIn: async () => {},
      },
      createPairing: async (value) => ({ pairingCode: "x", expiresAt: value.expiresAt }),
    });
    await expect(
      refuse.start({
        ...body(request),
        deviceKey: evidence(device, request, refuse.issueChallenge().challenge),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("falling back to a person", () => {
  const attest = async () => ({
    issuer: `${RELAY}/_relay/account`,
    subject: "c".repeat(64),
    expiresAt: 1,
  });

  test("a verified sign-in the gateway doesn't know is held and can be trusted on approval", async () => {
    const { requests, pins, createPairing } = setup({ pins: [], attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const result = await requests.start({
      ...body(request),
      identityToken: "attestation",
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: await googleProof(request.nonce),
    });
    expect(result.status).toBe("pending");
    expect(requests.list()[0]).toMatchObject({ signIn: "google", canTrustSignIn: true });
    await requests.decide(request.value.requestId, true, { trustSignIn: true });
    // An iPhone's sign-in happened in the app, which computed its own nonce.
    expect(pins).toMatchObject([{ type: "google", id: SIGN_IN_DIGEST, source: "native-app" }]);
    expect(createPairing.mock.calls[0]![0]).toMatchObject({ enrollment: { method: "approved" } });
    expect(requests.poll(request.value.requestId, request.value.secret).status).toBe("approved");
  });

  test("approving without ticking trust pins nothing", async () => {
    const { requests, pins } = setup({ pins: [], attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    await requests.start({
      ...body(request),
      identityToken: "attestation",
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      proof: await googleProof(request.nonce),
    });
    await requests.decide(request.value.requestId, true);
    expect(pins).toEqual([]);
  });

  test("no sign-in and no attestation is refused", async () => {
    const { requests } = setup();
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    await expect(
      requests.start({
        ...body(request),
        deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("a request without a device key stays on the original path", async () => {
    const verify = vi.fn(attest);
    const { requests, createPairing } = setup({ attest: verify });
    const value = {
      requestId: randomUUID(),
      kind: "ios" as const,
      name: "fictional test phone",
      secret: randomBytes(32).toString("hex"),
    };
    const result = await requests.start({
      ...value,
      identityToken: "attestation",
      challenge: requests.issueChallenge().challenge,
    });
    expect(result.status).toBe("pending");
    expect(verify).toHaveBeenCalledWith("attestation", googlePairingNonce(value));
    await requests.decide(value.requestId, true);
    expect(createPairing.mock.calls[0]![0]).not.toHaveProperty("enrollment");
  });

  test("a browser's held sign-in joins once its page signs", async () => {
    const { requests, createPairing } = setup();
    const device = makeDevice(),
      request = makeRequest(device.publicKey, "ios");
    requests.holdProof(request.value.requestId, {
      identityToken: "attestation",
      proof: await googleProof(request.nonce),
    });
    const result = await requests.start({
      ...body(request),
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
    });
    expect(result.status).toBe("approved");
    expect(createPairing).toHaveBeenCalledTimes(1);
  });

  test("held sign-ins are bounded, expire, and belong to one request", async () => {
    const { requests, createPairing } = setup({ attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey, "ios");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      requests.holdProof(request.value.requestId, {
        identityToken: "attestation",
        proof: await googleProof(request.nonce),
      });
      // Thirty-two later redirects push the first one out.
      for (let index = 0; index < 32; index++)
        requests.holdProof(randomUUID(), { identityToken: "attestation" });
      // Without its held proof the request only reaches a person.
      const evicted = await requests.start({
        ...body(request),
        identityToken: "attestation",
        deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      });
      expect(evicted.status).toBe("pending");
      const late = makeRequest(device.publicKey, "ios");
      requests.holdProof(late.value.requestId, {
        identityToken: "attestation",
        proof: await googleProof(late.nonce),
      });
      vi.setSystemTime(Date.now() + 600_001);
      const expired = await requests.start({
        ...body(late),
        identityToken: "attestation",
        deviceKey: evidence(device, late, requests.issueChallenge().challenge),
      });
      expect(expired.status).toBe("pending");
      expect(createPairing).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a signed device without a sign-in proof is held and records a person's approval", async () => {
    const { requests, createPairing } = setup({ attest });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    const result = await requests.start({
      ...body(request),
      identityToken: "attestation",
      deviceKey: evidence(device, request, requests.issueChallenge().challenge),
    });
    expect(result.status).toBe("pending");
    expect(requests.list()[0]).toMatchObject({ canTrustSignIn: false });
    expect(requests.list()[0]).not.toHaveProperty("signIn");
    await requests.decide(request.value.requestId, true, { trustSignIn: true });
    expect(createPairing.mock.calls[0]![0]).toMatchObject({
      enrollment: { method: "approved", devicePublicKey: device.publicKey },
    });
    expect(
      (createPairing.mock.calls[0]![0] as { enrollment?: object }).enrollment,
    ).not.toHaveProperty("signIn");
  });

  test("a gateway without sign-in enrollment refuses device keys but still issues challenges", async () => {
    const requests = new GooglePairingRequests({
      identity: { verify: attest },
      ownerAccountId: OWNER,
      gatewayFingerprint: () => "d".repeat(64),
      createPairing: async () => ({ pairingCode: "code", expiresAt: Date.now() + 60_000 }),
    });
    const device = makeDevice(),
      request = makeRequest(device.publicKey);
    await expect(
      requests.start({
        ...body(request),
        identityToken: "attestation",
        deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      }),
    ).rejects.toThrow("unavailable");
    // A request names its challenge once: beside a device key it is refused before any work.
    await expect(
      requests.start({
        ...body(request),
        identityToken: "attestation",
        challenge: requests.issueChallenge().challenge,
        deviceKey: evidence(device, request, requests.issueChallenge().challenge),
      }),
    ).rejects.toThrow("one challenge");
  });
});

describe("Google proofs", () => {
  const verifier = (pins: TrustedSignIn[] = []) =>
    new GatewaySignInVerifier({
      google: () => googleIdentityProvider(AUDIENCE, googleKeys, { authorizedParties: [AUDIENCE] }),
      relayOrigin: () => RELAY,
      passkeyOrigins: () => [],
      trusted: () => pins,
    });
  const nonce = randomBytes(32).toString("base64url");
  const salt = randomBytes(32).toString("base64url");

  test("an old token is refused", async () => {
    const stale = await googleToken(googleProofNonce(salt, nonce), {
      issuedAt: Math.floor(Date.now() / 1000) - SIGN_IN_PROOF_MAX_AGE_SECONDS - 5,
    });
    expect(
      await verifier().verify({ type: "google", salt, idToken: stale }, nonce),
    ).toBeUndefined();
  });
  test("another audience is refused", async () => {
    const token = await googleToken(googleProofNonce(salt, nonce), { audience: "other" });
    expect(
      await verifier().verify({ type: "google", salt, idToken: token }, nonce),
    ).toBeUndefined();
  });
  test("another nonce is refused", async () => {
    const token = await googleToken(googleProofNonce(salt, "x".repeat(43)));
    expect(
      await verifier().verify({ type: "google", salt, idToken: token }, nonce),
    ).toBeUndefined();
  });
  test("no configured audience means no Google proof can verify", async () => {
    const none = new GatewaySignInVerifier({
      google: () => undefined,
      relayOrigin: () => RELAY,
      passkeyOrigins: () => [],
      trusted: () => [],
    });
    const token = await googleToken(googleProofNonce(salt, nonce));
    expect(await none.verify({ type: "google", salt, idToken: token }, nonce)).toBeUndefined();
  });
  test("only a pinned subject is trusted", async () => {
    const token = await googleToken(googleProofNonce(salt, nonce));
    const unknown = await verifier().verify({ type: "google", salt, idToken: token }, nonce);
    expect(unknown).toMatchObject({ trusted: false, id: SIGN_IN_DIGEST });
    const known = await verifier([
      { type: "google", id: SIGN_IN_DIGEST, addedAt: 1, source: "link-page" },
    ]).verify({ type: "google", salt, idToken: token }, nonce);
    expect(known?.trusted).toBe(true);
  });
  test("a malformed proof is unverifiable, not an error", async () => {
    expect(await verifier().verify({ type: "relay" }, nonce)).toBeUndefined();
  });
});

describe("passkey proofs", () => {
  const rpId = new URL(RELAY).hostname;
  const authenticator = () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const x = Buffer.from(jwk.x!, "base64url"),
      y = Buffer.from(jwk.y!, "base64url");
    // COSE: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    const cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ]);
    return { privateKey: pair.privateKey, publicKey: cose.toString("base64url") };
  };
  const assertion = (
    key: ReturnType<typeof authenticator>,
    challenge: string,
    options: { origin?: string; rp?: string; flags?: number } = {},
  ) => {
    const id = "Y3JlZGVudGlhbC1pZA";
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: options.origin ?? RELAY,
        crossOrigin: false,
      }),
    );
    const authData = Buffer.concat([
      createHash("sha256")
        .update(options.rp ?? rpId)
        .digest(),
      Buffer.from([options.flags ?? 0x05, 0, 0, 0, 0]),
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
      key.privateKey,
    );
    return {
      id,
      rawId: id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: "dXNlcg",
      },
    };
  };
  const nonce = randomBytes(32).toString("base64url");
  const salt = randomBytes(32).toString("base64url");
  const now = () => String(Math.floor(Date.now() / 1000));
  const verifier = (pins: TrustedSignIn[]) =>
    new GatewaySignInVerifier({
      google: () => undefined,
      relayOrigin: () => RELAY,
      passkeyOrigins: () => [],
      trusted: () => pins,
    });
  const pinFor = (key: ReturnType<typeof authenticator>): TrustedSignIn => ({
    type: "passkey",
    id: "Y3JlZGVudGlhbC1pZA",
    publicKey: key.publicKey,
    addedAt: 1,
    source: "link-page",
  });

  describe("trust on approval", () => {
    const attest = async () => ({
      issuer: `${RELAY}/_relay/account`,
      subject: "c".repeat(64),
      expiresAt: 1,
    });
    /** A held collector request signed in with `key`, whose public key travels in the request body. */
    async function held(
      key: ReturnType<typeof authenticator>,
      relayPasskeys?: Array<{ id: string; publicKey: string }>,
      canTrust?: () => Promise<boolean>,
    ) {
      const f = setup({ pins: [], attest, relayPasskeys });
      if (canTrust)
        vi.spyOn(f.requests["options"].enrollment!, "canTrust").mockImplementation(canTrust);
      const device = makeDevice(),
        request = makeRequest(device.publicKey, "collector"),
        issuedAt = now();
      const result = await f.requests.start({
        ...body(request),
        identityToken: "attestation",
        deviceKey: evidence(device, request, f.requests.issueChallenge().challenge),
        proof: {
          type: "passkey",
          salt,
          issuedAt,
          credentialPublicKey: key.publicKey,
          credential: assertion(key, passkeyProofChallenge(salt, issuedAt, request.nonce)),
        },
      });
      expect(result.status).toBe("pending");
      return { ...f, request };
    }

    test("a self-made passkey verifies and holds the request, but can't be trusted or pinned", async () => {
      const forged = authenticator();
      const f = await held(forged, []);
      expect(f.requests.list()[0]).toMatchObject({ signIn: "passkey", canTrustSignIn: false });
      await f.requests.decide(f.request.value.requestId, true, { trustSignIn: true });
      expect(f.pins).toEqual([]);
      expect(f.createPairing.mock.calls[0]![0]).toMatchObject({
        enrollment: { method: "approved", signIn: "passkey" },
      });
    });

    test("the relay must list the credential id with the same key, and an unreadable list trusts nothing", async () => {
      const key = authenticator(),
        other = authenticator();
      const id = "Y3JlZGVudGlhbC1pZA";
      for (const relayPasskeys of [[{ id, publicKey: other.publicKey }], undefined]) {
        const f = await held(key, relayPasskeys);
        expect(f.requests.list()[0]).toMatchObject({ canTrustSignIn: false });
      }
      const failing = await held(key, [{ id, publicKey: key.publicKey }], async () => {
        throw new Error("relay unavailable");
      });
      expect(failing.requests.list()[0]).toMatchObject({ canTrustSignIn: false });
      const listed = await held(key, [{ id, publicKey: key.publicKey }]);
      expect(listed.requests.list()[0]).toMatchObject({ canTrustSignIn: true });
      await listed.requests.decide(listed.request.value.requestId, true, { trustSignIn: true });
      // A collector's sign-in happened on a relay page.
      expect(listed.pins).toEqual([
        {
          type: "passkey",
          id,
          publicKey: key.publicKey,
          addedAt: expect.any(Number),
          source: "approval",
        },
      ]);
    });
  });

  test("a pinned passkey's assertion is trusted", async () => {
    const key = authenticator(),
      issuedAt = now();
    const result = await verifier([pinFor(key)]).verify(
      {
        type: "passkey",
        salt,
        issuedAt,
        credential: assertion(key, passkeyProofChallenge(salt, issuedAt, nonce)),
      },
      nonce,
    );
    expect(result).toMatchObject({ type: "passkey", trusted: true });
  });

  test("a relay can't substitute a key for a pinned credential", async () => {
    const real = authenticator(),
      fake = authenticator(),
      issuedAt = now();
    const result = await verifier([pinFor(real)]).verify(
      {
        type: "passkey",
        salt,
        issuedAt,
        credentialPublicKey: fake.publicKey,
        credential: assertion(fake, passkeyProofChallenge(salt, issuedAt, nonce)),
      },
      nonce,
      fake.publicKey,
    );
    expect(result).toBeUndefined();
  });

  test("an unknown passkey verifies under its offered key but is never trusted", async () => {
    const key = authenticator(),
      issuedAt = now();
    const result = await verifier([]).verify(
      {
        type: "passkey",
        salt,
        issuedAt,
        credentialPublicKey: key.publicKey,
        credential: assertion(key, passkeyProofChallenge(salt, issuedAt, nonce)),
      },
      nonce,
    );
    expect(result).toMatchObject({ trusted: false });
    expect(result?.pin).toMatchObject({ type: "passkey", publicKey: key.publicKey });
  });

  test.each<[string, { challenge?: boolean; origin?: string; rp?: string; flags?: number }]>([
    ["a challenge for another device key", { challenge: true }],
    ["another origin", { origin: "https://phish.example.test" }],
    ["another relying party", { rp: "phish.example.test" }],
    ["no user verification", { flags: 0x01 }],
  ])("refuses %s", async (_name, { challenge: otherKey, ...options }) => {
    const key = authenticator(),
      issuedAt = now();
    const challenge = otherKey
      ? passkeyProofChallenge(salt, issuedAt, "z".repeat(43))
      : passkeyProofChallenge(salt, issuedAt, nonce);
    const result = await verifier([pinFor(key)]).verify(
      { type: "passkey", salt, issuedAt, credential: assertion(key, challenge, options) },
      nonce,
    );
    expect(result).toBeUndefined();
  });

  test("refuses an old or future-dated proof, and one with no key at all", async () => {
    const key = authenticator();
    const stale = String(Math.floor(Date.now() / 1000) - SIGN_IN_PROOF_MAX_AGE_SECONDS - 5);
    expect(
      await verifier([pinFor(key)]).verify(
        {
          type: "passkey",
          salt,
          issuedAt: stale,
          credential: assertion(key, passkeyProofChallenge(salt, stale, nonce)),
        },
        nonce,
      ),
    ).toBeUndefined();
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    expect(
      await verifier([pinFor(key)]).verify(
        {
          type: "passkey",
          salt,
          issuedAt: future,
          credential: assertion(key, passkeyProofChallenge(salt, future, nonce)),
        },
        nonce,
      ),
    ).toBeUndefined();
    const issuedAt = now();
    expect(
      await verifier([]).verify(
        {
          type: "passkey",
          salt,
          issuedAt,
          credential: assertion(key, passkeyProofChallenge(salt, issuedAt, nonce)),
        },
        nonce,
      ),
    ).toBeUndefined();
  });

  test("a new account's first passkey registration verifies but is never trusted", async () => {
    const device = passkeyAuthenticator(rpId),
      issuedAt = now();
    const registration = (
      at: string,
      challenge = passkeyProofChallenge(salt, at, nonce),
      format: "none" | "invalid-self" = "none",
    ) => ({
      type: "passkey-registration" as const,
      salt,
      issuedAt: at,
      credential: device.registration(challenge, RELAY, 0x5d, format),
    });
    const result = await verifier([]).verify(registration(issuedAt), nonce);
    expect(result).toMatchObject({
      type: "passkey",
      id: device.id,
      trusted: false,
      pin: { type: "passkey", id: device.id, publicKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/) },
    });
    // A pinned registration still vouches for nothing: registration carries no signature.
    expect(
      await verifier([{ ...result!.pin, source: "link-page" }]).verify(
        registration(issuedAt),
        nonce,
      ),
    ).toMatchObject({
      trusted: false,
    });
    const stale = String(Math.floor(Date.now() / 1000) - SIGN_IN_PROOF_MAX_AGE_SECONDS - 5);
    expect(await verifier([]).verify(registration(stale), nonce)).toBeUndefined();
    expect(
      await verifier([]).verify(
        registration(issuedAt, passkeyProofChallenge(salt, issuedAt, "z".repeat(43))),
        nonce,
      ),
    ).toBeUndefined();
    expect(
      await verifier([]).verify(
        registration(issuedAt, passkeyProofChallenge(salt, issuedAt, nonce), "invalid-self"),
        nonce,
      ),
    ).toBeUndefined();
  });
});

describe("challenges", () => {
  test("are single use, expire and stay bounded", () => {
    let now = 1000;
    const challenges = new EnrollmentChallenges(() => now, 2);
    const first = challenges.issue();
    expect(challenges.consume(first.challenge)).toBe(true);
    expect(challenges.consume(first.challenge)).toBe(false);
    const second = challenges.issue();
    now += 120_001;
    expect(challenges.consume(second.challenge)).toBe(false);
    const a = challenges.issue(),
      b = challenges.issue(),
      c = challenges.issue();
    expect(challenges.consume(a.challenge)).toBe(false);
    expect(challenges.consume(b.challenge)).toBe(true);
    expect(challenges.consume(c.challenge)).toBe(true);
    challenges.issue();
    now += 120_001;
    challenges.issue();
  });
});
