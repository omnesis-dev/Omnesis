// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { passkeyAuthenticator } from "../test/passkey-authenticator.js";
import { googleProofNonce, passkeyProofChallenge } from "./device-enrollment.js";
import { OperationProof } from "./operation-proof.js";

const opaque = () => randomBytes(32).toString("base64url"),
  account = "a".repeat(64);

test("a proof is bound to one operation's commitment and leaves it exactly once", () => {
  const nonce = opaque(),
    proof = new OperationProof(nonce),
    { salt, issuedAt } = proof.commitment();
  expect(proof.commitment().nonce).toBe(nonce);
  expect(issuedAt).toMatch(/^[1-9][0-9]{9,10}$/);
  expect(proof.googleNonce()).toBe(googleProofNonce(salt, nonce));
  expect(proof.needed()).toBe(true);
  expect(() => proof.assertFrom(account)).toThrow("Sign in");
  expect(() =>
    proof.record({ type: "google", accountId: account, idToken: "token", nonce: opaque() }),
  ).toThrow("another request");
  expect(proof.needed()).toBe(true);
  proof.record({
    type: "google",
    accountId: account,
    idToken: "token",
    nonce: proof.googleNonce(),
  });
  expect(proof.needed()).toBe(false);
  expect(() => proof.assertFrom("b".repeat(64))).toThrow("Sign in");
  proof.assertFrom(account);
  expect(proof.take()).toEqual({ signInProof: { type: "google", idToken: "token", salt } });
  expect(proof.needed()).toBe(true);
});

test("passkey proofs carry the operation's salt and issue time, and only an assertion offers a key", () => {
  const nonce = opaque(),
    proof = new OperationProof(nonce),
    { salt, issuedAt } = proof.commitment(),
    challenge = passkeyProofChallenge(salt, issuedAt, nonce),
    authenticator = passkeyAuthenticator();
  const assertion = authenticator.authentication(challenge, opaque());
  for (const wrong of [opaque(), "short"])
    expect(() =>
      proof.record({
        type: "passkey",
        accountId: account,
        challenge: wrong,
        credential: assertion,
        credentialPublicKey: "ZmljdGlvbmFs",
      }),
    ).toThrow("another request");
  proof.record({
    type: "passkey",
    accountId: account,
    challenge,
    credential: assertion,
    credentialPublicKey: "ZmljdGlvbmFs",
  });
  expect(proof.take()).toEqual({
    signInProof: {
      type: "passkey",
      salt,
      issuedAt,
      credentialPublicKey: "ZmljdGlvbmFs",
      credential: assertion,
    },
    credentialPublicKey: "ZmljdGlvbmFs",
  });
  const registration = authenticator.registration(challenge);
  proof.record({
    type: "passkey-registration",
    accountId: account,
    challenge,
    credential: registration,
  });
  expect(proof.take()).toEqual({
    signInProof: { type: "passkey-registration", salt, issuedAt, credential: registration },
  });
});

test("each operation chooses its own salt, so one enrollment nonce can't reuse a token", () => {
  const nonce = opaque();
  expect(new OperationProof(nonce).googleNonce()).not.toBe(new OperationProof(nonce).googleNonce());
});
