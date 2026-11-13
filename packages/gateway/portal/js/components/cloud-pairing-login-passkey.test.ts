// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The portal's passkey sign-in on the gateway's own page (`gateway-passkey`).

import { webcrypto } from "node:crypto";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { enrollmentSignatureTranscript, verifyDeviceSignature } from "@omnesis/cloud-relay";
const api = vi.hoisted(() => ({
  cloudPairingConfig: vi.fn(),
  login: vi.fn(),
  loadDeviceKey: vi.fn(),
  proof: vi.fn(),
  approve: vi.fn(),
  here: vi.fn((origin: unknown) => origin === "https://g-abcdefgh.relay.example.test"),
  supported: vi.fn(() => true),
}));
vi.mock("../lib/device-key-store.js", () => ({ loadDeviceKey: api.loadDeviceKey }));
vi.mock("../lib/cloud-pairing-api.js", () => ({ cloudPairingConfig: api.cloudPairingConfig }));
vi.mock("../api.js", () => ({ login: api.login }));
vi.mock("../lib/storage.js", () => ({ portalDeviceName: () => "Fictional browser" }));
vi.mock("../lib/gateway-passkey.js", () => ({
  gatewayPasskeyProof: api.proof,
  approveWithPasskey: api.approve,
  onGatewayOrigin: api.here,
  passkeysSupported: api.supported,
}));
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { CloudPairingLogin } from "./cloud-pairing-login.js";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { base64url, cloudPairingVerificationCode } from "../lib/cloud-pairing.js";

const ORIGIN = "https://g-abcdefgh.relay.example.test";
const SPKI = "c".repeat(64);
const NONCE = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk";
const CHALLENGE = "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs";
const config = {
  clientId: "fictional-client",
  gatewayFingerprint: "a".repeat(64),
  webSignIn: true,
  accountSignIn: true,
  automaticEnrollment: true,
  gatewaySpkiFingerprint: SPKI,
  authorizationRelayOrigin: "https://relay.example.test",
  gatewayPasskey: { rpId: "relay.example.test", origin: ORIGIN },
};
const proof = { type: "gateway-passkey", challenge: CHALLENGE, credential: { id: "fictional" } };
const location = { href: `${ORIGIN}/portal/`, assign: vi.fn(), reload: vi.fn() };
const transport = vi.fn<typeof fetch>();
let host: HTMLElement;
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  Object.defineProperty(parsed.window, "location", { value: location, configurable: true });
  Object.defineProperty(parsed.window, "history", {
    value: { replaceState: vi.fn() },
    configurable: true,
  });
  vi.stubGlobal("window", parsed.window);
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", transport);
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  location.href = `${ORIGIN}/portal/`;
  location.assign.mockClear();
  location.reload.mockClear();
  for (const mock of [
    api.cloudPairingConfig,
    api.login,
    api.loadDeviceKey,
    api.proof,
    api.approve,
    transport,
  ])
    mock.mockReset();
  api.cloudPairingConfig.mockResolvedValue(config);
  api.login.mockResolvedValue({ ok: true });
  api.proof.mockResolvedValue(proof);
  api.here.mockImplementation((origin: unknown) => origin === ORIGIN);
  api.supported.mockReturnValue(true);
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
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;
const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ");
async function deviceKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: base64url(await webcrypto.subtle.exportKey("spki", pair.publicKey)),
  };
}
/** The gateway's two answers: the ceremony, then the request's outcome. */
function answers(status: "approved" | "pending", request?: (body: any) => Promise<string>) {
  transport.mockImplementation(async (path, init) => {
    const body = JSON.parse(init!.body as string);
    if (path === "/devices/account/passkey/options")
      return new Response(JSON.stringify({ origin: ORIGIN, challenge: CHALLENGE, body }));
    const code = await (request ?? (async () => ""))(body);
    return new Response(
      JSON.stringify({
        status,
        verificationCode: code,
        codeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        ...(status === "approved" ? { pairingCode: "SYNTHETIC-CODE" } : {}),
      }),
    );
  });
}
async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    check();
  });
}

