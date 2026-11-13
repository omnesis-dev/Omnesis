// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import {
  googleProofNonce,
  passkeyEndorsementNonce,
  passkeyProofChallenge,
  type SignInProof,
} from "./device-enrollment.js";
import { GatewaySignInVerifier, type TrustedSignIn } from "./gateway-sign-in-proof.js";
import { accountId, googleIdentityProvider } from "./identity.js";
import { OmnesisAccounts, type PasskeyRegistration } from "./omnesis-accounts.js";
import { PasskeyEndorsements } from "./passkey-endorsement.js";

const opaque = () => randomBytes(32).toString("base64url");
const cookieFor = (browser: string) => `__Host-omnesis-account-browser=${browser}`;

describe("a new passkey waiting on the relay", () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });
  const registration = (id = opaque(), label = "Fictional passkey"): PasskeyRegistration => ({
    credential: { id, publicKey: new Uint8Array(randomBytes(77)), counter: 0 },
    deviceType: "multiDevice",
    backedUp: true,
    label,
  });
  function fixture(options: ConstructorParameters<typeof PasskeyEndorsements>[1] = {}) {
    const db = new Database(":memory:");
    databases.push(db);
    const accounts = new OmnesisAccounts(db),
      endorsements = new PasskeyEndorsements(accounts, options);
    const account = {
      accountId: accounts.signInFederated("google", "a".repeat(64)),
      version: 1,
    };
    const browser = opaque(),
      cookie = cookieFor(browser);
    /** The sign-in the page reports once Google has returned for this parked passkey. */
    const google = (id: string, from = account.accountId, header = cookie) =>
      endorsements.recordProof(id, header, {
        type: "google",
        accountId: from,
        idToken: "fictional-google-token",
        nonce: endorsements.googleProofNonce(id, header),
      });
    return { db, accounts, endorsements, account, browser, cookie, google };
  }

  test("a parked passkey is stored only once a sign-in of its own account has vouched for it", () => {
    const f = fixture(),
      passkey = registration();
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.accounts.passkey(passkey.credential.id)).toBeUndefined();
    expect(f.endorsements.describe(id, f.cookie)).toEqual({
      label: "Fictional passkey",
      needsProof: true,
      needsCountersignature: true,
    });
    // The sign-in commits to this passkey's id and public key, and to nothing else.
    const commitment = f.endorsements.proofCommitment(id, f.cookie),
      publicKey = Buffer.from(passkey.credential.publicKey).toString("base64url");
    expect(commitment.nonce).toBe(passkeyEndorsementNonce(passkey.credential.id, publicKey));
    expect(f.endorsements.googleProofNonce(id, f.cookie)).toBe(
      googleProofNonce(commitment.salt, commitment.nonce),
    );
    // Nothing is stored before a sign-in vouches, whoever asks.
    expect(() => f.endorsements.complete(id, f.cookie, f.account)).toThrow(
      "Sign in on this request",
    );
    f.google(id);
    expect(f.endorsements.describe(id, f.cookie)).toMatchObject({ needsProof: false });
    expect(f.endorsements.complete(id, f.cookie, f.account)).toEqual({
      id: passkey.credential.id,
    });
    expect(f.accounts.passkeyKeys(f.account.accountId)).toEqual([
      {
        id: passkey.credential.id,
        publicKey,
        endorsement: { type: "google", idToken: "fictional-google-token", salt: commitment.salt },
      },
    ]);
    // It is stored once: the same name finishes nothing a second time.
    expect(() => f.endorsements.complete(id, f.cookie, f.account)).toThrow("no longer waiting");
    expect(() => f.endorsements.describe(id, f.cookie)).toThrow("no longer waiting");
  });

  test("only the account's other passkeys are offered to vouch", () => {
    const f = fixture(),
      existing = registration("existing-passkey");
    f.accounts.registerPasskey(f.account.accountId, existing, false);
    const other = f.accounts.signInFederated("google", "b".repeat(64));
    f.accounts.registerPasskey(other, registration("another-account-passkey"), false);
    const id = f.endorsements.park(f.browser, f.account.accountId, registration());
    expect(f.endorsements.endorsers(id, f.cookie)).toEqual(["existing-passkey"]);
  });

  test("a sign-in of a different account, or a passkey registration, cannot vouch", () => {
    const f = fixture(),
      passkey = registration();
    const other = f.accounts.signInFederated("google", "b".repeat(64));
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    expect(() => f.google(id, other)).toThrow("already has");
    const { salt, issuedAt, nonce } = f.endorsements.proofCommitment(id, f.cookie);
    expect(() =>
      f.endorsements.recordProof(id, f.cookie, {
        type: "passkey-registration",
        accountId: f.account.accountId,
        challenge: passkeyProofChallenge(salt, issuedAt, nonce),
        credential: passkeyAuthenticator().registration(
          passkeyProofChallenge(salt, issuedAt, nonce),
        ),
      }),
    ).toThrow("already has");
    // A Google sign-in made for something else is not this passkey's vouching either.
    expect(() =>
      f.endorsements.recordProof(id, f.cookie, {
        type: "google",
        accountId: f.account.accountId,
        idToken: "fictional-google-token",
        nonce: opaque(),
      }),
    ).toThrow("another request");
    expect(f.endorsements.describe(id, f.cookie)).toMatchObject({ needsProof: true });
    expect(() => f.endorsements.complete(id, f.cookie, f.account)).toThrow(
      "Sign in on this request",
    );
    expect(f.accounts.passkey(passkey.credential.id)).toBeUndefined();
  });

  test("another account's session cannot finish it, even after the right account vouched", () => {
    const f = fixture(),
      passkey = registration();
    const other = { accountId: f.accounts.signInFederated("google", "b".repeat(64)), version: 1 };
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    f.google(id);
    expect(() => f.endorsements.complete(id, f.cookie, other)).toThrow(
      "the Omnesis account you are adding this passkey to",
    );
    expect(f.accounts.passkey(passkey.credential.id)).toBeUndefined();
    expect(f.accounts.list(other.accountId).passkeys).toEqual([]);
    // The refusal spends nothing: the owner can still finish.
    f.endorsements.complete(id, f.cookie, f.account);
    expect(f.accounts.passkey(passkey.credential.id)?.accountId).toBe(f.account.accountId);
  });

  test("an account that changed since the passkey was created stores nothing", () => {
    const f = fixture(),
      passkey = registration();
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    f.google(id);
    expect(() => f.endorsements.complete(id, f.cookie, { ...f.account, version: 2 })).toThrow(
      "Account changed",
    );
    expect(f.accounts.passkey(passkey.credential.id)).toBeUndefined();
    expect(() => f.endorsements.complete(id, f.cookie, f.account)).toThrow("no longer waiting");
  });

  test("only the browser that created the passkey can see, vouch for, finish or cancel it", () => {
    const f = fixture(),
      passkey = registration();
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    f.google(id);
    for (const header of [
      "",
      cookieFor(opaque()),
      `${f.cookie}; ${f.cookie}`,
      `${f.cookie}; ${cookieFor(opaque())}`,
      `__Host-omnesis-account=${f.browser}`,
    ]) {
      for (const attempt of [
        () => f.endorsements.describe(id, header),
        () => f.endorsements.proofCommitment(id, header),
        () => f.endorsements.googleProofNonce(id, header),
        () => f.endorsements.endorsers(id, header),
        () => f.google(id, f.account.accountId, header),
        () => f.endorsements.complete(id, header, f.account),
        () => f.endorsements.cancel(id, header),
      ])
        expect(attempt).toThrow("no longer waiting");
    }
    expect(() => f.endorsements.describe(randomUUID(), f.cookie)).toThrow("no longer waiting");
    // Its own browser still holds it, alongside unrelated cookies.
    expect(
      f.endorsements.describe(id, `fixture-cookie=one; ${f.cookie}; __Host-omnesis-account=two`),
    ).toMatchObject({ needsProof: false });
  });

  test("cancelling forgets the passkey, and it can never be confirmed as an operation", () => {
    const f = fixture(),
      passkey = registration();
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    f.google(id);
    expect(() => f.endorsements.confirm()).toThrow("on the account page");
    f.endorsements.cancel(id, f.cookie);
    expect(() => f.endorsements.complete(id, f.cookie, f.account)).toThrow("no longer waiting");
    expect(() => f.endorsements.cancel(id, f.cookie)).toThrow("no longer waiting");
    expect(f.accounts.passkey(passkey.credential.id)).toBeUndefined();
  });

  test("a parked passkey expires, waiting passkeys are bounded, and shutdown forgets them all", () => {
    let now = Date.now();
    const f = fixture({ now: () => now, ttlMs: 100, maxPending: 2 }),
      passkey = registration();
    const id = f.endorsements.park(f.browser, f.account.accountId, passkey);
    f.google(id);
    now += 99;
    expect(f.endorsements.describe(id, f.cookie)).toMatchObject({ needsProof: false });
    now += 1;
    expect(() => f.endorsements.complete(id, f.cookie, f.account)).toThrow("no longer waiting");
    expect(f.accounts.passkey(passkey.credential.id)).toBeUndefined();
    // The expired one no longer counts towards the limit.
    const waiting = [1, 2].map(() =>
      f.endorsements.park(f.browser, f.account.accountId, registration()),
    );
    expect(() => f.endorsements.park(f.browser, f.account.accountId, registration())).toThrow(
      "Too many",
    );
    now += 100;
    const later = f.endorsements.park(f.browser, f.account.accountId, registration());
    for (const expired of waiting)
      expect(() => f.endorsements.describe(expired, f.cookie)).toThrow("no longer waiting");
    f.endorsements.close();
    expect(() => f.endorsements.describe(later, f.cookie)).toThrow("no longer waiting");
    expect(() => f.endorsements.park(f.browser, f.account.accountId, registration())).toThrow(
      "closed",
    );
    // The defaults hold a passkey for five minutes.
    const defaults = fixture(),
      held = defaults.endorsements.park(defaults.browser, defaults.account.accountId, passkey);
    expect(defaults.endorsements.describe(held, defaults.cookie)).toMatchObject({
      needsProof: true,
    });
  });
});

