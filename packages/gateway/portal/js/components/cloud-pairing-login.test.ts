// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { webcrypto } from "node:crypto";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ cloudPairingConfig: vi.fn(), login: vi.fn(), portalDeviceName: vi.fn(() => "Fictional browser") }));
vi.mock("../lib/cloud-pairing-api.js", () => ({ cloudPairingConfig: api.cloudPairingConfig }));
vi.mock("../api.js", () => ({ login: api.login }));
vi.mock("../lib/storage.js", () => ({ portalDeviceName: api.portalDeviceName }));
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { CloudPairingLogin } from "./cloud-pairing-login.js";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { cloudPairingVerificationCode, newCloudPairing, GOOGLE_PAIRING_STORAGE_KEY } from "../lib/cloud-pairing.js";
let host: HTMLElement;
let storage: Map<string, string>;
const location = { href: "https://gateway.example.test/portal/", assign: vi.fn(), reload: vi.fn() };
const config = { clientId: "fictional-client", gatewayFingerprint: "a".repeat(64), webSignIn: true,
  webOrigin: "https://gateway.example.test" };
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  Object.defineProperty(parsed.window, "location", { value: location, configurable: true });
  Object.defineProperty(parsed.window, "history", { value: { replaceState: vi.fn() }, configurable: true });
  vi.stubGlobal("window", parsed.window); vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", transport);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  storage = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  location.href = "https://gateway.example.test/portal/"; location.assign.mockClear(); location.reload.mockClear();
  api.cloudPairingConfig.mockReset(); api.cloudPairingConfig.mockResolvedValue(config);
  api.login.mockReset(); api.login.mockResolvedValue({ ok: true });
  transport.mockReset();
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function show() {
  await act(async () => render(h(CloudPairingLogin, {}), host));
  await act(async () => { await Promise.resolve(); });
}
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label)) as HTMLButtonElement;
async function returned(status = "approved", altered: Record<string, unknown> = {}) {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint);
  transport.mockResolvedValue(new Response(JSON.stringify({ status, verificationCode: code,
    expiresAt: Date.now() + 60_000, pairingCode: "SYNTHETIC-CODE", ...altered })));
  await show();
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain(code);
    expect(transport).toHaveBeenCalled();
  });
  await act(async () => { await Promise.resolve(); });
  return pending;
}
async function compare() {
  await act(async () => {
    const input = host.querySelector("input") as HTMLInputElement;
    input.checked = true; input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
test("configuration stays optional and unavailable sign-in leaves token login available", async () => {
  for (const value of [null, { ...config, webSignIn: false }, { ...config, webOrigin: "https://other-gateway.example.test" }]) {
    api.cloudPairingConfig.mockResolvedValueOnce(value); await show(); expect(host.textContent).toBe(""); render(null, host);
  }
  api.cloudPairingConfig.mockRejectedValueOnce(new Error("unavailable"));
  await show(); expect(host.textContent).toBe("");
});
test("starts Google only after saving an isolated private browser challenge, without putting its secret in the URL", async () => {
  transport.mockResolvedValue(new Response(JSON.stringify({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional" })));
  await show();
  const mark = button("Continue with Google").querySelector("img");
  expect(mark?.getAttribute("src")).toBe("/portal/img/google-sign-in-mark.png");
  expect(mark?.getAttribute("alt")).toBe("");
  expect(mark?.getAttribute("aria-hidden")).toBe("true");
  await act(async () => button("Continue with Google").click());
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(location.assign).toHaveBeenCalled(); });
  const [path, init] = transport.mock.calls[0]!;
  expect(path).toBe("/devices/google/authorize");
  const body = JSON.parse(init!.body as string);
  expect(body).toMatchObject({ name: "Fictional browser" }); expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(body).not.toHaveProperty("redirectUri");
  expect(storage.get(GOOGLE_PAIRING_STORAGE_KEY)).toContain(body.secret);
  expect(location.assign).toHaveBeenCalledExactlyOnceWith("https://accounts.google.com/o/oauth2/v2/auth?state=fictional");
  expect(location.assign.mock.calls[0]![0]).not.toContain(body.secret);
});
test("a failed start or unsafe authorization destination never navigates away", async () => {
  for (const response of [new Response("refused", { status: 429 }),
    new Response(JSON.stringify({ authorizationUrl: "https://attacker.example.test" }))]) {
    transport.mockResolvedValueOnce(response); await show();
    await act(async () => button("Continue with Google").click());
    await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(host.querySelector('[role="alert"]')).not.toBeNull(); });
    expect(location.assign).not.toHaveBeenCalled(); render(null, host);
  }
});
test("a callback without this tab's private challenge fails closed", async () => {
  location.href += "?googlePairing=failed";
  await show(); expect(host.textContent).toContain("expired or was cancelled");
  expect(transport).not.toHaveBeenCalled(); expect(api.login).not.toHaveBeenCalled();
});
test("Google approval alone cannot log in; explicit local comparison is required before consuming a pairing code", async () => {
  const pending = await returned();
  expect(host.textContent).toContain("domain administrator remains part of that trust");
  expect(host.textContent).toContain("Approved by your gateway");
  expect(button("Pair this browser").disabled).toBe(true);
  await act(async () => button("Pair this browser").click()); expect(api.login).not.toHaveBeenCalled();
  await compare(); expect(button("Pair this browser").disabled).toBe(false);
  await act(async () => button("Pair this browser").click());
  expect(api.login).toHaveBeenCalledExactlyOnceWith("SYNTHETIC-CODE");
  expect(location.reload).toHaveBeenCalledOnce(); expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
  const poll = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(poll).toEqual({ requestId: pending.requestId, secret: pending.secret });
});
test("wrong gateway code, unknown status, expiry, missing approval credential and transport failures never enable login", async () => {
  for (const altered of [{ verificationCode: "FFFF-FFFF-FFFF-FFFF-FFFF" }, { status: "untrusted" },
    { expiresAt: Date.now() - 1 }, { pairingCode: null }]) {
    location.href = "https://gateway.example.test/portal/"; await returned("approved", altered);
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });
    await compare(); expect(button("Pair this browser").disabled).toBe(true);
    expect(api.login).not.toHaveBeenCalled(); render(null, host);
  }
  location.href = "https://gateway.example.test/portal/";
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending)); location.href += `?googlePairing=${pending.requestId}`;
  transport.mockResolvedValue(new Response("refused", { status: 401 })); await show();
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(host.querySelector('[role="alert"]')).not.toBeNull(); });
  expect(api.login).not.toHaveBeenCalled();
});
test("pending and denied requests cannot log in and cancellation removes the private challenge", async () => {
  await returned("pending"); await compare(); expect(button("Pair this browser").disabled).toBe(true);
  await act(async () => button("Cancel").click());
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
  expect(button("Continue with Google")).not.toBeNull();
  render(null, host); location.href = "https://gateway.example.test/portal/";
  await returned("denied"); expect(host.textContent).toContain("denied this request");
  expect(button("Pair this browser").disabled).toBe(true); expect(api.login).not.toHaveBeenCalled();
});
test("a refused device-code login is shown and can be retried without bypassing approval", async () => {
  await returned(); await compare(); api.login.mockResolvedValueOnce({ ok: false });
  await act(async () => button("Pair this browser").click());
  expect(host.textContent).toContain("Couldn't pair this browser"); expect(location.reload).not.toHaveBeenCalled();
  await act(async () => button("Pair this browser").click()); expect(location.reload).toHaveBeenCalledOnce();
});
test("does not start duplicate authorizations while the first request is in flight", async () => {
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  await show();
  await act(async () => button("Continue with Google").click());
  await act(async () => button("Opening Google").click());
  expect(transport).toHaveBeenCalledOnce();
  release(new Response("refused", { status: 429 }));
  await act(async () => { await Promise.resolve(); });
});
test("visibility polling with no request sends nothing, and an outstanding request stops when it expires", async () => {
  await show();
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
  expect(transport).not.toHaveBeenCalled(); render(null, host);
  const pending = await returned("pending");
  vi.useFakeTimers({ now: pending.expiresAt + 1 });
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
  expect(host.textContent).toContain("pairing request expired");
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
  expect(button("Continue with Google")).not.toBeNull();
});
test("unmounting while the local verification code is calculated cannot revive the abandoned request", async () => {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  let release!: (digest: ArrayBuffer) => void;
  const calculate = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { release = resolve; }));
  vi.stubGlobal("crypto", { ...webcrypto, subtle: { digest: calculate } });
  await show(); expect(calculate).toHaveBeenCalledOnce();
  render(null, host);
  release(new ArrayBuffer(32));
  await act(async () => { await Promise.resolve(); });
  expect(calculate).toHaveBeenCalledTimes(2);
  release(new ArrayBuffer(32));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toBe(""); expect(transport).not.toHaveBeenCalled();
});