test("on the gateway's own page, a passkey signs in here; the account page stays one click away", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  await show();
  expect(button("Sign in with Passkey")).toBeDefined();
  expect(button("Sign in on the Omnesis account page")).toBeDefined();
  let sent: any;
  answers("approved", async (body) => {
    sent = body;
    return cloudPairingVerificationCode(body, config.gatewayFingerprint, NONCE);
  });
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() => expect(location.reload).toHaveBeenCalledOnce());
  expect(transport.mock.calls.map(([path]) => path)).toEqual([
    "/devices/account/passkey/options",
    "/devices/account/request",
  ]);
  const options = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(options).toEqual({
    requestId: sent.requestId,
    kind: "portal",
    name: "Fictional browser",
    secret: sent.secret,
    devicePublicKey: key.publicKey,
  });
  // The assertion answers the ceremony's challenge, which the device key signs too.
  expect(api.proof).toHaveBeenCalledWith(
    expect.objectContaining({ challenge: CHALLENGE }),
    expect.anything(),
  );
  expect(sent).toMatchObject({ proof, deviceKey: { publicKey: key.publicKey, challenge: CHALLENGE } });
  expect(sent).not.toHaveProperty("identityToken");
  const transcript = enrollmentSignatureTranscript({
    requestId: sent.requestId,
    kind: "portal",
    name: sent.name,
    gatewaySpkiFingerprint: SPKI,
    challenge: CHALLENGE,
    devicePublicKey: key.publicKey,
  });
  expect(verifyDeviceSignature(key.publicKey, transcript, sent.deviceKey.signature)).toBe(true);
  expect(api.login).toHaveBeenCalledExactlyOnceWith("SYNTHETIC-CODE");
  // The account page is still there for a passkey this gateway doesn't know yet.
  render(null, host);
  transport.mockReset();
  transport.mockResolvedValue(new Response(JSON.stringify({ authorizationUrl: "x" })));
  await show();
  await act(async () => button("Sign in on the Omnesis account page")!.click());
  expect(transport.mock.calls[0]![0]).toBe("/devices/account/authorize");
});

test("a held passkey sign-in shows the comparison code", async () => {
  api.loadDeviceKey.mockResolvedValue(await deviceKey());
  await show();
  let code = "";
  answers("pending", async (body) => {
    code = await cloudPairingVerificationCode(body, config.gatewayFingerprint, NONCE);
    return code;
  });
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() => expect(norm(host.textContent)).toContain("Confirm this browser"));
  expect(code).toMatch(/^[0-9]{3} [0-9]{3}$/);
  expect(norm(host.textContent)).toContain(code);
});

test("a passkey the gateway doesn't recognise, a closed prompt or a refused start each say what to do", async () => {
  api.loadDeviceKey.mockResolvedValue(await deviceKey());
  await show();
  transport.mockImplementation(async (path) =>
    path === "/devices/account/passkey/options"
      ? new Response(JSON.stringify({ challenge: CHALLENGE }))
      : new Response("{}", { status: 401 }),
  );
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Your gateway didn't recognise that passkey.",
    ),
  );
  api.proof.mockRejectedValueOnce(new Error("The passkey prompt was closed or timed out. Try again."));
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "The passkey prompt was closed or timed out. Try again.",
    ),
  );
  transport.mockResolvedValue(new Response("{}", { status: 404 }));
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't start sign-in. Please try again.",
    ),
  );
  expect(api.login).not.toHaveBeenCalled();
  // A second press while the first is in flight does nothing.
  let release!: (value: Response) => void;
  transport.mockReset();
  transport.mockReturnValue(new Promise((resolve) => (release = resolve)));
  const pressed = button("Sign in with Passkey")!;
  await act(async () => pressed.click());
  await act(async () => button("Waiting for your passkey")!.click());
  expect(transport).toHaveBeenCalledOnce();
  await act(async () => release(new Response("{}", { status: 500 })));
});

