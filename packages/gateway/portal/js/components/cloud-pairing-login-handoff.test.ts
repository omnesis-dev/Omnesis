// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { webcrypto } from "node:crypto";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { enrollmentSignatureTranscript, verifyDeviceSignature } from "@omnesis/cloud-relay";
const api = vi.hoisted(() => ({
  cloudPairingConfig: vi.fn(),
  login: vi.fn(),
  setPortalDeviceName: vi.fn(),
  loadDeviceKey: vi.fn(),
  adoptDeviceKey: vi.fn(),
  takeAccountSignIn: vi.fn(),
}));
vi.mock("../lib/device-key-store.js", () => ({
  loadDeviceKey: api.loadDeviceKey,
  adoptDeviceKey: api.adoptDeviceKey,
}));
vi.mock("../lib/cloud-pairing-api.js", () => ({ cloudPairingConfig: api.cloudPairingConfig }));
vi.mock("../api.js", () => ({ login: api.login }));
vi.mock("../lib/storage.js", () => ({
  portalDeviceName: () => "Fictional browser",
  setPortalDeviceName: api.setPortalDeviceName,
}));
vi.mock("../lib/cloud-pairing-handoff.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  takeAccountSignIn: api.takeAccountSignIn,
}));
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { CloudPairingLogin } from "./cloud-pairing-login.js";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { cloudPairingVerificationCode } from "../lib/cloud-pairing.js";

const SPKI = "c".repeat(64);
// A nonce and the challenge that commits to it, from the vectors every platform shares.
const NONCE = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk";
const CHALLENGE = "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs";
const config = {
  clientId: "fictional-client",
  gatewayFingerprint: "a".repeat(64),
  webSignIn: true,
  webOrigin: "https://gateway.example.test",
  accountSignIn: true,
  automaticEnrollment: true,
  gatewaySpkiFingerprint: SPKI,
};
const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ");
let host: HTMLElement;
let storage: Map<string, string>;
const location = { href: "https://gateway.example.test/portal/", assign: vi.fn(), reload: vi.fn() };
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  Object.defineProperty(parsed.window, "location", { value: location, configurable: true });
  vi.stubGlobal("window", parsed.window);
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", transport);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  location.reload.mockClear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.cloudPairingConfig.mockResolvedValue(config);
  api.login.mockResolvedValue({ ok: true });
  api.takeAccountSignIn.mockReturnValue(null);
  transport.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
async function show() {
  await act(async () => render(h(CloudPairingLogin, {}), host));
  await act(async () => {
    await Promise.resolve();
  });
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const alerted = (message: string) =>
  vi.waitFor(async () => {
    await settle();
    expect(norm(host.querySelector('[role="alert"]')?.textContent)).toContain(message);
  });

/** What the Omnesis account page puts in the fragment, and the key the browser adopts from it. */
async function handed(altered: Record<string, unknown> = {}) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const value = {
    v: 1,
    requestId: "0d9f0a4e-52a5-4b63-9d0c-5f1f5f8f6a11",
    name: "Portal 1a2b3c4d",
    secret: "e".repeat(64),
    privateKey: await webcrypto.subtle.exportKey("jwk", pair.privateKey),
    devicePublicKey: Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString(
      "base64url",
    ),
    identityToken: "fictional-attestation",
    proof: { type: "google", idToken: "fictional-google-token", salt: "s".repeat(43) },
    ...altered,
  };
  api.takeAccountSignIn.mockReturnValueOnce(Buffer.from(JSON.stringify(value)).toString("base64url"));
  api.adoptDeviceKey.mockResolvedValue({
    privateKey: pair.privateKey,
    publicKey: value.devicePublicKey,
  });
  const code = await cloudPairingVerificationCode(
    { requestId: value.requestId, secret: value.secret },
    config.gatewayFingerprint,
    NONCE,
  );
  return { value, code };
}
const challenge = () => new Response(JSON.stringify({ challenge: CHALLENGE }));
const answer = (code: string, status: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ status, verificationCode: code, codeNonce: NONCE, expiresAt: Date.now() + 60_000, ...extra }),
  );

test("a sign-in handed over by the account page joins this browser with no second sign-in", async () => {
  const { value, code } = await handed();
  transport
    .mockResolvedValueOnce(challenge())
    .mockResolvedValueOnce(answer(code, "approved", { pairingCode: "SYNTHETIC-CODE" }));
  await show();
  await vi.waitFor(() => expect(location.reload).toHaveBeenCalledOnce());
  expect(transport.mock.calls.map(([path]) => path)).toEqual([
    "/devices/account/challenge",
    "/devices/account/request",
  ]);
  // The handed-over key replaces this browser's own; nothing else is consulted.
  const { ext: _ext, key_ops: _ops, ...jwk } = value.privateKey as Record<string, unknown>;
  expect(api.adoptDeviceKey).toHaveBeenCalledExactlyOnceWith(jwk, value.devicePublicKey);
  expect(api.loadDeviceKey).not.toHaveBeenCalled();
  const body = JSON.parse(transport.mock.calls[1]![1]!.body as string);
  expect(body).toEqual({
    requestId: value.requestId,
    kind: "portal",
    name: value.name,
    secret: value.secret,
    deviceKey: { publicKey: value.devicePublicKey, challenge: CHALLENGE, signature: expect.any(String) },
    identityToken: value.identityToken,
    proof: value.proof,
  });
  const transcript = enrollmentSignatureTranscript({
    requestId: value.requestId,
    kind: "portal",
    name: value.name,
    gatewaySpkiFingerprint: SPKI,
    challenge: CHALLENGE,
    devicePublicKey: value.devicePublicKey,
  });
  expect(verifyDeviceSignature(value.devicePublicKey, transcript, body.deviceKey.signature)).toBe(
    true,
  );
  expect(api.login).toHaveBeenCalledExactlyOnceWith("SYNTHETIC-CODE");
  // The browser keeps the name its device row was created with.
  expect(api.setPortalDeviceName).toHaveBeenCalledExactlyOnceWith(value.name);
  expect(storage.size).toBe(0);
});

