// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { webcrypto } from "node:crypto";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  cloudPairingConfig: vi.fn(),
  login: vi.fn(),
  portalDeviceName: vi.fn(() => "Fictional browser"),
  loadDeviceKey: vi.fn(),
}));
vi.mock("../lib/device-key-store.js", () => ({ loadDeviceKey: api.loadDeviceKey }));
vi.mock("../lib/cloud-pairing-api.js", () => ({ cloudPairingConfig: api.cloudPairingConfig }));
vi.mock("../api.js", () => ({ login: api.login }));
vi.mock("../lib/storage.js", () => ({ portalDeviceName: api.portalDeviceName }));
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { CloudPairingLogin } from "./cloud-pairing-login.js";
import {
  cloudPairingVerificationCode,
  newCloudPairing,
  GOOGLE_PAIRING_STORAGE_KEY,
  // @ts-expect-error — portal JavaScript has no sibling declarations.
} from "../lib/cloud-pairing.js";
/** Rendered text with HTML whitespace collapsed, as a browser shows it. */
const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ");
let host: HTMLElement;
let storage: Map<string, string>;
const location = { href: "https://gateway.example.test/portal/", assign: vi.fn(), reload: vi.fn() };
const config = {
  clientId: "fictional-client",
  gatewayFingerprint: "a".repeat(64),
  webSignIn: true,
  webOrigin: "https://gateway.example.test",
};
const transport = vi.fn<typeof fetch>();
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
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  location.href = "https://gateway.example.test/portal/";
  location.assign.mockClear();
  location.reload.mockClear();
  api.cloudPairingConfig.mockReset();
  api.cloudPairingConfig.mockResolvedValue(config);
  api.login.mockReset();
  api.login.mockResolvedValue({ ok: true });
  api.loadDeviceKey.mockReset();
  api.loadDeviceKey.mockResolvedValue(null);
  transport.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function show() {
  await act(async () => render(h(CloudPairingLogin, {}), host));
  await act(async () => {
    await Promise.resolve();
  });
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  ) as HTMLButtonElement;
async function returned(status = "approved", altered: Record<string, unknown> = {}) {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        status,
        verificationCode: code,
        codeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        pairingCode: "SYNTHETIC-CODE",
        ...altered,
      }),
    ),
  );
  await show();
  // No code is on screen before the gateway's first answer brings its nonce.
  expect(host.querySelector(".cloud-pairing-code")).toBeNull();
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport).toHaveBeenCalled();
    if (Object.keys(altered).length === 0) expect(norm(host.textContent)).toContain(code);
    else expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  await act(async () => {
    await Promise.resolve();
  });
  // Wait for the poll's outcome to render, not just for the request to leave.
  const outcome = { approved: "Approved by your gateway", denied: "denied this request" }[status];
  if (outcome && Object.keys(altered).length === 0)
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(norm(host.textContent)).toContain(outcome);
    });
  return pending;
}