test("leaving the page while the prompt is open ends the attempt quietly", async () => {
  api.loadDeviceKey.mockResolvedValue(await deviceKey());
  await show();
  let answer!: (value: unknown) => void;
  api.proof.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  answers("approved");
  await act(async () => button("Sign in with Passkey")!.click());
  render(null, host);
  await act(async () => answer(proof));
  expect(transport.mock.calls.map(([path]) => path)).toEqual(["/devices/account/passkey/options"]);
  // A prompt that fails after the page was left says nothing either.
  await show();
  let fail!: (error: Error) => void;
  api.proof.mockReturnValue(new Promise((_, reject) => (fail = reject)));
  await act(async () => button("Sign in with Passkey")!.click());
  render(null, host);
  await act(async () => fail(new Error("closed")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("elsewhere, without passkeys or without an origin of its own, sign-in goes through the account page", async () => {
  for (const setup of [
    () => api.here.mockReturnValue(false),
    () => api.supported.mockReturnValue(false),
    () => api.cloudPairingConfig.mockResolvedValue({ ...config, gatewayPasskey: undefined }),
    () => api.cloudPairingConfig.mockResolvedValue({ ...config, automaticEnrollment: false }),
  ]) {
    setup();
    await show();
    expect(button("Sign in with Passkey")).toBeDefined();
    expect(button("Sign in on the Omnesis account page")).toBeUndefined();
    render(null, host);
    api.here.mockImplementation((origin: unknown) => origin === ORIGIN);
    api.supported.mockReturnValue(true);
    api.cloudPairingConfig.mockResolvedValue(config);
  }
});

test("a held request is approved right here with the owner's passkey, and the browser then logs in", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  await show();
  let code = "";
  let approved = false;
  transport.mockImplementation(async (path, init) => {
    const body = JSON.parse(init!.body as string);
    if (path === "/devices/account/passkey/options")
      return new Response(JSON.stringify({ origin: ORIGIN, challenge: CHALLENGE }));
    if (path === "/devices/account/request")
      code = await cloudPairingVerificationCode(body, config.gatewayFingerprint, NONCE);
    return new Response(
      JSON.stringify({
        status: approved ? "approved" : "pending",
        verificationCode: code,
        codeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        ...(approved ? { pairingCode: "SYNTHETIC-CODE" } : {}),
      }),
    );
  });
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() => expect(button("Approve with your passkey")).toBeDefined());
  api.approve.mockImplementationOnce(async () => {
    approved = true;
  });
  await act(async () => button("Approve with your passkey")!.click());
  await settle(() => expect(api.login).toHaveBeenCalledExactlyOnceWith("SYNTHETIC-CODE"));
  expect(api.approve).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    deviceKey: key.privateKey,
  });
  expect(location.reload).toHaveBeenCalled();
});

test("approving here needs this browser's own key, and a refusal is said in place", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  await show();
  answers("pending", async (body) =>
    cloudPairingVerificationCode(body, config.gatewayFingerprint, NONCE),
  );
  await act(async () => button("Sign in with Passkey")!.click());
  await settle(() => expect(button("Approve with your passkey")).toBeDefined());
  api.approve.mockRejectedValueOnce(new Error("Your gateway didn't accept that passkey."));
  await act(async () => button("Approve with your passkey")!.click());
  await settle(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Your gateway didn't accept that passkey.",
    ),
  );
  api.loadDeviceKey.mockResolvedValue(await deviceKey());
  await act(async () => button("Approve with your passkey")!.click());
  await settle(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "This browser's sign-in key changed. Start again.",
    ),
  );
  api.loadDeviceKey.mockResolvedValue(null);
  await act(async () => button("Approve with your passkey")!.click());
  await settle(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "This browser's sign-in key changed. Start again.",
    ),
  );
  expect(api.approve).toHaveBeenCalledOnce();
  // While it runs, a second press does nothing.
  api.loadDeviceKey.mockResolvedValue(key);
  let release!: () => void;
  api.approve.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
  const pressed = button("Approve with your passkey")!;
  await act(async () => pressed.click());
  await act(async () => button("Waiting for your passkey")!.click());
  expect(api.approve).toHaveBeenCalledTimes(2);
  await act(async () => release());
});

test("leaving the page while the gateway's answer is being checked ends the attempt quietly", async () => {
  api.loadDeviceKey.mockResolvedValue(await deviceKey());
  await show();
  let left = false;
  transport.mockImplementation(async (path) => {
    if (path === "/devices/account/passkey/options")
      return new Response(JSON.stringify({ origin: ORIGIN, challenge: CHALLENGE }));
    const value = {
      status: "approved",
      verificationCode: "",
      expiresAt: Date.now() + 60_000,
      pairingCode: "SYNTHETIC-CODE",
      // The page is left just as the browser starts checking the gateway's nonce.
      get codeNonce() {
        if (!left) {
          left = true;
          render(null, host);
        }
        return NONCE;
      },
    };
    return { ok: true, status: 200, json: async () => value } as unknown as Response;
  });
  await act(async () => button("Sign in with Passkey")!.click());
  await vi.waitFor(() => expect(left).toBe(true));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(api.login).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
