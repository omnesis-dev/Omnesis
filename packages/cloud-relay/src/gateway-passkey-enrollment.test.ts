// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  enrollmentNonce,
  enrollmentSignatureTranscript,
  gatewayPasskeyChallenge,
  passkeyProofChallenge,
  signDeviceTranscript,
} from "./device-enrollment.js";
import { EnrollmentChallenges } from "./enrollment-challenges.js";
import { GatewaySignInVerifier } from "./gateway-sign-in-proof.js";
import { GooglePairingRequests, type GatewayEnrollment } from "./google-pairing.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { accountId } from "./identity.js";

const RELAY = "https://relay.example.test";
const GATEWAY = `https://${hostedGatewayHostname(randomUUID(), "relay.example.test")}`;
const SPKI = "a".repeat(64);
const OWNER = accountId({
  issuer: `${RELAY}/_relay/account`,
  subject: "c".repeat(64),
  expiresAt: 1,
});
const opaque = () => randomBytes(32).toString("base64url");

function setup(options: { key?: "trusted" | "listed" | "none"; origin?: string | undefined } = {}) {
  const owner = passkeyAuthenticator();
  const verifier = new GatewaySignInVerifier({
    google: () => undefined,
    relayOrigin: () => RELAY,
    passkeyOrigins: () => [],
    trusted: () => [],
    gatewayOrigin: () => ("origin" in options ? options.origin : GATEWAY),
  });
  const key = options.key ?? "trusted";
  const attest = vi.fn(async () => {
    throw new Error("the relay is not asked");
  });
  const enrollment: GatewayEnrollment = {
    policy: () => "automatic",
    spkiFingerprint: () => SPKI,
    challenges: new EnrollmentChallenges(),
    verifyProof: vi.fn(async () => undefined),
    canTrust: vi.fn(async () => key === "listed"),
    trustSignIn: vi.fn(async () => undefined),
    // As GatewayAccountLink decides it: a confirmed or pinned key is trusted, a listed one is not.
    verifyGatewayPasskey: async (proof, challenge, nonce) => {
      if (key === "none") return undefined;
      const verified = await verifier.verifyGatewayPasskey(proof, {
        purpose: "device-enrollment",
        challenge,
        binding: nonce,
        key: (id) => (id === owner.id ? { publicKey: owner.publicKey, counter: 0 } : undefined),
      });
      return verified
        ? {
            type: "passkey",
            id: verified.id,
            trusted: key === "trusted",
            channel: verified.channel,
            pin: { type: "passkey", id: verified.id, publicKey: verified.publicKey, addedAt: 1 },
          }
        : undefined;
    },
    gatewayPasskey: () =>
      ("origin" in options ? options.origin : GATEWAY)
        ? { rpId: "relay.example.test", origin: options.origin ?? GATEWAY }
        : undefined,
  };
  const createPairing = vi.fn(async (request: { expiresAt: number }) => ({
    pairingCode: "fictional-pairing-code",
    expiresAt: request.expiresAt,
  }));
  const requests = new GooglePairingRequests({
    identity: { verify: attest },
    ownerAccountId: OWNER,
    gatewayFingerprint: () => "d".repeat(64),
    enrollment,
    createPairing,
  });
  return { requests, owner, createPairing, attest, enrollment };
}

function device() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const value = {
    requestId: randomUUID(),
    kind: "portal" as const,
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
  };
  return {
    value,
    publicKey,
    nonce: enrollmentNonce({ ...value, devicePublicKey: publicKey }),
    deviceKey: (challenge: string) => ({
      publicKey,
      challenge,
      signature: signDeviceTranscript(
        pair.privateKey,
        enrollmentSignatureTranscript({
          ...value,
          gatewaySpkiFingerprint: SPKI,
          challenge,
          devicePublicKey: publicKey,
        }),
      ),
    }),
  };
}

/** What a portal on the gateway's page sends: options, then its request with the assertion. */
function signIn(
  f: ReturnType<typeof setup>,
  d: ReturnType<typeof device>,
  options: { from?: string } = {},
) {
  const ceremony = f.requests.passkeyCeremony({ ...d.value, devicePublicKey: d.publicKey });
  const from = options.from ?? ceremony.origin;
  return {
    ceremony,
    body: {
      ...d.value,
      deviceKey: d.deviceKey(ceremony.challenge),
      proof: {
        type: "gateway-passkey" as const,
        challenge: ceremony.challenge,
        credential: f.owner.authentication(
          gatewayPasskeyChallenge("device-enrollment", from, ceremony.challenge, d.nonce),
          "dXNlcg",
          0,
          from,
        ),
      },
    },
  };
}