test("configuration stays optional and unavailable sign-in leaves token login available", async () => {
  for (const value of [
    null,
    { ...config, webSignIn: false },
    { ...config, webOrigin: "https://other-gateway.example.test" },
  ]) {
    api.cloudPairingConfig.mockResolvedValueOnce(value);
    await show();
    expect(host.textContent).toBe("");
    render(null, host);
  }
  api.cloudPairingConfig.mockRejectedValueOnce(new Error("unavailable"));
  await show();
  expect(host.textContent).toBe("");
});
test("starts Google only after saving an isolated private browser challenge, without putting its secret in the URL", async () => {
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
      }),
    ),
  );
  await show();
  // The older Google-only pairing has no Omnesis account to name.
  expect(host.querySelector("h2")).toBeNull();
  expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Google sign-in");
  const mark = button("Sign in with Google").querySelector("img");
  expect(mark?.getAttribute("src")).toBe("/portal/img/google-sign-in-mark.png");
  expect(mark?.getAttribute("alt")).toBe("");
  expect(mark?.getAttribute("aria-hidden")).toBe("true");
  await act(async () => button("Sign in with Google").click());
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(location.assign).toHaveBeenCalled();
  });
  const [path, init] = transport.mock.calls[0]!;
  expect(path).toBe("/devices/google/authorize");
  const body = JSON.parse(init!.body as string);
  expect(body).toMatchObject({ name: "Fictional browser" });
  expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(body).not.toHaveProperty("redirectUri");
  expect(storage.get(GOOGLE_PAIRING_STORAGE_KEY)).toContain(body.secret);
  expect(location.assign).toHaveBeenCalledExactlyOnceWith(
    "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
  );
  expect(location.assign.mock.calls[0]![0]).not.toContain(body.secret);
});
test("a failed start or unsafe authorization destination never navigates away", async () => {
  for (const response of [
    new Response("refused", { status: 429 }),
    new Response(JSON.stringify({ authorizationUrl: "https://attacker.example.test" })),
  ]) {
    transport.mockResolvedValueOnce(response);
    await show();
    await act(async () => button("Sign in with Google").click());
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(location.assign).not.toHaveBeenCalled();
    render(null, host);
  }
});
test("a callback without this tab's private challenge fails closed", async () => {
  location.href += "?googlePairing=failed";
  await show();
  expect(norm(host.textContent)).toContain("expired or was cancelled");
  expect(transport).not.toHaveBeenCalled();
  expect(api.login).not.toHaveBeenCalled();
});
test("Google approval alone cannot log in; explicit local comparison is required before consuming a pairing code", async () => {
  const pending = await returned();
  expect(norm(host.textContent)).toContain("domain administrator remains part of that trust");
  expect(norm(host.textContent)).toContain("Approved by your gateway");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(button("pair this device").disabled).toBe(false);
  await act(async () => button("pair this device").click());
  expect(api.login).toHaveBeenCalledExactlyOnceWith("SYNTHETIC-CODE");
  expect(location.reload).toHaveBeenCalledOnce();
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
  const poll = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(poll).toEqual({ requestId: pending.requestId, secret: pending.secret });
});
test("wrong gateway code, unknown status, expiry, missing approval credential and transport failures never enable login", async () => {
  for (const altered of [
    { verificationCode: "000 000" },
    // Another nonce makes another code than the one the reply claims.
    { codeNonce: "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY" },
    { codeNonce: "short" },
    { codeNonce: undefined },
    { status: "untrusted" },
    { expiresAt: Date.now() - 1 },
    { pairingCode: null },
  ]) {
    location.href = "https://gateway.example.test/portal/";
    await returned("approved", altered);
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });
    // No reply that fails a check ever puts a code or the pair action on screen.
    expect(host.querySelector(".cloud-pairing-code")).toBeNull();
    expect(button("pair this device")).toBeUndefined();
    if (!("pairingCode" in altered)) {
      // One that does not add up also ends the attempt.
      expect(norm(host.querySelector('[role="alert"]')?.textContent)).toContain(
        "The gateway or pairing request changed. Start again.",
      );
      expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
    }
    expect(api.login).not.toHaveBeenCalled();
    render(null, host);
  }
  location.href = "https://gateway.example.test/portal/";
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  transport.mockResolvedValue(new Response("refused", { status: 401 }));
  await show();
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(api.login).not.toHaveBeenCalled();
});
test("pending and denied requests cannot log in and cancellation removes the private challenge", async () => {
  await returned("pending");
  expect(button("pair this device").disabled).toBe(true);
  await act(async () => button("Cancel").click());
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
  expect(button("Sign in with Google")).not.toBeNull();
  render(null, host);
  location.href = "https://gateway.example.test/portal/";
  await returned("denied");
  expect(norm(host.textContent)).toContain("denied this request");
  expect(button("pair this device").disabled).toBe(true);
  expect(api.login).not.toHaveBeenCalled();
});
test("a refused device-code login is shown and can be retried without bypassing approval", async () => {
  await returned();
  api.login.mockResolvedValueOnce({ ok: false });
  await act(async () => button("pair this device").click());
  expect(norm(host.textContent)).toContain("Couldn't pair this browser");
  expect(location.reload).not.toHaveBeenCalled();
  await act(async () => button("pair this device").click());
  expect(location.reload).toHaveBeenCalledOnce();
});
test("does not start duplicate authorizations while the first request is in flight", async () => {
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await show();
  await act(async () => button("Sign in with Google").click());
  await act(async () => button("Opening Google").click());
  expect(transport).toHaveBeenCalledOnce();
  release(new Response("refused", { status: 429 }));
  await act(async () => {
    await Promise.resolve();
  });
});
test("visibility polling with no request sends nothing, and an outstanding request stops when it expires", async () => {
  await show();
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  expect(transport).not.toHaveBeenCalled();
  render(null, host);
  const pending = await returned("pending");
  vi.useFakeTimers({ now: pending.expiresAt + 1 });
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  expect(norm(host.textContent)).toContain("pairing request expired");
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
  expect(button("Sign in with Google")).not.toBeNull();
});
test("unmounting while the code is worked out from the gateway's answer cannot revive the abandoned request", async () => {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  transport.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          status: "approved",
          verificationCode: code,
          codeNonce: NONCE,
          expiresAt: Date.now() + 60_000,
          pairingCode: "SYNTHETIC-CODE",
        }),
      ),
  );
  let release!: (digest: ArrayBuffer) => void;
  const calculate = vi.fn(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("crypto", { ...webcrypto, subtle: { digest: calculate } });
  await show();
  await vi.waitFor(() => expect(calculate).toHaveBeenCalledOnce());
  // Nothing is shown while the answer is still being checked.
  expect(host.querySelector(".cloud-pairing-code")).toBeNull();
  expect(norm(host.textContent)).toContain("Checking this browser with your gateway.");
  render(null, host);
  release(new ArrayBuffer(32));
  await act(async () => {
    await Promise.resolve();
  });
  release(new ArrayBuffer(32));
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.textContent).toBe("");
  expect(transport).toHaveBeenCalledOnce();
  expect(api.login).not.toHaveBeenCalled();
});

