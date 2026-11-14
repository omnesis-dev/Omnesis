// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  approvalDeviceTranscript,
  enrollmentNonce,
  enrollmentSignatureTranscript,
  gatewayPasskeyApprovalBinding,
  gatewayPasskeyChallenge,
  passkeyProofChallenge,
  signDeviceTranscript,
} from "./device-enrollment.js";
import { EnrollmentChallenges } from "./enrollment-challenges.js";
import { GatewayPasskeyCeremonies } from "./gateway-passkey-ceremonies.js";
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
/** An official Android app's origin, as `OFFICIAL_ANDROID_PASSKEY_ORIGINS` compiles them in. */
const ANDROID = `android:apk-key-hash:${opaque()}`;

function setup(
  options: {
    key?: "trusted" | "listed" | "none";
    origin?: string | undefined;
    revoked?: boolean;
  } = {},
) {
  const owner = passkeyAuthenticator();
  const verifier = new GatewaySignInVerifier({
    google: () => undefined,
    relayOrigin: () => RELAY,
    passkeyOrigins: () => [ANDROID],
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
    ...(options.revoked ? { revokedDeviceKey: () => true } : {}),
  });
  return { requests, owner, createPairing, attest, enrollment };
}

function device(kind: "portal" | "cli" = "portal") {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const value = {
    requestId: randomUUID(),
    kind,
    name: "Fictional browser",
    secret: randomBytes(32).toString("hex"),
  };
  return {
    value,
    publicKey,
    nonce: enrollmentNonce({ ...value, devicePublicKey: publicKey }),
    approvalSignature: (challenge: string) =>
      signDeviceTranscript(pair.privateKey, approvalDeviceTranscript({ ...value, challenge })),
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

  // The app in android/core-pairing (GatewayPasskeySigner) relies on this: it asks for the
  // request's `/challenge` with an empty body, so the gateway commits to its code nonce before it
  // learns the request's secret, and signs that value in the app with its own origin.
  test("the Android app answers its request's own /challenge, signed in the app, also without an origin of its own", async () => {
    for (const origin of [GATEWAY, undefined]) {
      const f = setup({ origin }),
        d = device("cli");
      const challenge = f.requests.issueChallenge().challenge;
      const result = await f.requests.start({
        ...d.value,
        deviceKey: d.deviceKey(challenge),
        proof: {
          type: "gateway-passkey",
          challenge,
          credential: f.owner.authentication(
            gatewayPasskeyChallenge("device-enrollment", ANDROID, challenge, d.nonce),
            "dXNlcg",
            0,
            ANDROID,
          ),
        },
      });
      expect(result.status).toBe("approved");
      expect(f.attest).not.toHaveBeenCalled();
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

describe("a person approves a held request with a passkey on the gateway's own page", () => {
  /** A gateway holding requests, whose owner confirmed `owner` here. */
  function approving(kind: "portal" | "cli" = "cli", revoked = false) {
    const f = setup({ key: "listed", revoked });
    const ceremonies = new GatewayPasskeyCeremonies();
    const verifier = new GatewaySignInVerifier({
      google: () => undefined,
      relayOrigin: () => RELAY,
      passkeyOrigins: () => [],
      trusted: () => [],
      gatewayOrigin: () => GATEWAY,
    });
    f.enrollment.approvalCeremony = (binding) => {
      const issued = ceremonies.issue("approve-request", binding);
      return {
        purpose: "approve-request",
        rpId: "relay.example.test",
        origin: GATEWAY,
        challenge: issued.challenge,
        binding,
        webauthnChallenge: gatewayPasskeyChallenge(
          "approve-request",
          GATEWAY,
          issued.challenge,
          binding,
        ),
        expiresAt: issued.expiresAt,
      };
    };
    f.enrollment.verifyApproval = async (proof, binding) => {
      const parsed = proof as { challenge: string };
      if (!ceremonies.take("approve-request", parsed.challenge, binding)) return false;
      return Boolean(
        await verifier.verifyGatewayPasskey(proof, {
          purpose: "approve-request",
          challenge: parsed.challenge,
          binding,
          key: (id) =>
            id === f.owner.id ? { publicKey: f.owner.publicKey, counter: 0 } : undefined,
        }),
      );
    };
    return { ...f, d: device(kind), ceremonies };
  }
  async function hold(f: ReturnType<typeof approving>) {
    const ceremony = f.requests.passkeyCeremony({ ...f.d.value, devicePublicKey: f.d.publicKey });
    const result = await f.requests.start({
      ...f.d.value,
      deviceKey: {
        ...f.d.deviceKey(ceremony.challenge),
      },
      proof: {
        type: "gateway-passkey",
        challenge: ceremony.challenge,
        credential: f.owner.authentication(ceremony.webauthnChallenge, "dXNlcg", 0, GATEWAY),
      },
    });
    expect(result.status).toBe("pending");
    return result;
  }
  const approve = (
    f: ReturnType<typeof approving>,
    ceremony: { challenge: string; webauthnChallenge: string },
    extra: Record<string, unknown> = {},
    from = GATEWAY,
    authenticator = f.owner,
  ) =>
    f.requests.approveWithPasskey({
      requestId: f.d.value.requestId,
      proof: {
        type: "gateway-passkey",
        challenge: ceremony.challenge,
        credential: authenticator.authentication(ceremony.webauthnChallenge, "dXNlcg", 0, from),
      },
      ...extra,
    });

  test("a device the owner revoked waits even with a passkey, and the page says it was revoked", async () => {
    const f = approving("cli", true);
    await hold(f);
    expect(f.requests.approvalView(f.d.value.requestId)).toMatchObject({ revokedDevice: true });
    await approve(f, f.requests.approvalCeremony(f.d.value.requestId));
    expect(f.createPairing).toHaveBeenCalledOnce();
  });

  test("the page shows the request, and a confirmed passkey approves exactly it", async () => {
    const f = approving();
    const held = await hold(f);
    expect(f.requests.approvalView(f.d.value.requestId)).toEqual({
      requestId: f.d.value.requestId,
      kind: "cli",
      name: "Fictional browser",
      verificationCode: held.verificationCode,
      createdAt: expect.any(Number),
      expiresAt: held.expiresAt,
      signIn: "passkey",
      deviceKeyRequired: false,
    });
    const ceremony = f.requests.approvalCeremony(f.d.value.requestId);
    expect(ceremony.binding).toBe(
      gatewayPasskeyApprovalBinding({
        requestId: f.d.value.requestId,
        devicePublicKey: f.d.publicKey,
        verificationCode: held.verificationCode,
      }),
    );
    await approve(f, ceremony, { trustSignIn: true });
    expect(f.requests.poll(f.d.value.requestId, f.d.value.secret)).toMatchObject({
      status: "approved",
      pairingCode: "fictional-pairing-code",
    });
    expect(f.enrollment.trustSignIn).toHaveBeenCalledOnce();
    expect(f.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({ enrollment: expect.objectContaining({ method: "approved" }) }),
    );
    // Decided: nothing left to show or approve.
    expect(() => f.requests.approvalView(f.d.value.requestId)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  test("TM-01 (approval): a passkey the owner didn't confirm, a relay page or a spent challenge approves nothing", async () => {
    const f = approving();
    await hold(f);
    const stranger = passkeyAuthenticator();
    for (const [from, authenticator] of [
      [GATEWAY, stranger],
      [RELAY, f.owner],
    ] as const)
      await expect(
        approve(f, f.requests.approvalCeremony(f.d.value.requestId), {}, from, authenticator),
      ).rejects.toMatchObject({ status: 403 });
    const ceremony = f.requests.approvalCeremony(f.d.value.requestId);
    await expect(approve(f, { ...ceremony, challenge: opaque() })).rejects.toMatchObject({
      status: 403,
    });
    // That attempt named another challenge, so this one is still unspent and approves.
    await approve(f, ceremony);
    expect(f.requests.poll(f.d.value.requestId, f.d.value.secret).status).toBe("approved");
  });

  test("a portal's request is approved only by the browser that asked, with its own device key", async () => {
    const f = approving("portal");
    await hold(f);
    expect(f.requests.approvalView(f.d.value.requestId)).toMatchObject({ deviceKeyRequired: true });
    const ceremony = () => f.requests.approvalCeremony(f.d.value.requestId);
    // Without the requesting browser's signature, or with another key's, it is refused.
    await expect(approve(f, ceremony())).rejects.toMatchObject({ status: 403 });
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const first = ceremony();
    await expect(
      approve(f, first, {
        deviceSignature: signDeviceTranscript(
          other.privateKey,
          approvalDeviceTranscript({ requestId: f.d.value.requestId, challenge: first.challenge }),
        ),
      }),
    ).rejects.toMatchObject({ status: 403 });
    const own = ceremony();
    await approve(f, own, { deviceSignature: f.d.approvalSignature(own.challenge) });
    expect(f.requests.poll(f.d.value.requestId, f.d.value.secret).status).toBe("approved");
  });

  test("a request held on the relay's word alone, with no device key, is shown without a sign-in", async () => {
    const binding = vi.fn(() => undefined);
    const requests = new GooglePairingRequests({
      identity: {
        verify: async () => ({
          issuer: `${RELAY}/_relay/account`,
          subject: "c".repeat(64),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        }),
      },
      ownerAccountId: OWNER,
      gatewayFingerprint: () => "d".repeat(64),
      enrollment: { ...setup().enrollment, approvalCeremony: binding },
      createPairing: vi.fn(),
    });
    const value = {
      requestId: randomUUID(),
      kind: "ios" as const,
      name: "Fictional phone",
      secret: randomBytes(32).toString("hex"),
    };
    await requests.start({
      ...value,
      identityToken: "fictional-attestation",
      challenge: requests.issueChallenge().challenge,
    });
    const view = requests.approvalView(value.requestId);
    expect(view).not.toHaveProperty("signIn");
    expect(() => requests.approvalCeremony(value.requestId)).toThrow();
    expect(binding).toHaveBeenCalledWith(
      gatewayPasskeyApprovalBinding({
        requestId: value.requestId,
        verificationCode: view.verificationCode,
      }),
    );
  });

  test("nothing to approve, or no passkey approval on this gateway, is a plain refusal", async () => {
    const f = approving();
    expect(() => f.requests.approvalView(randomUUID())).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    await hold(f);
    expect(() => f.requests.approvalView("not-a-request")).toThrow();
    delete f.enrollment.approvalCeremony;
    expect(() => f.requests.approvalCeremony(f.d.value.requestId)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    delete f.enrollment.verifyApproval;
    await expect(
      approve(f, { challenge: opaque(), webauthnChallenge: opaque() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.requests.approveWithPasskey({ requestId: f.d.value.requestId }),
    ).rejects.toThrow();
  });
});