describe("a device signs in with a passkey on the gateway's own page", () => {
  test("the gateway hands out the ceremony for this request, bound to its enrollment nonce", () => {
    const f = setup(),
      d = device();
    const { ceremony } = signIn(f, d);
    expect(ceremony).toEqual({
      purpose: "device-enrollment",
      rpId: "relay.example.test",
      origin: GATEWAY,
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      binding: d.nonce,
      webauthnChallenge: gatewayPasskeyChallenge(
        "device-enrollment",
        GATEWAY,
        ceremony.challenge,
        d.nonce,
      ),
      expiresAt: expect.any(Number),
    });
    expect(f.requests.gatewayPasskey()).toEqual({ rpId: "relay.example.test", origin: GATEWAY });
    expect(() => f.requests.passkeyCeremony({ ...d.value })).toThrow();
  });

  test("a trusted passkey joins at once, and the relay is never asked", async () => {
    const f = setup(),
      d = device();
    const result = await f.requests.start(signIn(f, d).body);
    expect(result.status).toBe("approved");
    expect(f.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        enrollment: expect.objectContaining({ method: "automatic", signIn: "passkey" }),
      }),
    );
    expect(f.attest).not.toHaveBeenCalled();
  });

  test("a passkey the account lists but the gateway does not trust is held for a person, without the relay's word", async () => {
    const f = setup({ key: "listed" }),
      d = device();
    const result = await f.requests.start(signIn(f, d).body);
    expect(result.status).toBe("pending");
    expect(f.attest).not.toHaveBeenCalled();
    expect(f.requests.list()).toEqual([
      expect.objectContaining({
        requestId: d.value.requestId,
        signIn: "passkey",
        canTrustSignIn: true,
      }),
    ]);
  });

  test("TM-01: an assertion steered by a relay page, or that does not verify, is refused outright", async () => {
    for (const [f, from] of [
      [setup(), RELAY],
      [setup(), `https://${hostedGatewayHostname(randomUUID(), "relay.example.test")}`],
      [setup({ key: "none" }), undefined],
    ] as const) {
      const d = device();
      await expect(f.requests.start(signIn(f, d, from ? { from } : {}).body)).rejects.toMatchObject(
        {
          status: 401,
        },
      );
      expect(f.requests.list()).toEqual([]);
      expect(f.createPairing).not.toHaveBeenCalled();
    }
  });

  test("TM-03: the assertion answers this request's one-use challenge; nothing can be prepared ahead", async () => {
    const f = setup(),
      d = device();
    const { body } = signIn(f, d);
    // A proof naming a challenge other than the one the request answers is refused, and so is a
    // request answering a challenge the gateway never issued (the relay making one up for later).
    const other = f.requests.issueChallenge().challenge;
    await expect(
      f.requests.start({ ...body, deviceKey: d.deviceKey(other) }),
    ).rejects.toMatchObject({ status: 403 });
    const madeUp = opaque();
    await expect(
      f.requests.start({
        ...body,
        requestId: randomUUID(),
        deviceKey: d.deviceKey(madeUp),
        proof: { ...body.proof, challenge: madeUp },
      }),
    ).rejects.toMatchObject({ status: 409 });
    // A relay-era proof with a far-future time is not a gateway passkey proof at all.
    await expect(
      f.requests.start({
        ...body,
        proof: {
          ...body.proof,
          issuedAt: String(Math.floor(Date.now() / 1000) + 30 * 86400),
          salt: opaque(),
        },
      }),
    ).rejects.toThrow();
    // Spent: the same assertion can't be sent again.
    const fresh = signIn(f, device());
    await f.requests.start(fresh.body);
    await expect(
      f.requests.start({ ...fresh.body, requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("a gateway with no origin of its own offers no ceremony, and a request needs its device key", async () => {
    const f = setup({ origin: undefined }),
      d = device();
    expect(f.requests.gatewayPasskey()).toBeUndefined();
    expect(() => f.requests.passkeyCeremony({ ...d.value, devicePublicKey: d.publicKey })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    const g = setup();
    const { body } = signIn(g, d);
    const { deviceKey: _key, ...keyless } = body;
    await expect(
      g.requests.start({ ...keyless, challenge: body.proof.challenge }),
    ).rejects.toMatchObject({ status: 403 });
    // An enrollment that can't verify gateway passkeys refuses them.
    const h = setup();
    delete h.enrollment.verifyGatewayPasskey;
    await expect(h.requests.start(signIn(h, device()).body)).rejects.toMatchObject({ status: 401 });
    // Without enrollment support at all there is nothing to offer.
    const bare = new GooglePairingRequests({
      identity: { verify: vi.fn() },
      ownerAccountId: OWNER,
      gatewayFingerprint: () => "d".repeat(64),
      createPairing: vi.fn(),
    });
    expect(bare.gatewayPasskey()).toBeUndefined();
    void passkeyProofChallenge;
  });
});