test("polling is single-flight and a cancelled response cannot approve or overwrite a later attempt", async () => {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending)); location.href += `?googlePairing=${pending.requestId}`;
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  await show();
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(transport).toHaveBeenCalledOnce(); });
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  expect(transport).toHaveBeenCalledOnce();
  const signal = transport.mock.calls[0]![1]!.signal!;
  await act(async () => button("Cancel").click()); expect(signal.aborted).toBe(true);
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=second" })));
  await act(async () => button("Continue with Google").click());
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(location.assign).toHaveBeenCalledOnce(); });
  const newer = storage.get(GOOGLE_PAIRING_STORAGE_KEY);
  expect(newer).not.toContain(pending.requestId);
  release(new Response(JSON.stringify({ status: "approved", verificationCode: code,
    expiresAt: Date.now() + 60_000, pairingCode: "CANCELLED-CODE" })));
  await act(async () => { await Promise.resolve(); });
  expect(storage.get(GOOGLE_PAIRING_STORAGE_KEY)).toBe(newer);
  expect(host.textContent).not.toContain("Approved by your gateway"); expect(api.login).not.toHaveBeenCalled();
});

test("unmount aborts in-flight sign-in and polling, and late failures cannot update a new view", async () => {
  await show(); let fail!: (reason: Error) => void;
  transport.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  await act(async () => button("Continue with Google").click());
  const authorizationSignal = transport.mock.calls[0]![1]!.signal!;
  render(null, host); expect(authorizationSignal.aborted).toBe(true);
  fail(new Error("Abandoned authorization")); await act(async () => { await Promise.resolve(); });
  await show(); expect(host.textContent).not.toContain("Abandoned authorization");
  render(null, host); transport.mockReset();
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending)); location.href += `?googlePairing=${pending.requestId}`;
  transport.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  await show();
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(transport).toHaveBeenCalledOnce(); });
  const pollingSignal = transport.mock.calls[0]![1]!.signal!;
  render(null, host); expect(pollingSignal.aborted).toBe(true);
  fail(new Error("Abandoned polling")); await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toBe(""); expect(api.login).not.toHaveBeenCalled();
});

