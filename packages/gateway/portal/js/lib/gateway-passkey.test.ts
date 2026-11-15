// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { webcrypto } from "node:crypto";
import { approvalDeviceTranscript as cloudRelayApprovalTranscript } from "@omnesis/cloud-relay";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  approvalDeviceTranscript,
  approveWithPasskey,
  GatewayPasskeyError,
  gatewayPasskeyProof,
  onGatewayOrigin,
  passkeysSupported,
  STEP_UP_HEADER,
  stepUp,
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

describe("approving a held request with a passkey", () => {
  const REQUEST = "11111111-2222-4333-8444-555555555555";
  const ok = (body: unknown = {}) => new Response(JSON.stringify(body));
  test("asks for the ceremony, prompts, and sends the assertion with the browser's own signature", async () => {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(ok({ challenge: CHALLENGE, origin: ORIGIN }))
      .mockResolvedValueOnce(ok({ ok: true }));
    vi.stubGlobal("fetch", transport);
    vi.stubGlobal("crypto", webcrypto);
    const prove = vi.fn().mockResolvedValue({ type: "gateway-passkey" });
    await approveWithPasskey(
      { requestId: REQUEST, trustSignIn: true, deviceKey: pair.privateKey },
      { prove },
    );
    expect(transport.mock.calls.map(([path]) => path)).toEqual([
      "/devices/account/approval/options",
      "/devices/account/approval",
    ]);
    const body = JSON.parse(transport.mock.calls[1]![1].body);
    expect(body).toMatchObject({ requestId: REQUEST, proof: { type: "gateway-passkey" }, trustSignIn: true });
    const valid = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      Buffer.from(body.deviceSignature, "base64url"),
      new TextEncoder().encode(approvalDeviceTranscript(REQUEST, CHALLENGE)),
    );
    expect(valid).toBe(true);
    // The transcript is the gateway's, byte for byte.
    expect(approvalDeviceTranscript(REQUEST, CHALLENGE)).toBe(
      cloudRelayApprovalTranscript({ requestId: REQUEST, challenge: CHALLENGE }).toString(),
    );
  });

  test("an expired request, a refused passkey and any other failure each say what to do", async () => {
    const prove = vi.fn().mockResolvedValue({ type: "gateway-passkey" });
    const sign = vi.fn().mockResolvedValue("signature");
    const signal = new AbortController().signal;
    for (const [responses, deviceKey, message] of [
      [[new Response("{}", { status: 404 })], undefined, "can't be approved here anymore"],
      [[ok({ challenge: CHALLENGE }), new Response("{}", { status: 403 })], undefined, "Use a passkey you confirmed on this gateway."],
      [[ok({ challenge: CHALLENGE }), new Response("{}", { status: 403 })], {}, "in the browser that asked to join"],
      [[ok({ challenge: CHALLENGE }), new Response("{}", { status: 500 })], undefined, "Couldn't approve this request."],
    ] as const) {
      const transport = vi.fn();
      for (const response of responses) transport.mockResolvedValueOnce(response);
      vi.stubGlobal("fetch", transport);
      await expect(
        approveWithPasskey(
          { requestId: REQUEST, signal, ...(deviceKey ? { deviceKey } : {}) },
          { prove, sign },
        ),
      ).rejects.toThrow(message);
      expect(transport.mock.calls[0]![1].signal).toBe(signal);
    }
    // With no injected helpers it uses the real prompt, which refuses an off-origin page.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ ...ceremony })));
    vi.stubGlobal("location", { origin: "https://elsewhere.example.test" });
    await expect(approveWithPasskey({ requestId: REQUEST })).rejects.toThrow("Open this page at");
  });
});

describe("stepping up for one administrative action", () => {
  const detail = {
    method: "POST",
    path: "/admin/devices/pair",
    bodySha256: "a".repeat(64),
    options: "/admin/step-up/options",
    header: "X-Omnesis-Step-Up",
  };
  const target = { method: "POST", path: "/admin/devices/pair", bodySha256: "a".repeat(64) };
  const ok = (body: unknown) => new Response(JSON.stringify(body));

  test("asks for the ceremony of exactly the refused request, prompts, and returns the id", async () => {
    const proof = { type: "gateway-passkey", challenge: CHALLENGE };
    const prove = vi.fn().mockResolvedValue(proof);
    const post = vi
      .fn()
      .mockResolvedValueOnce(ok({ ...ceremony, purpose: "step-up" }))
      .mockResolvedValueOnce(ok({ stepUpId: "step-up-id", expiresAt: 1 }));
    const signal = new AbortController().signal;
    expect(await stepUp(detail, { post, prove, signal })).toBe("step-up-id");
    expect(STEP_UP_HEADER).toBe("X-Omnesis-Step-Up");
    expect(post.mock.calls).toEqual([
      ["/admin/step-up/options", target, signal],
      ["/admin/step-up", { ...target, proof }, signal],
    ]);
    expect(prove).toHaveBeenCalledWith({ ...ceremony, purpose: "step-up" }, { signal });
  });

  test("no ceremony, a refused passkey and a closed prompt each say what to do", async () => {
    const prove = vi.fn().mockResolvedValue({ type: "gateway-passkey" });
    await expect(
      stepUp(detail, { post: vi.fn().mockResolvedValue(new Response("{}", { status: 403 })), prove }),
    ).rejects.toThrow("can't be used on this gateway right now");
    await expect(
      stepUp(detail, {
        post: vi
          .fn()
          .mockResolvedValueOnce(ok(ceremony))
          .mockResolvedValueOnce(new Response("{}", { status: 403 })),
        prove,
      }),
    ).rejects.toThrow("Use a passkey you confirmed on this gateway.");
    // With the real prompt, a page off the gateway's origin is sent there.
    vi.stubGlobal("location", { origin: "https://elsewhere.example.test" });
    await expect(
      stepUp(detail, { post: vi.fn().mockResolvedValue(ok(ceremony)) }),
    ).rejects.toBeInstanceOf(GatewayPasskeyError);
  });
});