test("polling is single-flight and a cancelled response cannot approve or overwrite a later attempt", async () => {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await show();
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  expect(transport).toHaveBeenCalledOnce();
  const signal = transport.mock.calls[0]![1]!.signal!;
  await act(async () => button("Cancel").click());
  expect(signal.aborted).toBe(true);
  transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=second",
      }),
    ),
  );
  await act(async () => button("Sign in with Google").click());
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(location.assign).toHaveBeenCalledOnce();
  });
  const newer = storage.get(GOOGLE_PAIRING_STORAGE_KEY);
  expect(newer).not.toContain(pending.requestId);
  release(
    new Response(
      JSON.stringify({
        status: "approved",
        verificationCode: code,
        codeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        pairingCode: "CANCELLED-CODE",
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(storage.get(GOOGLE_PAIRING_STORAGE_KEY)).toBe(newer);
  expect(host.textContent).not.toContain("Approved by your gateway");
  expect(api.login).not.toHaveBeenCalled();
});

test("unmount aborts in-flight sign-in and polling, and late failures cannot update a new view", async () => {
  await show();
  let fail!: (reason: Error) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      }),
  );
  await act(async () => button("Sign in with Google").click());
  const authorizationSignal = transport.mock.calls[0]![1]!.signal!;
  render(null, host);
  expect(authorizationSignal.aborted).toBe(true);
  fail(new Error("Abandoned authorization"));
  await act(async () => {
    await Promise.resolve();
  });
  await show();
  expect(host.textContent).not.toContain("Abandoned authorization");
  render(null, host);
  transport.mockReset();
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      }),
  );
  await show();
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  const pollingSignal = transport.mock.calls[0]![1]!.signal!;
  render(null, host);
  expect(pollingSignal.aborted).toBe(true);
  fail(new Error("Abandoned polling"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.textContent).toBe("");
  expect(api.login).not.toHaveBeenCalled();
});

