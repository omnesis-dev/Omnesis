// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GatewayPasskeyError,
  gatewayPasskeyProof,
  onGatewayOrigin,
  passkeysSupported,
  // @ts-expect-error portal JS
} from "./gateway-passkey.js";

const ORIGIN = "https://g-abcdefgh.relay.example.test";
const CHALLENGE = "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw";
const ceremony = {
  purpose: "pin-passkey",
  rpId: "relay.example.test",
  origin: ORIGIN,
  challenge: CHALLENGE,
  binding: "binding",
  webauthnChallenge: "d2ViYXV0aG5jaGFsbGVuZ2V3ZWJhdXRobmNoYWxsZW4",
  expiresAt: 1,
};
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const assertion = (over: Record<string, unknown> = {}, response: Record<string, unknown> = {}) => ({
  id: "Y3JlZA",
  rawId: bytes("cred"),
  authenticatorAttachment: "platform",
  ...over,
  response: {
    clientDataJSON: bytes("{}"),
    authenticatorData: bytes("auth"),
    signature: bytes("sig"),
    userHandle: bytes("user"),
    ...response,
  },
});
afterEach(() => vi.unstubAllGlobals());

describe("gateway passkey ceremonies in the portal", () => {
  test("passkeys are offered only where the browser has them", () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    expect(passkeysSupported({ credentials: { get: () => undefined } })).toBe(true);
    expect(passkeysSupported({ credentials: {} })).toBe(false);
    expect(passkeysSupported(undefined)).toBe(false);
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(passkeysSupported({ credentials: { get: () => undefined } })).toBe(false);
  });

  test("the prompt runs only on the origin the gateway vouches for", async () => {
    expect(onGatewayOrigin(ORIGIN, { origin: ORIGIN })).toBe(true);
    expect(onGatewayOrigin(ORIGIN, { origin: "https://192.0.2.1:7600" })).toBe(false);
    expect(onGatewayOrigin(undefined, { origin: ORIGIN })).toBe(false);
    expect(onGatewayOrigin(ORIGIN, undefined)).toBe(false);
    const get = vi.fn();
    await expect(
      gatewayPasskeyProof(ceremony, {
        credentials: { get },
        location: { origin: "https://relay.example.test" },
      }),
    ).rejects.toThrow(`Open this page at ${ORIGIN} to use your passkey.`);
    expect(get).not.toHaveBeenCalled();
  });

  test("an unexpected request from the gateway is not passed to the browser", async () => {
    for (const bad of [
      undefined,
      { ...ceremony, challenge: "short" },
      { ...ceremony, challenge: undefined },
      { ...ceremony, webauthnChallenge: undefined },
      { ...ceremony, rpId: 7 },
    ])
      await expect(
        gatewayPasskeyProof(bad, { credentials: { get: vi.fn() }, location: { origin: ORIGIN } }),
      ).rejects.toBeInstanceOf(GatewayPasskeyError);
  });

  test("the assertion goes back as a gateway-passkey proof for the issued challenge", async () => {
    const get = vi.fn().mockResolvedValue(assertion());
    const signal = new AbortController().signal;
    const proof = await gatewayPasskeyProof(ceremony, {
      credentials: { get },
      location: { origin: ORIGIN },
      signal,
    });
    const request = get.mock.calls[0]![0];
    expect(request.signal).toBe(signal);
    expect(request.publicKey).toMatchObject({
      rpId: "relay.example.test",
      allowCredentials: [],
      userVerification: "required",
    });
    expect(Buffer.from(request.publicKey.challenge).toString("base64url")).toBe(
      ceremony.webauthnChallenge,
    );
    expect(proof).toEqual({
      type: "gateway-passkey",
      challenge: CHALLENGE,
      credential: {
        id: "Y3JlZA",
        rawId: "Y3JlZA",
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: "e30",
          authenticatorData: "YXV0aA",
          signature: "c2ln",
          userHandle: "dXNlcg",
        },
      },
    });
    const roaming = await gatewayPasskeyProof(ceremony, {
      credentials: { get: vi.fn().mockResolvedValue(assertion({ authenticatorAttachment: null })) },
      location: { origin: ORIGIN },
    });
    expect(roaming.credential).not.toHaveProperty("authenticatorAttachment");
    expect(get.mock.calls[0]![0]).toHaveProperty("signal");
    const unsignalled = vi.fn().mockResolvedValue(assertion());
    await gatewayPasskeyProof(ceremony, {
      credentials: { get: unsignalled },
      location: { origin: ORIGIN },
    });
    expect(unsignalled.mock.calls[0]![0]).not.toHaveProperty("signal");
  });

  test("a closed prompt or a passkey without an account handle says what to do", async () => {
    await expect(
      gatewayPasskeyProof(ceremony, {
        credentials: { get: vi.fn().mockRejectedValue(new Error("NotAllowedError")) },
        location: { origin: ORIGIN },
      }),
    ).rejects.toThrow("The passkey prompt was closed or timed out. Try again.");
    for (const value of [null, assertion({}, { userHandle: null })])
      await expect(
        gatewayPasskeyProof(ceremony, {
          credentials: { get: vi.fn().mockResolvedValue(value) },
          location: { origin: ORIGIN },
        }),
      ).rejects.toThrow("That passkey can't be used here. Try your Omnesis passkey.");
  });
});
