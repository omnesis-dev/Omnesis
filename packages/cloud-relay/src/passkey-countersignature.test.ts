// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  passkeyCountersignatureNonce,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  signInDigest,
  type AccountSignIn,
  type PasskeyCountersignature,
  type SignInProof,
} from "./device-enrollment.js";
import { GatewaySignInVerifier, type TrustedSignIn } from "./gateway-sign-in-proof.js";

const RELAY = "https://relay.example.test";
const DAY = 86_400;
const opaque = () => randomBytes(32).toString("base64url");
const seconds = () => Math.floor(Date.now() / 1000);
const accountA = "a".repeat(64),
  accountB = "b".repeat(64);
const googleG: AccountSignIn = { type: "google", id: "1".repeat(64) },
  googleX: AccountSignIn = { type: "google", id: "2".repeat(64) };

const verifier = (now?: () => number) =>
  new GatewaySignInVerifier({
    google: () => undefined,
    relayOrigin: () => RELAY,
    passkeyOrigins: () => [],
    trusted: () => [],
    ...(now ? { now } : {}),
  });

/** A real passkey with the public key a gateway would pin for it. */
async function device(rpID?: string) {
  const authenticator = passkeyAuthenticator(rpID);
  const { publicKey } = authenticator;
  const pin: TrustedSignIn = {
    type: "passkey",
    id: authenticator.id,
    publicKey,
    addedAt: 1,
    source: "link-page",
  };
  const signIn: AccountSignIn = { type: "passkey", id: authenticator.id, publicKey };
  return { authenticator, id: authenticator.id, publicKey, pin, signIn };
}
type Device = Awaited<ReturnType<typeof device>>;

/** `by` signs, as the account page has it sign while it is being added, over `signIns`. */
function countersign(
  by: Device,
  signIns: readonly AccountSignIn[],
  options: {
    account?: string;
    issuedAt?: number;
    origin?: string;
    nonce?: string;
    flags?: number;
  } = {},
): PasskeyCountersignature {
  const salt = opaque(),
    issuedAt = String(options.issuedAt ?? seconds()),
    names = signIns.map(signInDigest);
  const nonce = options.nonce ?? passkeyCountersignatureNonce(options.account ?? accountA, names);
  return {
    proof: {
      type: "passkey",
      salt,
      issuedAt,
      credential: by.authenticator.authentication(
        passkeyProofChallenge(salt, issuedAt, nonce),
        "dXNlcg",
        0,
        options.origin ?? RELAY,
        options.flags,
      ) as Extract<SignInProof, { type: "passkey" }>["credential"],
    },
    signIns: names,
  };
}

