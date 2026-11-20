// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { expect, test } from "vitest";
import {
  INVITE_TYPE,
  InviteRefused,
  InviteVerifier,
  MAX_INVITE_LIFETIME_SECONDS,
  inviteLink,
  invitePublicKey,
  invitePublicKeyValue,
  inviteToken,
  signInvite,
} from "./invites.js";

const origin = "https://relay.example.test";
const operator = generateKeyPairSync("ed25519");
const verifier = new InviteVerifier(origin, [invitePublicKeyValue(operator.publicKey)]);
const now = Math.floor(Date.now() / 1000);
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token signed by `key` over any header and claims, as a forger could make one. */
function forge(header: unknown, claims: unknown, key: KeyObject = operator.privateKey) {
  const input = `${part(header)}.${part(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}
const goodHeader = { alg: "EdDSA", typ: INVITE_TYPE };
const claims = (overrides: Record<string, unknown> = {}) => ({
  aud: origin,
  jti: "FictionalInvite0000001",
  iat: now,
  exp: now + 3600,
  ...overrides,
});
const reason = (value: string) => {
  try {
    verifier.verify(value, now);
  } catch (error) {
    expect(error).toBeInstanceOf(InviteRefused);
    expect(error).toMatchObject({ status: 403, code: (error as InviteRefused).reason });
    return (error as InviteRefused).reason;
  }
  return "valid";
};

test("an invite the operator signed for this relay is valid until it expires, whatever form it is pasted in", () => {
  const token = signInvite(operator.privateKey, {
    origin,
    expiresAt: now + 60,
    id: "Fixture-Invite_0000001",
  });
  expect(verifier.verify(token, now)).toEqual({
    id: "Fixture-Invite_0000001",
    expiresAt: now + 60,
  });
  const link = inviteLink(`${origin}/`, token);
  expect(link).toBe(`${origin}/invite#${token}`);
  for (const pasted of [link, `  ${link}\n`, `#${token}`, token])
    expect(verifier.verify(pasted, now).id).toBe("Fixture-Invite_0000001");
  expect(
    verifier.verify(signInvite(operator.privateKey, { origin, expiresAt: now + 60 })).id,
  ).toMatch(/^[A-Za-z0-9_-]{22}$/);
  // Expired a second ago, and not before.
  expect(
    reason(signInvite(operator.privateKey, { origin, issuedAt: now - 120, expiresAt: now })),
  ).toBe("invite-expired");
});

test("anything else is invalid: another key, another relay, another header, or claims out of shape", () => {
  const other = generateKeyPairSync("ed25519").privateKey;
  expect(reason(signInvite(other, { origin, expiresAt: now + 60 }))).toBe("invite-invalid");
  expect(
    reason(
      signInvite(operator.privateKey, {
        origin: "https://other.example.test",
        expiresAt: now + 60,
      }),
    ),
  ).toBe("invite-invalid");
  for (const header of [
    { alg: "EdDSA", typ: "JWT" },
    { alg: "none", typ: INVITE_TYPE },
    { typ: INVITE_TYPE, alg: "EdDSA" },
  ])
    expect(reason(forge(header, claims()))).toBe("invite-invalid");
  for (const bad of [
    claims({ exp: now - 10, iat: now }),
    claims({ exp: now, iat: now }),
    claims({ iat: now - 10, exp: now - 10 + MAX_INVITE_LIFETIME_SECONDS + 1 }),
    claims({ iat: now + 301, exp: now + 3600 }),
    claims({ jti: "short" }),
    claims({ extra: true }),
    { aud: origin },
  ])
    expect(reason(forge(goodHeader, bad))).toBe("invite-invalid");
  // Signed, but not JSON.
  const input = `${part(goodHeader)}.${Buffer.from("not json").toString("base64url")}`;
  expect(
    reason(`${input}.${sign(null, Buffer.from(input), operator.privateKey).toString("base64url")}`),
  ).toBe("invite-invalid");
  // A clock a little ahead on the issuing machine is tolerated.
  expect(reason(forge(goodHeader, claims({ iat: now + 300 })))).toBe("valid");
  // A signature that is not the one over these bytes.
  const token = signInvite(operator.privateKey, { origin, expiresAt: now + 60 });
  const cut = token.lastIndexOf(".") + 1;
  const signature = Buffer.from(token.slice(cut), "base64url");
  signature.writeUInt8(signature.readUInt8(0) ^ 1, 0);
  expect(reason(`${token.slice(0, cut)}${signature.toString("base64url")}`)).toBe("invite-invalid");
  expect(reason("")).toBe("invite-invalid");
});

test("only something shaped like an invite is read from what a person pasted", () => {
  const token = signInvite(operator.privateKey, { origin, expiresAt: now + 60 });
  expect(inviteToken(`https://relay.example.test/invite#${token}`)).toBe(token);
  expect(inviteToken(token)).toBe(token);
  for (const value of [
    "",
    "not an invite",
    "a.b.c",
    `${token}=`,
    `https://relay.example.test/invite#${token}#`,
    `${"a".repeat(1600)}#${token}`,
    `${"a".repeat(800)}.${"b".repeat(200)}.${"c".repeat(86)}`,
  ])
    expect(inviteToken(value)).toBeUndefined();
});

test("public keys are raw Ed25519 keys in base64url, one to eight of them, and any one of them verifies", () => {
  const second = generateKeyPairSync("ed25519");
  const value = invitePublicKeyValue(second.publicKey);
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(invitePublicKeyValue(invitePublicKey(value))).toBe(value);
  const both = new InviteVerifier(origin, [invitePublicKeyValue(operator.publicKey), value]);
  for (const { privateKey } of [operator, second])
    expect(both.verify(signInvite(privateKey, { origin, expiresAt: now + 60 }), now)).toBeDefined();
  expect(() => invitePublicKey("not-a-key")).toThrow("Invalid invite public key");
  expect(() =>
    invitePublicKeyValue(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey),
  ).toThrow("Invite keys are Ed25519");
  expect(() =>
    invitePublicKeyValue(generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey),
  ).toThrow("Invite keys are Ed25519");
  expect(() => new InviteVerifier(origin, [])).toThrow("between one and eight");
  expect(
    () =>
      new InviteVerifier(
        origin,
        Array.from({ length: 9 }, () => value),
      ),
  ).toThrow("between one and eight");
  expect(() => new InviteVerifier("http://relay.example.test", [value])).toThrow();
  // The clock defaults to now.
  expect(
    verifier.verify(signInvite(operator.privateKey, { origin, expiresAt: now + 3600 })).expiresAt,
  ).toBe(now + 3600);
});