describe("a gateway checking who vouched for a passkey", () => {
  const RELAY = "https://relay.example.test";
  const AUDIENCE = "client.example.apps.googleusercontent.com";
  const SUBJECT = "fictional-google-subject";
  const DAY = 86_400;
  const googleId = (subject: string) =>
    accountId({ issuer: "https://accounts.google.com", subject, expiresAt: 1 });
  const googlePin = (subject = SUBJECT): TrustedSignIn => ({
    type: "google",
    id: googleId(subject),
    addedAt: 1,
    source: "link-page",
  });
  const seconds = () => Math.floor(Date.now() / 1000);
  let googleKey: CryptoKey, otherKey: CryptoKey;
  let googleKeys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    googleKey = pair.privateKey as CryptoKey;
    otherKey = (await generateKeyPair("RS256")).privateKey as CryptoKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "1", alg: "RS256" };
    googleKeys = createLocalJWKSet({ keys: [jwk] });
  });
  const verifier = (now?: () => number, google = true) =>
    new GatewaySignInVerifier({
      google: () =>
        google
          ? googleIdentityProvider(AUDIENCE, googleKeys, { authorizedParties: [AUDIENCE] })
          : undefined,
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
      "device-enrollment",
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
  const endorsementNonce = (passkey: { id: string; publicKey: string }) =>
    passkeyEndorsementNonce(passkey.id, passkey.publicKey);
  async function googleVouch(
    passkey: { id: string; publicKey: string },
    options: { subject?: string; issuedAt?: number | null; key?: CryptoKey } = {},
  ): Promise<SignInProof> {
    const salt = opaque(),
      issuedAt = options.issuedAt === undefined ? seconds() : options.issuedAt;
    const token = new SignJWT({ nonce: googleProofNonce(salt, endorsementNonce(passkey)) })
      .setProtectedHeader({ alg: "RS256", kid: "1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(AUDIENCE)
      .setSubject(options.subject ?? SUBJECT)
      .setExpirationTime((issuedAt ?? seconds()) + 3600);
    if (issuedAt !== null) token.setIssuedAt(issuedAt);
    return { type: "google", salt, idToken: await token.sign(options.key ?? googleKey) };
  }
  function passkeyVouch(
    by: Device,
    passkey: { id: string; publicKey: string },
    issuedAt = seconds(),
    offerKey = false,
  ) {
    const salt = opaque();
    return {
      type: "passkey" as const,
      salt,
      issuedAt: String(issuedAt),
      ...(offerKey ? { credentialPublicKey: by.publicKey } : {}),
      credential: by.authenticator.authentication(
        passkeyProofChallenge(salt, String(issuedAt), endorsementNonce(passkey)),
        "dXNlcg",
      ) as Extract<SignInProof, { type: "passkey" }>["credential"],
    };
  }

  test("a pinned Google sign-in vouches for exactly the passkey it named", async () => {
    const added = await device(),
      other = await device();
    const proof = await googleVouch(added);
    expect(await verifier().verifyEndorsement(proof, added, [googlePin()])).toBe(true);
    // A relay that swaps the public key or the id gets nothing.
    expect(
      await verifier().verifyEndorsement(proof, { id: added.id, publicKey: other.publicKey }, [
        googlePin(),
      ]),
    ).toBe(false);
    expect(
      await verifier().verifyEndorsement(proof, { id: other.id, publicKey: added.publicKey }, [
        googlePin(),
      ]),
    ).toBe(false);
    // The vouching is no sign-in for anything else.
    expect(await verifier().verify(proof, "device-enrollment", opaque())).toBeUndefined();
  });

  test("a Google subject this gateway never trusted vouches for nothing", async () => {
    const added = await device();
    const stranger = await googleVouch(added, { subject: "fictional-other-subject" });
    expect(await verifier().verifyEndorsement(stranger, added, [googlePin()])).toBe(false);
    expect(await verifier().verifyEndorsement(await googleVouch(added), added, [])).toBe(false);
    // Nor does a token Google did not sign, or any token when no audience is configured here.
    const forged = await googleVouch(added, { key: otherKey });
    expect(await verifier().verifyEndorsement(forged, added, [googlePin()])).toBe(false);
    expect(
      await verifier(undefined, false).verifyEndorsement(await googleVouch(added), added, [
        googlePin(),
      ]),
    ).toBe(false);
  });

  test("a pinned passkey vouches for another, an unpinned one for none, and none for itself", async () => {
    const first = await device(),
      added = await device();
    expect(await verifier().verifyEndorsement(passkeyVouch(first, added), added, [first.pin])).toBe(
      true,
    );
    // Offering its own key does not make an unpinned passkey trusted.
    expect(
      await verifier().verifyEndorsement(passkeyVouch(first, added, seconds(), true), added, [
        googlePin(),
      ]),
    ).toBe(false);
    expect(await verifier().verifyEndorsement(passkeyVouch(first, added), added, [])).toBe(false);
    // Even pinned, a passkey's own signature says nothing about itself.
    expect(await verifier().verifyEndorsement(passkeyVouch(added, added), added, [added.pin])).toBe(
      false,
    );
    // A pinned key that did not make the signature is refused, whatever key the proof offers.
    const impostor = await device();
    const forged = {
      ...passkeyVouch(impostor, added, seconds(), true),
      credential: {
        ...passkeyVouch(impostor, added).credential,
        id: first.id,
        rawId: first.id,
      },
    };
    expect(await verifier().verifyEndorsement(forged, added, [first.pin])).toBe(false);
    // Swapping what is vouched for breaks the signature.
    expect(
      await verifier().verifyEndorsement(
        passkeyVouch(first, added),
        { id: added.id, publicKey: impostor.publicKey },
        [first.pin],
      ),
    ).toBe(false);
  });

  test("a passkey registration, or anything that is not a sign-in proof, vouches for nothing", async () => {
    const first = await device(),
      added = await device();
    const salt = opaque(),
      issuedAt = String(seconds());
    const registration = {
      type: "passkey-registration" as const,
      salt,
      issuedAt,
      credential: first.authenticator.registration(
        passkeyProofChallenge(salt, issuedAt, endorsementNonce(added)),
      ),
    };
    // It verifies as a registration, which is exactly why it must be refused by type.
    expect(
      await verifier().verify(registration, "device-enrollment", endorsementNonce(added)),
    ).toMatchObject({
      id: first.id,
      trusted: false,
    });
    expect(await verifier().verifyEndorsement(registration, added, [first.pin, googlePin()])).toBe(
      false,
    );
    for (const input of [undefined, null, "google", { type: "relay" }, { type: "google" }])
      expect(await verifier().verifyEndorsement(input, added, [first.pin, googlePin()])).toBe(
        false,
      );
  });

  test("an old vouching still verifies as of when it was made, and a future-dated one never does", async () => {
    const first = await device(),
      added = await device(),
      trusted = [googlePin(), first.pin];
    for (const age of [3600 + 5, 3 * DAY, 400 * DAY]) {
      const google = await googleVouch(added, { issuedAt: seconds() - age });
      expect(await verifier().verifyEndorsement(google, added, trusted)).toBe(true);
      // As an ordinary sign-in the same token is long expired.
      expect(
        await verifier().verify(google, "device-enrollment", endorsementNonce(added)),
      ).toBeUndefined();
      const passkey = passkeyVouch(first, added, seconds() - age);
      expect(await verifier().verifyEndorsement(passkey, added, trusted)).toBe(true);
      expect(
        await verifier().verify(passkey, "device-enrollment", endorsementNonce(added)),
      ).toBeUndefined();
    }
    // A gateway that was offline for days checks today's vouching the same way.
    const later = verifier(() => seconds() + 30 * DAY);
    expect(await later.verifyEndorsement(await googleVouch(added), added, trusted)).toBe(true);
    expect(await later.verifyEndorsement(passkeyVouch(first, added), added, trusted)).toBe(true);
    for (const ahead of [120, DAY]) {
      expect(
        await verifier().verifyEndorsement(
          await googleVouch(added, { issuedAt: seconds() + ahead }),
          added,
          trusted,
        ),
      ).toBe(false);
      expect(
        await verifier().verifyEndorsement(
          passkeyVouch(first, added, seconds() + ahead),
          added,
          trusted,
        ),
      ).toBe(false);
    }
    // A token that does not say when it was issued can't be placed in time at all.
    expect(
      await verifier().verifyEndorsement(
        await googleVouch(added, { issuedAt: null }),
        added,
        trusted,
      ),
    ).toBe(false);
  });
});