test("a handed-over sign-in the gateway holds shows the comparison code and polls for approval", async () => {
  const { value, code } = await handed();
  transport
    .mockResolvedValueOnce(challenge())
    .mockResolvedValueOnce(answer(code, "pending"))
    .mockImplementation(async () => answer(code, "pending"));
  await show();
  await vi.waitFor(async () => {
    await settle();
    expect(norm(host.textContent)).toContain(code);
  });
  expect(norm(host.textContent)).toContain("Check that this code matches the one shown on your other device, then approve it there.");
  await vi.waitFor(() =>
    expect(transport.mock.calls.map(([path]) => path)).toContain("/devices/account/poll"),
  );
  const poll = transport.mock.calls.find(([path]) => path === "/devices/account/poll")!;
  expect(JSON.parse(poll[1]!.body as string)).toEqual({
    requestId: value.requestId,
    secret: value.secret,
  });
  expect(api.setPortalDeviceName).toHaveBeenCalledExactlyOnceWith(value.name);
  expect(api.login).not.toHaveBeenCalled();
});

test("a handed-over sign-in that cannot be used fails safely and leaves the normal sign-in", async () => {
  const failures: Array<{
    altered?: Record<string, unknown>;
    encoded?: string;
    config?: Record<string, unknown>;
    key?: unknown;
    responses?: Response[];
    message: string;
  }> = [
    { altered: { v: 2 }, message: "Couldn't finish signing in" },
    { encoded: "%%%", message: "Couldn't finish signing in" },
    { config: { ...config, gatewayFingerprint: "invalid" }, message: "Couldn't finish signing in" },
    { config: { ...config, gatewayFingerprint: undefined }, message: "Couldn't finish signing in" },
    // The browser could not keep the key, or it is not the key the sign-in names.
    { key: null, message: "sign-in key changed" },
    { key: { publicKey: "A".repeat(91) }, message: "sign-in key changed" },
    { responses: [new Response("refused", { status: 404 })], message: "Couldn't finish signing in" },
    {
      responses: [challenge(), new Response("refused", { status: 403 })],
      message: "Couldn't finish signing in",
    },
  ];
  for (const failure of failures) {
    await handed(failure.altered);
    if (failure.encoded) {
      api.takeAccountSignIn.mockReset();
      api.takeAccountSignIn.mockReturnValueOnce(failure.encoded);
    }
    if (failure.config) api.cloudPairingConfig.mockResolvedValueOnce(failure.config);
    if (failure.key !== undefined) api.adoptDeviceKey.mockResolvedValue(failure.key);
    transport.mockReset();
    for (const response of failure.responses ?? []) transport.mockResolvedValueOnce(response);
    await show();
    await alerted(failure.message);
    expect(host.querySelector("button")?.textContent).toContain("Sign in with Passkey");
    expect(api.login).not.toHaveBeenCalled();
    expect(api.setPortalDeviceName).not.toHaveBeenCalled();
    render(null, host);
  }
});

test("a gateway without automatic enrollment drops the handed-over sign-in without a trace", async () => {
  for (const value of [
    { ...config, automaticEnrollment: false },
    { ...config, accountSignIn: false },
    { ...config, gatewaySpkiFingerprint: undefined },
    { ...config, webSignIn: false },
  ]) {
    await handed();
    api.cloudPairingConfig.mockResolvedValueOnce(value);
    await show();
    await settle();
    expect(api.takeAccountSignIn).toHaveBeenCalled();
    expect(api.adoptDeviceKey).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    api.takeAccountSignIn.mockClear();
    render(null, host);
  }
});

test("a view that is gone before its configuration arrives leaves the handed-over sign-in untouched", async () => {
  let deliver!: (value: typeof config) => void;
  api.cloudPairingConfig.mockReturnValueOnce(
    new Promise((resolve) => {
      deliver = resolve;
    }),
  );
  await show();
  render(null, host);
  deliver(config);
  await settle();
  expect(api.takeAccountSignIn).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

test("leaving the page while the gateway's answer is checked abandons the handed-over sign-in", async () => {
  const { code } = await handed();
  transport
    .mockResolvedValueOnce(challenge())
    .mockResolvedValueOnce(answer(code, "approved", { pairingCode: "SYNTHETIC-CODE" }));
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  const subtle = Object.create(webcrypto.subtle);
  // Signing still works; only the hashes made after the gateway answered are held.
  subtle.digest = async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
    if (transport.mock.calls.length >= 2) {
      waiting = true;
      await held;
    }
    return webcrypto.subtle.digest(...args);
  };
  for (const name of ["sign", "importKey", "exportKey", "generateKey"] as const)
    subtle[name] = (webcrypto.subtle[name] as (...args: unknown[]) => unknown).bind(webcrypto.subtle);
  vi.stubGlobal("crypto", { ...webcrypto, subtle });
  await show();
  await vi.waitFor(async () => {
    await settle();
    expect(waiting).toBe(true);
  });
  render(null, host);
  // The answer checks out, but nobody is waiting for it any more.
  release!();
  await settle();
  await settle();
  expect(api.login).not.toHaveBeenCalled();
  expect(location.reload).not.toHaveBeenCalled();
  expect(host.textContent).toBe("");
});