test("a late authorization response after unmount cannot save a challenge or navigate", async () => {
  let release!: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await show();
  await act(async () => button("Sign in with Google").click());
  render(null, host);
  release(
    new Response(
      JSON.stringify({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abandoned",
      }),
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  expect(location.assign).not.toHaveBeenCalled();
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
});

test("an old request's late answer cannot restore it over a new Google authorization", async () => {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint);
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  let answer!: (response: Response) => void;
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  await show();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  // Still checking: the person gives up and signs in again.
  await act(async () => button("Cancel").click());
  transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=newer",
      }),
    ),
  );
  await act(async () => button("Sign in with Google").click());
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(location.assign).toHaveBeenCalledOnce();
  });
  answer(
    new Response(
      JSON.stringify({
        status: "approved",
        verificationCode: code,
        codeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        pairingCode: "SYNTHETIC-CODE",
      }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).not.toContain("Confirm this browser");
  expect(host.querySelector(".cloud-pairing-code")).toBeNull();
  expect(storage.get(GOOGLE_PAIRING_STORAGE_KEY)).not.toContain(pending.requestId);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(api.login).not.toHaveBeenCalled();
});

test("managed Google login uses the trusted relay launch and preserves its private challenge", async () => {
  const relay = "https://relay.example.test";
  const authorizationUrl =
    relay +
    "/_relay/v2/google/browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" +
    "a".repeat(43);
  api.cloudPairingConfig.mockResolvedValueOnce({ ...config, authorizationRelayOrigin: relay });
  transport.mockResolvedValue(new Response(JSON.stringify({ authorizationUrl })));
  await show();
  await act(async () => button("Sign in with Google").click());
  await vi.waitFor(() => expect(location.assign).toHaveBeenCalledExactlyOnceWith(authorizationUrl));
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(true);
});

test("neutral account sign-in offers Google and passkey choices and uses only the configured account authority", async () => {
  api.cloudPairingConfig.mockResolvedValueOnce({
    ...config,
    accountSignIn: true,
    authorizationRelayOrigin: "https://relay.example.test",
  });
  const destination =
    "https://relay.example.test/_relay/v3/account-browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" +
    "a".repeat(43);
  transport.mockResolvedValue(new Response(JSON.stringify({ authorizationUrl: destination })));
  await show();
  expect(host.querySelector("h2")?.textContent).toBe("Sign in with your Omnesis account");
  expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Omnesis account sign-in");
  expect(button("Sign in with Google").querySelector("img")).not.toBeNull();
  await act(async () => button("Sign in with Passkey").click());
  await vi.waitFor(() => expect(location.assign).toHaveBeenCalledWith(destination));
  expect(transport.mock.calls[0]![0]).toBe("/devices/account/authorize");
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(true);
});

test("account pairing polls the account route and refuses an approval that expires after render", async () => {
  api.cloudPairingConfig.mockResolvedValueOnce({ ...config, accountSignIn: true });
  await returned();
  expect(transport.mock.calls[0]![0]).toBe("/devices/account/poll");
  const pair = button("Codes match");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  await act(async () => pair.click());
  expect(api.login).not.toHaveBeenCalled();
});

// ── Automatic enrollment: this browser proves its own device key ──────────
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { base64url } from "../lib/cloud-pairing.js";
import {
  enrollmentSignatureTranscript,
  verifyDeviceSignature,
} from "@omnesis/cloud-relay";
const SPKI = "c".repeat(64);
const automatic = {
  ...config,
  accountSignIn: true,
  automaticEnrollment: true,
  gatewaySpkiFingerprint: SPKI,
  authorizationRelayOrigin: "https://relay.example.test",
};
// A nonce and the challenge that commits to it, from the vectors every platform shares.
const NONCE = "pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk";
const CHALLENGE = "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs";
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
/** Simulates the sign-in redirect: a saved request with this browser's key, then the page loads with ?googlePairing. */
async function returnedWithKey(
  key: { publicKey: string },
  responses: Array<(code: string) => Response>,
) {
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint, {
    devicePublicKey: key.publicKey,
    gatewaySpkiFingerprint: SPKI,
  });
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  for (const response of responses) transport.mockImplementationOnce(async () => response(code));
  api.cloudPairingConfig.mockResolvedValue(automatic);
  await show();
  return { pending, code };
}
const alerted = () =>
  vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