describe("a gateway checking what a passkey countersigned", () => {
  test("a sign-in is named by a fixed-size digest, and the nonce names the account and the set in any order", async () => {
    const first = await device(),
      second = await device();
    // A digest is the same size whatever the passkey's id and key, and names exactly one sign-in.
    const long = { type: "passkey" as const, id: "A".repeat(1365), publicKey: "B".repeat(4000) };
    for (const signIn of [googleG, first.signIn, long])
      expect(signInDigest(signIn)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signInDigest(first.signIn)).not.toBe(
      signInDigest({ ...first.signIn, publicKey: second.publicKey }),
    );
    expect(signInDigest({ type: "google", id: first.id })).not.toBe(
      signInDigest({ type: "passkey", id: first.id, publicKey: "" }),
    );
    const names = [googleG, googleX, first.signIn, second.signIn].map(signInDigest);
    const nonce = passkeyCountersignatureNonce(accountA, names);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(passkeyCountersignatureNonce(accountA, [...names].reverse())).toBe(nonce);
    for (const other of [
      passkeyCountersignatureNonce(accountB, names),
      passkeyCountersignatureNonce(accountA, names.slice(1)),
      passkeyCountersignatureNonce(accountA, []),
      passkeyEndorsementNonce(first.id, first.publicKey),
    ])
      expect(other).not.toBe(nonce);
    // Fixed vectors, so the relay and every gateway keep computing the same values.
    expect(signInDigest(googleG)).toBe("U6QONhn8VCjl8e_PCqsgNpBes8I6kCS-GaT7obAEVp8");
    expect(signInDigest({ type: "passkey", id: "fixture-passkey", publicKey: "fixture-key" })).toBe(
      "SUlDh9HQ5mvCllv4A_iPMV06Q3ntemHLU0H4R0611Xo",
    );
    expect(passkeyCountersignatureNonce(accountA, [signInDigest(googleG)])).toBe(
      "71MuJh4se1uaB_iY7JQFMtGjav-Ok-24yk0TJ0wF4Zc",
    );
  });

  test("a pinned passkey's countersignature names the account's other sign-ins", async () => {
    const signer = await device(),
      other = await device();
    const names = [googleG, other.signIn].map(signInDigest);
    expect(
      await verifier().verifyCountersignature(
        countersign(signer, [googleG, other.signIn]),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toEqual(names);
    // An empty list is a valid statement that says nothing.
    expect(
      await verifier().verifyCountersignature(countersign(signer, []), signer, accountA, [
        signer.pin,
      ]),
    ).toEqual([]);
  });

  test("a relay that adds, drops or swaps a sign-in in the signed list gets nothing", async () => {
    const signer = await device(),
      other = await device(),
      intruder = await device();
    const genuine = countersign(signer, [googleG, other.signIn]);
    for (const signIns of [
      [...genuine.signIns, signInDigest(googleX)],
      [signInDigest(googleX), signInDigest(other.signIn)],
      [signInDigest(other.signIn)],
      [],
      [...genuine.signIns, signInDigest(intruder.signIn)],
      [signInDigest(googleG), signInDigest({ ...other.signIn, publicKey: intruder.publicKey })],
    ])
      expect(
        await verifier().verifyCountersignature({ ...genuine, signIns }, signer, accountA, [
          signer.pin,
        ]),
      ).toBeUndefined();
  });

  test("only the pinned passkey's own signature, under its pinned key, counts, for this account only", async () => {
    const signer = await device(),
      intruder = await device();
    const genuine = countersign(signer, [googleX]);
    // Its signer must be pinned here, with the very key that signed.
    expect(await verifier().verifyCountersignature(genuine, signer, accountA, [])).toBeUndefined();
    expect(
      await verifier().verifyCountersignature(genuine, signer, accountA, [intruder.pin]),
    ).toBeUndefined();
    expect(
      await verifier().verifyCountersignature(
        genuine,
        { id: signer.id, publicKey: intruder.publicKey },
        accountA,
        [{ ...signer.pin, publicKey: intruder.publicKey }],
      ),
    ).toBeUndefined();
    // Another passkey's signature labelled with the pinned passkey's id is refused, also when it
    // offers the key it was really made with: the pinned key is the only one ever used.
    const forged = countersign(intruder, [googleX]);
    forged.proof.credential = { ...forged.proof.credential, id: signer.id, rawId: signer.id };
    for (const proof of [
      forged.proof,
      { ...forged.proof, credentialPublicKey: intruder.publicKey },
    ])
      expect(
        await verifier().verifyCountersignature({ ...forged, proof }, signer, accountA, [
          signer.pin,
        ]),
      ).toBeUndefined();
    // A countersignature moved onto another listed passkey is not that passkey's.
    expect(
      await verifier().verifyCountersignature(genuine, intruder, accountA, [
        signer.pin,
        intruder.pin,
      ]),
    ).toBeUndefined();
    // One made for another account says nothing about this one, and the reverse.
    expect(
      await verifier().verifyCountersignature(genuine, signer, accountB, [signer.pin]),
    ).toBeUndefined();
    expect(
      await verifier().verifyCountersignature(
        countersign(signer, [googleX], { account: accountB }),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toBeUndefined();
  });

  test("a signature made elsewhere, for another relying party or without user verification counts for nothing", async () => {
    const signer = await device();
    // Made on another origin, it is not a sign-in at this relay.
    expect(
      await verifier().verifyCountersignature(
        countersign(signer, [googleG], { origin: "https://unrelated.example.test" }),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toBeUndefined();
    // The same key, scoped to another relying party.
    const elsewhere = await device("unrelated.example.test");
    expect(
      await verifier().verifyCountersignature(
        countersign(elsewhere, [googleG]),
        elsewhere,
        accountA,
        [elsewhere.pin],
      ),
    ).toBeUndefined();
    // Present but not verified: the user-verified flag (0x04) is clear.
    expect(
      await verifier().verifyCountersignature(
        countersign(signer, [googleG], { flags: 0x19 }),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toBeUndefined();
    // The same signature with the flag set verifies, so it is the flag that was refused.
    expect(
      await verifier().verifyCountersignature(
        countersign(signer, [googleG], { flags: 0x1d }),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toEqual([signInDigest(googleG)]);
  });

  test("no other signature stands in for one, and one stands in for nothing else", async () => {
    const signer = await device(),
      added = await device();
    // The same passkey's sign-in or endorsement signs another nonce, so it is no countersignature.
    for (const nonce of [opaque(), passkeyEndorsementNonce(added.id, added.publicKey)])
      expect(
        await verifier().verifyCountersignature(
          countersign(signer, [googleG], { nonce }),
          signer,
          accountA,
          [signer.pin],
        ),
      ).toBeUndefined();
    const genuine = countersign(signer, [googleG]);
    // Anything but a passkey's assertion is refused by its shape: a Google token names its own
    // subject, and anyone can make one that names a passkey they saw listed.
    for (const proof of [
      { type: "google", idToken: "fictional.google.token", salt: opaque() },
      {
        type: "passkey-registration",
        salt: genuine.proof.salt,
        issuedAt: genuine.proof.issuedAt,
        credential: signer.authenticator.registration("Y2hhbGxlbmdl"),
      },
    ])
      expect(
        await verifier().verifyCountersignature({ ...genuine, proof }, signer, accountA, [
          signer.pin,
        ]),
      ).toBeUndefined();
    for (const input of [
      undefined,
      null,
      "countersigned",
      { ...genuine, extra: true },
      { proof: genuine.proof, google: [googleG.id] },
      { ...genuine, signIns: ["not-a-digest"] },
    ])
      expect(
        await verifier().verifyCountersignature(input, signer, accountA, [signer.pin]),
      ).toBeUndefined();
    // A countersignature is no sign-in for a device, and vouches for no added passkey.
    expect(
      await verifier().verify(
        genuine.proof,
        "device-enrollment",
        passkeyCountersignatureNonce(accountA, genuine.signIns),
      ),
    ).toBeUndefined();
    expect(await verifier().verifyEndorsement(genuine.proof, added, [signer.pin])).toBe(false);
  });

  test("an old countersignature verifies as of when it was made, and a future-dated one never does", async () => {
    const signer = await device();
    const names = [signInDigest(googleG)];
    for (const age of [3600, 30 * DAY, 400 * DAY])
      expect(
        await verifier().verifyCountersignature(
          countersign(signer, [googleG], { issuedAt: seconds() - age }),
          signer,
          accountA,
          [signer.pin],
        ),
      ).toEqual(names);
    // A gateway that was offline for a month checks today's the same way.
    expect(
      await verifier(() => seconds() + 30 * DAY).verifyCountersignature(
        countersign(signer, [googleG]),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toEqual(names);
    for (const ahead of [120, DAY])
      expect(
        await verifier().verifyCountersignature(
          countersign(signer, [googleG], { issuedAt: seconds() + ahead }),
          signer,
          accountA,
          [signer.pin],
        ),
      ).toBeUndefined();
  });

  test("an endorsement's claimed signer is read without trusting it, and is never more than a claim", async () => {
    const signer = await device(),
      added = await device();
    const salt = opaque(),
      issuedAt = String(seconds());
    const passkeyEndorsement = {
      type: "passkey" as const,
      salt,
      issuedAt,
      credential: signer.authenticator.authentication(
        passkeyProofChallenge(salt, issuedAt, passkeyEndorsementNonce(added.id, added.publicKey)),
        "dXNlcg",
      ) as Extract<SignInProof, { type: "passkey" }>["credential"],
    };
    expect(verifier().endorsementSigner(passkeyEndorsement)).toEqual({
      type: "passkey",
      id: signer.id,
    });
    // An unsigned token names a subject the same way: the claim is only used to skip
    // verifying proofs whose claimed signer isn't pinned.
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      body = Buffer.from(JSON.stringify({ sub: "fictional-subject" })).toString("base64url");
    expect(
      verifier().endorsementSigner({ type: "google", idToken: `${header}.${body}.`, salt }),
    ).toMatchObject({ type: "google", id: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // A token that names no subject claims no signer.
    const unnamed = Buffer.from(JSON.stringify({ iss: "fictional" })).toString("base64url");
    expect(
      verifier().endorsementSigner({ type: "google", idToken: `${header}.${unnamed}.`, salt }),
    ).toBeUndefined();
    for (const input of [undefined, { type: "google", idToken: "x", salt }, { type: "relay" }])
      expect(verifier().endorsementSigner(input)).toBeUndefined();
  });
});