test("a late authorization response after unmount cannot save a challenge or navigate", async () => {
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  await show(); await act(async () => button("Continue with Google").click());
  render(null, host);
  release(new Response(JSON.stringify({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abandoned" })));
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(transport).toHaveBeenCalledOnce(); });
  expect(location.assign).not.toHaveBeenCalled(); expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
});

test("an old callback's delayed local hash cannot restore its request over a new Google authorization", async () => {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending)); location.href += `?googlePairing=${pending.requestId}`;
  const releases: Array<(value: ArrayBuffer) => void> = [];
  vi.stubGlobal("crypto", { randomUUID: () => webcrypto.randomUUID(),
    getRandomValues: (value: Uint8Array) => webcrypto.getRandomValues(value),
    subtle: { digest: () => new Promise<ArrayBuffer>((resolve) => releases.push(resolve)) } });
  await show(); expect(releases).toHaveLength(1);
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=newer" })));
  await act(async () => button("Continue with Google").click());
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(location.assign).toHaveBeenCalledOnce(); });
  releases[0]!(new ArrayBuffer(32));
  await act(async () => { await Promise.resolve(); });
  expect(releases).toHaveLength(2); releases[1]!(new ArrayBuffer(32));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).not.toContain("Confirm this browser");
  expect(storage.get(GOOGLE_PAIRING_STORAGE_KEY)).not.toContain(pending.requestId);
  expect(transport).toHaveBeenCalledOnce(); expect(api.login).not.toHaveBeenCalled();
});
