// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  passkeyCountersignatureNonce,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  type CountersignedSignIns,
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
const googleG = "1".repeat(64),
  googleX = "2".repeat(64);

const verifier = (now?: () => number) =>
  new GatewaySignInVerifier({
    google: () => undefined,
    relayOrigin: () => RELAY,
    passkeyOrigins: () => [],
    trusted: () => [],
    ...(now ? { now } : {}),
  });

/** A real passkey with the public key a gateway would pin for it. */
async function device() {
  const authenticator = passkeyAuthenticator(),
    nonce = opaque(),
    salt = opaque(),
    issuedAt = String(seconds());
  const registered = await verifier().verify(
    {
      type: "passkey-registration",
      salt,
      issuedAt,
      credential: authenticator.registration(passkeyProofChallenge(salt, issuedAt, nonce)),
    },
    nonce,
  );
  const { publicKey } = registered!.pin as { publicKey: string };
  const pin: TrustedSignIn = {
    type: "passkey",
    id: authenticator.id,
    publicKey,
    addedAt: 1,
    source: "link-page",
  };
  return { authenticator, id: authenticator.id, publicKey, pin };
}
type Device = Awaited<ReturnType<typeof device>>;

/** `by` signs, as the account page has it sign while it is being added, over `signIns`. */
function countersign(
  by: Device,
  signIns: CountersignedSignIns,
  options: { account?: string; issuedAt?: number; origin?: string; nonce?: string } = {},
): PasskeyCountersignature {
  const salt = opaque(),
    issuedAt = String(options.issuedAt ?? seconds());
  const nonce = options.nonce ?? passkeyCountersignatureNonce(options.account ?? accountA, signIns);
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
      ) as Extract<SignInProof, { type: "passkey" }>["credential"],
    },
    google: [...signIns.google],
    passkeys: signIns.passkeys.map((passkey) => ({ ...passkey })),
  };
}

