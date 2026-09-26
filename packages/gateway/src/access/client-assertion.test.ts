// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { ClientAssertionVerifier, unverifiedAssertionSubject } from "./client-assertion.js";
import type { MetadataResponse, PublicFetchDependencies } from "./public-json-fetch.js";

const CLIENT_ID = "https://client.example.com/oauth/client.json";
const JWKS_URI = "https://client.example.com/oauth/jwks.json";
const ISSUER = "https://gateway.example.org";
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const EXPECTED = { clientId: CLIENT_ID, jwksUri: JWKS_URI, audiences: [ISSUER, TOKEN_ENDPOINT] };
const NOW_MS = 1_900_000_000_000;
const NOW = NOW_MS / 1_000;

const rsa = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const rotatedRsa = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwk(publicKey: KeyObject, kid: string, extra: Record<string, unknown> = {}) {
  return { ...publicKey.export({ format: "jwk" }), kid, use: "sig", ...extra };
}

function jwksResponse(
  keys: unknown[],
  overrides: Partial<MetadataResponse> = {},
): MetadataResponse {
  return {
    status: 200,
    contentType: "application/json",
    cacheControl: "public, max-age=300",
    body: Buffer.from(JSON.stringify({ keys })),
    ...overrides,
  };
}

function dependencies(fetch: PublicFetchDependencies["fetch"]) {
  let now = NOW_MS;
  return {
    now: () => now,
    resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
    fetch: vi.fn(fetch),
    advance(ms: number) {
      now += ms;
    },
  };
}

let jtiCounter = 0;