test("with automatic enrollment, sign-in starts with this browser's device key and keeps it for the return", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  api.cloudPairingConfig.mockResolvedValue(automatic);
  const destination =
    "https://relay.example.test/_relay/v3/account-browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" +
    "a".repeat(43);
  transport.mockResolvedValue(new Response(JSON.stringify({ authorizationUrl: destination })));
  await show();
  expect(norm(host.textContent)).toContain("joins right away or waits for your approval");
  await act(async () => button("Sign in with Google").click());
  await vi.waitFor(() => expect(location.assign).toHaveBeenCalledWith(destination));
  const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(body.devicePublicKey).toBe(key.publicKey);
  expect(JSON.parse(storage.get(GOOGLE_PAIRING_STORAGE_KEY)!)).toMatchObject({
    devicePublicKey: key.publicKey,
    gatewaySpkiFingerprint: SPKI,
  });
});
test("a browser that cannot keep a key, or a gateway without a TLS key fingerprint, falls back to an approved request", async () => {
  for (const value of [
    automatic,
    { ...automatic, gatewaySpkiFingerprint: "invalid" },
    { ...automatic, gatewaySpkiFingerprint: undefined },
    { ...automatic, accountSignIn: false },
  ]) {
    api.cloudPairingConfig.mockResolvedValue(value);
    transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authorizationUrl: value.accountSignIn
            ? "https://relay.example.test/_relay/v3/account-browser/begin?operationId=00000000-0000-4000-8000-000000000000&ticket=" +
              "a".repeat(43)
            : "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
        }),
      ),
    );
    await show();
    await act(async () => button("Sign in with Google").click());
    await vi.waitFor(() => expect(location.assign).toHaveBeenCalled());
    expect(JSON.parse(transport.mock.calls.at(-1)![1]!.body as string)).not.toHaveProperty(
      "devicePublicKey",
    );
    location.assign.mockClear();
    render(null, host);
  }
});
test("a trusted sign-in joins at once: the browser signs the gateway's challenge and logs in with no comparison", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  const { pending } = await returnedWithKey(key, [
    () => new Response(JSON.stringify({ challenge: CHALLENGE, expiresAt: Date.now() + 120_000 })),
    (code) =>
      new Response(
        JSON.stringify({
          status: "approved",
          verificationCode: code,
          codeNonce: NONCE,
          expiresAt: Date.now() + 60_000,
          pairingCode: "SYNTHETIC-CODE",
        }),
      ),
  ]);
  await vi.waitFor(() => expect(location.reload).toHaveBeenCalledOnce());
  expect(transport.mock.calls.map(([path]) => path)).toEqual([
    "/devices/account/challenge",
    "/devices/account/request",
  ]);
  const body = JSON.parse(transport.mock.calls[1]![1]!.body as string);
  expect(body).toMatchObject({
    requestId: pending.requestId,
    kind: "portal",
    name: pending.name,
    secret: pending.secret,
    deviceKey: { publicKey: key.publicKey, challenge: CHALLENGE },
  });
  const transcript = enrollmentSignatureTranscript({
    requestId: pending.requestId,
    kind: "portal",
    name: pending.name,
    gatewaySpkiFingerprint: SPKI,
    challenge: CHALLENGE,
    devicePublicKey: key.publicKey,
  });
  expect(verifyDeviceSignature(key.publicKey, transcript, body.deviceKey.signature)).toBe(true);
  expect(api.login).toHaveBeenCalledExactlyOnceWith("SYNTHETIC-CODE");
  expect(host.textContent).not.toContain("Confirm this browser");
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
});
test("a held request falls back to the comparison screen and keeps polling for approval", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint, {
    devicePublicKey: key.publicKey,
    gatewaySpkiFingerprint: SPKI,
  });
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  location.href += `?googlePairing=${pending.requestId}`;
  transport
    .mockResolvedValueOnce(new Response(JSON.stringify({ challenge: CHALLENGE })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "pending",
          verificationCode: code,
          codeNonce: NONCE,
          expiresAt: Date.now() + 60_000,
        }),
      ),
    )
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "pending",
          verificationCode: code,
          codeNonce: NONCE,
          expiresAt: Date.now() + 60_000,
        }),
      ),
    );
  api.cloudPairingConfig.mockResolvedValue(automatic);
  await show();
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(norm(host.textContent)).toContain(code);
  });
  expect(norm(host.textContent)).toContain("Check that this code matches the one shown on your other device, then approve it there.");
  expect(host.textContent).not.toContain("Google sign-in alone");
  await vi.waitFor(() =>
    expect(transport.mock.calls.map(([path]) => path)).toContain("/devices/account/poll"),
  );
  expect(api.login).not.toHaveBeenCalled();
});
test("every failure in the browser join stops safely with a readable error and forgets the request", async () => {
  const key = await deviceKey();
  const challenge = () => new Response(JSON.stringify({ challenge: CHALLENGE }));
  const cases: Array<{
    key: unknown;
    responses: Array<(code: string) => Response>;
    message: string;
    login?: { ok: boolean };
  }> = [
    { key: null, responses: [], message: "sign-in key changed" },
    { key: { ...key, publicKey: "A".repeat(91) }, responses: [], message: "sign-in key changed" },
    {
      key,
      responses: [() => new Response("refused", { status: 404 })],
      message: "Couldn't finish signing in",
    },
    {
      key,
      responses: [() => new Response(JSON.stringify({ challenge: "short" }))],
      message: "Couldn't finish signing in",
    },
    {
      key,
      responses: [challenge, () => new Response("refused", { status: 403 })],
      message: "Couldn't finish signing in",
    },
    {
      key,
      responses: [challenge, () => new Response("busy", { status: 429 })],
      message: "Too many devices are waiting for approval",
    },
    {
      // The nonce the reply reveals is not the one the challenge committed to.
      key,
      responses: [
        () =>
          new Response(
            JSON.stringify({ challenge: "wEUOKG6N5cyUL4rQwRITqBWidnd6RF3vjSxafblNF80" }),
          ),
        (code) =>
          new Response(
            JSON.stringify({
              status: "pending",
              verificationCode: code,
              codeNonce: NONCE,
              expiresAt: Date.now() + 60_000,
            }),
          ),
      ],
      message: "changed",
    },
    {
      // No nonce at all: nothing to check the challenge against.
      key,
      responses: [
        challenge,
        (code) =>
          new Response(
            JSON.stringify({
              status: "pending",
              verificationCode: code,
              expiresAt: Date.now() + 60_000,
            }),
          ),
      ],
      message: "changed",
    },
    {
      key,
      responses: [
        challenge,
        () =>
          new Response(
            JSON.stringify({
              status: "approved",
              verificationCode: "000 000",
              codeNonce: NONCE,
              expiresAt: Date.now() + 60_000,
              pairingCode: "X",
            }),
          ),
      ],
      message: "changed",
    },
    {
      key,
      responses: [
        challenge,
        (code) =>
          new Response(
            JSON.stringify({
              status: "approved",
              verificationCode: code,
              codeNonce: NONCE,
              expiresAt: Date.now() - 1,
              pairingCode: "X",
            }),
          ),
      ],
      message: "changed",
    },
    {
      key,
      responses: [
        challenge,
        (code) =>
          new Response(
            JSON.stringify({
              status: "approved",
              verificationCode: code,
              codeNonce: NONCE,
              expiresAt: "soon",
              pairingCode: "X",
            }),
          ),
      ],
      message: "changed",
    },
    {
      key,
      responses: [
        challenge,
        (code) =>
          new Response(
            JSON.stringify({
              status: "denied",
              verificationCode: code,
              codeNonce: NONCE,
              expiresAt: Date.now() + 60_000,
            }),
          ),
      ],
      message: "didn't accept",
    },
    {
      key,
      responses: [
        challenge,
        (code) =>
          new Response(
            JSON.stringify({
              status: "approved",
              verificationCode: code,
              codeNonce: NONCE,
              expiresAt: Date.now() + 60_000,
              pairingCode: "",
            }),
          ),
      ],
      message: "didn't accept",
    },
    {
      key,
      responses: [
        challenge,
        (code) =>
          new Response(
            JSON.stringify({
              status: "approved",
              verificationCode: code,
              codeNonce: NONCE,
              expiresAt: Date.now() + 60_000,
              pairingCode: "X",
            }),
          ),
      ],
      message: "Couldn't sign this browser in",
      login: { ok: false },
    },
  ];
  for (const item of cases) {
    api.loadDeviceKey.mockResolvedValue(item.key);
    api.login.mockResolvedValue(item.login ?? { ok: true });
    location.href = "https://gateway.example.test/portal/";
    transport.mockReset();
    const pending = newCloudPairing("Fictional browser", config.gatewayFingerprint, {
      devicePublicKey: key.publicKey,
      gatewaySpkiFingerprint: SPKI,
    });
    const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
    storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
    location.href += `?googlePairing=${pending.requestId}`;
    for (const response of item.responses)
      transport.mockImplementationOnce(async () => response(code));
    api.cloudPairingConfig.mockResolvedValue(automatic);
    await show();
    await alerted();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(item.message);
    expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(false);
    expect(location.reload).not.toHaveBeenCalled();
    expect(button("Sign in with Google")).toBeDefined();
    render(null, host);
  }
});
test("leaving the page during the join cannot sign in or show a late result", async () => {
  const key = await deviceKey();
  api.loadDeviceKey.mockResolvedValue(key);
  let release!: (response: Response) => void;
  const { pending, code } = await returnedWithKey(key, [
    () => new Response(JSON.stringify({ challenge: CHALLENGE })),
  ]);
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  render(null, host);
  release(
    new Response(
      JSON.stringify({
        status: "approved",
        verificationCode: code,
        codeNonce: NONCE,
        expiresAt: Date.now() + 60_000,
        pairingCode: "LATE",
      }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(api.login).not.toHaveBeenCalled();
  expect(location.reload).not.toHaveBeenCalled();
  // A failure that arrives after the page moved on leaves no error behind.
  let fail!: (reason: Error) => void;
  location.href = `https://gateway.example.test/portal/?googlePairing=${pending.requestId}`;
  storage.set(GOOGLE_PAIRING_STORAGE_KEY, JSON.stringify(pending));
  transport.mockReset();
  transport.mockImplementationOnce(
    () =>
      new Promise<Response>((_resolve, reject) => {
        fail = reject;
      }),
  );
  await show();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  render(null, host);
  fail(new Error("Abandoned join"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(host.textContent).toBe("");
  expect(storage.has(GOOGLE_PAIRING_STORAGE_KEY)).toBe(true);
});

test("a nonce that changes after the code is on screen ends the attempt and takes the code away", async () => {
  const pending = await returned("pending");
  const code = await cloudPairingVerificationCode(pending, pending.gatewayFingerprint, NONCE);
  expect(host.querySelector(".cloud-pairing-code")?.textContent).toBe(code);
  const other = "A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY";
  transport.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          status: "approved",
          // Even a code that is right for the new nonce is refused.
          verificationCode: await cloudPairingVerificationCode(
            pending,
            pending.gatewayFingerprint,
            other,
          ),
          codeNonce: other,
          expiresAt: Date.now() + 60_000,
          pairingCode: "SYNTHETIC-CODE",
        }),
      ),
  );
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(norm(host.querySelector('[role="alert"]')?.textContent)).toContain(
      "The gateway or pairing request changed. Start again.",
    );
  });
  expect(host.querySelector(".cloud-pairing-code")).toBeNull();
  expect(button("pair this device")).toBeUndefined();
  expect(api.login).not.toHaveBeenCalled();
});