describe("a gateway checking what a passkey countersigned", () => {
  test("the nonce names the account and the sign-ins in any order, and nothing an endorsement names", async () => {
    const first = await device(),
      second = await device();
    const signIns = {
      google: [googleG, googleX],
      passkeys: [
        { id: first.id, publicKey: first.publicKey },
        { id: second.id, publicKey: second.publicKey },
      ],
    };
    const nonce = passkeyCountersignatureNonce(accountA, signIns);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      passkeyCountersignatureNonce(accountA, {
        google: [googleX, googleG],
        passkeys: [...signIns.passkeys].reverse(),
      }),
    ).toBe(nonce);
    for (const other of [
      passkeyCountersignatureNonce(accountB, signIns),
      passkeyCountersignatureNonce(accountA, { ...signIns, google: [googleG] }),
      passkeyCountersignatureNonce(accountA, { ...signIns, passkeys: [signIns.passkeys[0]!] }),
      passkeyCountersignatureNonce(accountA, {
        ...signIns,
        passkeys: [signIns.passkeys[0]!, { id: second.id, publicKey: first.publicKey }],
      }),
      passkeyCountersignatureNonce(accountA, { google: [], passkeys: [] }),
      passkeyEndorsementNonce(first.id, first.publicKey),
    ])
      expect(other).not.toBe(nonce);
    // A fixed vector, so the relay and every gateway keep computing the same value.
    expect(
      passkeyCountersignatureNonce(accountA, {
        google: [googleG],
        passkeys: [{ id: "fixture-passkey", publicKey: "fixture-key" }],
      }),
    ).toBe("Z1k9ZT1hm485BiGHe1E14uP00PZ2flcflZ3l66ufssc");
  });

  test("a pinned passkey's countersignature names the account's other sign-ins", async () => {
    const signer = await device(),
      other = await device();
    const signIns = { google: [googleG], passkeys: [{ id: other.id, publicKey: other.publicKey }] };
    expect(
      await verifier().verifyCountersignature(countersign(signer, signIns), signer, accountA, [
        signer.pin,
      ]),
    ).toEqual(signIns);
    // An empty list is a valid statement that says nothing.
    const none = { google: [], passkeys: [] };
    expect(
      await verifier().verifyCountersignature(countersign(signer, none), signer, accountA, [
        signer.pin,
      ]),
    ).toEqual(none);
  });

  test("a relay that adds, drops or swaps a sign-in in the signed list gets nothing", async () => {
    const signer = await device(),
      other = await device(),
      intruder = await device();
    const genuine = countersign(signer, {
      google: [googleG],
      passkeys: [{ id: other.id, publicKey: other.publicKey }],
    });
    for (const tampered of [
      { ...genuine, google: [googleG, googleX] },
      { ...genuine, google: [googleX] },
      { ...genuine, google: [] },
      {
        ...genuine,
        passkeys: [...genuine.passkeys, { id: intruder.id, publicKey: intruder.publicKey }],
      },
      { ...genuine, passkeys: [{ id: other.id, publicKey: intruder.publicKey }] },
      { ...genuine, passkeys: [{ id: intruder.id, publicKey: other.publicKey }] },
    ])
      expect(
        await verifier().verifyCountersignature(tampered, signer, accountA, [signer.pin]),
      ).toBeUndefined();
  });

  test("only the pinned passkey's own signature counts, for this account only", async () => {
    const signer = await device(),
      intruder = await device();
    const signIns = { google: [googleX], passkeys: [] };
    const genuine = countersign(signer, signIns);
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
    // Another passkey's signature, labelled with the pinned passkey's id, is refused.
    const forged = countersign(intruder, signIns);
    forged.proof.credential = { ...forged.proof.credential, id: signer.id, rawId: signer.id };
    expect(
      await verifier().verifyCountersignature(forged, signer, accountA, [signer.pin]),
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
        countersign(signer, signIns, { account: accountB }),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toBeUndefined();
    // Made on another origin, it is not a sign-in at this relay.
    expect(
      await verifier().verifyCountersignature(
        countersign(signer, signIns, { origin: "https://unrelated.example.test" }),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toBeUndefined();
  });

  test("no other signature stands in for one, and one stands in for nothing else", async () => {
    const signer = await device(),
      added = await device();
    const signIns = { google: [googleG], passkeys: [] };
    // The same passkey's sign-in or endorsement signs another nonce, so it is no countersignature.
    for (const nonce of [opaque(), passkeyEndorsementNonce(added.id, added.publicKey)])
      expect(
        await verifier().verifyCountersignature(
          countersign(signer, signIns, { nonce }),
          signer,
          accountA,
          [signer.pin],
        ),
      ).toBeUndefined();
    const genuine = countersign(signer, signIns);
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
    for (const input of [undefined, null, "countersigned", { ...genuine, extra: true }])
      expect(
        await verifier().verifyCountersignature(input, signer, accountA, [signer.pin]),
      ).toBeUndefined();
    // A countersignature is no sign-in for a device, and vouches for no added passkey.
    expect(
      await verifier().verify(genuine.proof, passkeyCountersignatureNonce(accountA, signIns)),
    ).toBeUndefined();
    expect(await verifier().verifyEndorsement(genuine.proof, added, [signer.pin])).toBe(false);
  });

  test("an old countersignature verifies as of when it was made, and a future-dated one never does", async () => {
    const signer = await device();
    const signIns = { google: [googleG], passkeys: [] };
    for (const age of [3600, 30 * DAY, 400 * DAY])
      expect(
        await verifier().verifyCountersignature(
          countersign(signer, signIns, { issuedAt: seconds() - age }),
          signer,
          accountA,
          [signer.pin],
        ),
      ).toEqual(signIns);
    // A gateway that was offline for a month checks today's the same way.
    expect(
      await verifier(() => seconds() + 30 * DAY).verifyCountersignature(
        countersign(signer, signIns),
        signer,
        accountA,
        [signer.pin],
      ),
    ).toEqual(signIns);
    for (const ahead of [120, DAY])
      expect(
        await verifier().verifyCountersignature(
          countersign(signer, signIns, { issuedAt: seconds() + ahead }),
          signer,
          accountA,
          [signer.pin],
        ),
      ).toBeUndefined();
  });
});