function assertion(
  options: {
    alg?: string;
    kid?: string | null;
    key?: KeyObject;
    claims?: Record<string, unknown>;
  } = {},
): string {
  const alg = options.alg ?? "RS256";
  const header = {
    alg,
    typ: "JWT",
    ...(options.kid === null ? {} : { kid: options.kid ?? "rsa-1" }),
  };
  const claims = {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: TOKEN_ENDPOINT,
    iat: NOW,
    exp: NOW + 60,
    jti: `jti-${++jtiCounter}`,
    ...options.claims,
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}`;
  let signature: Buffer;
  if (alg === "HS256") {
    signature = createHmac("sha256", "invented-shared-secret").update(signingInput).digest();
  } else if (alg === "none") {
    // An unsecured JWS has an empty signature; a filler one reaches the algorithm check.
    signature = Buffer.from("unsigned");
  } else if (alg === "ES256") {
    signature = sign("sha256", Buffer.from(signingInput), {
      key: options.key ?? ec.privateKey,
      dsaEncoding: "ieee-p1363",
    });
  } else if (alg === "PS256") {
    signature = sign("sha256", Buffer.from(signingInput), {
      key: options.key ?? rsa.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else {
    signature = sign("sha256", Buffer.from(signingInput), options.key ?? rsa.privateKey);
  }
  return `${signingInput}.${signature.toString("base64url")}`;
}

function verifierWith(keys: unknown[]) {
  const deps = dependencies(async () => jwksResponse(keys));
  return { deps, verifier: new ClientAssertionVerifier(deps) };
}

describe("ClientAssertionVerifier", () => {
  test("accepts a valid RS256 assertion and proves which key set verified it", async () => {
    const { deps, verifier } = verifierWith([jwk(rsa.publicKey, "rsa-1", { alg: "RS256" })]);
    await expect(verifier.verify(assertion(), EXPECTED)).resolves.toEqual({
      method: "private_key_jwt",
      clientId: CLIENT_ID,
      jwksUri: JWKS_URI,
    });
    expect(deps.fetch).toHaveBeenCalledWith(
      new URL(JWKS_URI),
      { address: "93.184.216.34", family: 4 },
      16 * 1_024,
    );
    // The key set is cached for the publisher's max-age.
    await verifier.verify(assertion(), EXPECTED);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  test("accepts a valid ES256 assertion and an issuer audience inside an array", async () => {
    const { verifier } = verifierWith([jwk(ec.publicKey, "ec-1")]);
    await expect(
      verifier.verify(
        assertion({
          alg: "ES256",
          kid: "ec-1",
          claims: { aud: ["https://other.example", ISSUER] },
        }),
        EXPECTED,
      ),
    ).resolves.toMatchObject({ clientId: CLIENT_ID });
  });

  test("accepts PS256 from a key set entry that also carries private members", async () => {
    const { verifier } = verifierWith([
      { ...rsa.privateKey.export({ format: "jwk" }), kid: "rsa-1", use: "sig" },
    ]);
    await expect(verifier.verify(assertion({ alg: "PS256" }), EXPECTED)).resolves.toMatchObject({
      clientId: CLIENT_ID,
    });
  });

  test("uses the only key when the header names none", async () => {
    const { verifier } = verifierWith([jwk(rsa.publicKey, "rsa-1")]);
    await expect(verifier.verify(assertion({ kid: null }), EXPECTED)).resolves.toBeDefined();
  });

  test.each([
    [
      "wrong audience",
      { claims: { aud: "https://elsewhere.example.org/oauth/token" } },
      /audience/u,
    ],
    ["wrong issuer", { claims: { iss: "https://attacker.example.com/client.json" } }, /issuer/u],
    ["wrong subject", { claims: { sub: "https://attacker.example.com/client.json" } }, /issuer/u],
    ["expired", { claims: { iat: NOW - 600, exp: NOW - 120 } }, /expired/u],
    ["missing expiry", { claims: { exp: undefined } }, /expiry/u],
    ["overlong lifetime", { claims: { exp: NOW + 3_600 } }, /lifetime/u],
    ["issued in the future", { claims: { iat: NOW + 120, exp: NOW + 180 } }, /issue time/u],
    ["not yet valid", { claims: { nbf: NOW + 600 } }, /not yet valid/u],
    ["missing jti", { claims: { jti: undefined } }, /jti/u],
    ["alg none", { alg: "none" }, /algorithm/u],
    ["alg HS256", { alg: "HS256" }, /algorithm/u],
    ["signature by another key", { key: rotatedRsa.privateKey }, /signature/u],
  ])("rejects an assertion with %s", async (_label, options, message) => {
    const { verifier } = verifierWith([jwk(rsa.publicKey, "rsa-1")]);
    await expect(verifier.verify(assertion(options), EXPECTED)).rejects.toThrow(message);
  });

  test("rejects a key whose declared algorithm or use does not fit", async () => {
    const { verifier } = verifierWith([
      jwk(rsa.publicKey, "rsa-1", { alg: "PS256" }),
      jwk(ec.publicKey, "ec-1", { use: "enc" }),
    ]);
    await expect(verifier.verify(assertion(), EXPECTED)).rejects.toThrow(/No key/u);
    await expect(
      verifier.verify(assertion({ alg: "ES256", kid: "ec-1" }), EXPECTED),
    ).rejects.toThrow(/No key/u);
  });

  test("accepts each jti once", async () => {
    const { verifier } = verifierWith([jwk(rsa.publicKey, "rsa-1")]);
    const once = assertion();
    await verifier.verify(once, EXPECTED);
    await expect(verifier.verify(once, EXPECTED)).rejects.toThrow(/already used/u);
  });

  test("refetches once for an unknown kid, picks up a rotated key, and rate-limits refetches", async () => {
    let keys = [jwk(rsa.publicKey, "rsa-1")];
    const deps = dependencies(async () => jwksResponse(keys));
    const verifier = new ClientAssertionVerifier(deps);
    await verifier.verify(assertion(), EXPECTED);
    expect(deps.fetch).toHaveBeenCalledTimes(1);

    // Within the refetch interval an unknown kid does not reach the network.
    keys = [jwk(rotatedRsa.publicKey, "rsa-2")];
    const rotated = () => assertion({ kid: "rsa-2", key: rotatedRsa.privateKey });
    await expect(verifier.verify(rotated(), EXPECTED)).rejects.toThrow(/No key/u);
    expect(deps.fetch).toHaveBeenCalledTimes(1);

    deps.advance(30_000);
    await expect(verifier.verify(rotated(), EXPECTED)).resolves.toBeDefined();
    expect(deps.fetch).toHaveBeenCalledTimes(2);

    // A bogus kid right after is refused without another fetch.
    await expect(verifier.verify(assertion({ kid: "bogus" }), EXPECTED)).rejects.toThrow(/No key/u);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["non-JSON", jwksResponse([], { contentType: "text/html" }), /must be served as JSON/u],
    ["oversized", jwksResponse([], { body: Buffer.alloc(16 * 1_024 + 1) }), /size limit/u],
    ["malformed", jwksResponse([], { body: Buffer.from("{") }), /not valid JSON/u],
    ["not a key set", jwksResponse([], { body: Buffer.from('{"kty":"RSA"}') }), /not a key set/u],
    ["non-success", jwksResponse([], { status: 404 }), /non-success/u],
  ])("refuses a %s key set", async (_label, response, message) => {
    const verifier = new ClientAssertionVerifier(dependencies(async () => response));
    await expect(verifier.verify(assertion(), EXPECTED)).rejects.toThrow(message);
  });

  test("refuses a key set on a non-public address before fetching", async () => {
    const deps = dependencies(async () => jwksResponse([jwk(rsa.publicKey, "rsa-1")]));
    deps.resolve.mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
    const verifier = new ClientAssertionVerifier(deps);
    await expect(verifier.verify(assertion(), EXPECTED)).rejects.toThrow(/not publicly routable/u);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  test("rejects an RSA key shorter than 2048 bits", async () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1_024 });
    const { verifier } = verifierWith([jwk(weak.publicKey, "rsa-1")]);
    await expect(verifier.verify(assertion({ key: weak.privateKey }), EXPECTED)).rejects.toThrow(
      /No key/u,
    );
  });
});

describe("unverifiedAssertionSubject", () => {
  test("reads sub without verifying, and nothing from a malformed value", () => {
    expect(unverifiedAssertionSubject(assertion())).toBe(CLIENT_ID);
    expect(unverifiedAssertionSubject("not-a-jwt")).toBeNull();
  });
});
