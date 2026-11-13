// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey } from "node:crypto";
import { parseHTML } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import { installAccountUI } from "./account-browser.js";
import { enrollmentNonce } from "./device-enrollment.js";

const OPERATION = "b1fba1ce-2398-4c2c-a66b-9044433d1a02";
const STORAGE_KEY = "omnesis.portal-handoff";
const gateway = { gatewayId: "fixture-gateway", publicOrigin: "https://gateway.example.test" };
const signedOut = { authenticated: false, googleAvailable: true, canCreateAccount: true };
const credentials = {
  federated: [] as unknown[],
  passkeys: [
    {
      id: "fixture",
      label: "Test passkey",
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: Date.UTC(2026, 0, 5, 12),
      lastUsedAt: null,
    },
  ],
};
const signedIn = { authenticated: true, googleAvailable: true, gateways: [gateway], credentials };
const ready = { ...signedIn, handoff: { ready: true } };
const handedOver = {
  identityToken: "fictional-attestation",
  signInProof: { type: "google", idToken: "fictional-google-token", salt: "fictional-salt" },
  publicOrigin: gateway.publicOrigin,
};
/** What an earlier load of the page would have left in this tab's storage. */
const stored = {
  operationId: OPERATION,
  requestId: "0d9f0a4e-52a5-4b63-9d0c-5f1f5f8f6a11",
  name: "Portal 1a2b3c4d",
  secret: "c".repeat(64),
  privateKey: { kty: "EC", crv: "P-256", x: "fictional-x", y: "fictional-y", d: "fictional-d" },
  devicePublicKey: "fictional-device-key",
};
afterEach(() => vi.unstubAllGlobals());

function setup(
  options: {
    search?: string;
    session?: unknown;
    stored?: unknown;
    /** Page globals that differ from a browser able to keep a handoff. */
    globals?: Record<string, () => unknown>;
  } = {},
) {
  const { document, window } = parseHTML(
    '<html><body><p id="account-error"></p><div id="account-root"></div></body></html>',
  );
  const location = {
    origin: "https://relay.example.test",
    search: options.search ?? "",
    assign: vi.fn(),
    replace: vi.fn(),
  };
  const values = new Map<string, string>();
  if (options.stored !== undefined)
    values.set(
      STORAGE_KEY,
      typeof options.stored === "string" ? options.stored : JSON.stringify(options.stored),
    );
  const sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
  };
  const globals: Record<string, () => unknown> = {
    location: () => location,
    history: () => ({ replaceState: vi.fn() }),
    PublicKeyCredential: () => class {},
    sessionStorage: () => sessionStorage,
    ...options.globals,
  };
  const page = new Proxy(window, {
    get: (target, key) =>
      typeof key === "string" && key in globals ? globals[key]!() : Reflect.get(target, key),
  });
  const binary = new Uint8Array([1, 2, 3]).buffer;
  const credential = {
    id: "AQID",
    rawId: binary,
    type: "public-key",
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: binary,
      attestationObject: binary,
      authenticatorData: binary,
      signature: binary,
      userHandle: binary,
    },
  };
  const passkeys = { create: vi.fn(async () => credential), get: vi.fn(async () => credential) };
  let session: unknown = options.session ?? signedOut;
  const respond: Record<string, () => Response> = {};
  const request = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url), location.origin).pathname.replace("/_relay/account/api/", "");
    if (respond[path]) return respond[path]();
    if (path === "session") return Response.json(session);
    if (path === "portal/start")
      return Response.json({ operationId: OPERATION, expiresAt: Date.now() / 1000 + 600 });
    if (path === "portal/handoff") return Response.json(handedOver);
    if (path.endsWith("/options"))
      return Response.json({
        ceremonyId: "fixture-ceremony",
        options: { challenge: "AQID", user: { id: "AQID" } },
      });
    if (path === "passkeys/authenticate/complete") session = ready;
    return Response.json({ ok: true });
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", page);
  vi.stubGlobal("navigator", { credentials: passkeys });
  vi.stubGlobal("fetch", request);
  const root = () => document.getElementById("account-root")!;
  return {
    location,
    values,
    sessionStorage,
    request,
    respond,
    wait: (text: string) => vi.waitFor(() => expect(root().textContent).toContain(text)),
    button: (text: string) =>
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent === text,
      ) as unknown as HTMLButtonElement,
    /** Clicks the first gateway row and reports whether the page took over the navigation. */
    openGateway: () => {
      const event = new window.Event("click", { bubbles: true, cancelable: true });
      document.querySelector("a.gateway")!.dispatchEvent(event);
      return event.defaultPrevented;
    },
    /** Every request as `path?query`, in order. */
    requests: () =>
      request.mock.calls.map(([url]) => String(url).replace("/_relay/account/api/", "")),
    posted: (path: string) =>
      request.mock.calls
        .filter(([url]) => String(url).replace("/_relay/account/api/", "").startsWith(path))
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>),
    session: (value: unknown) => {
      session = value;
    },
  };
}
const fragment = (href: string) =>
  JSON.parse(Buffer.from(href.split("#account-signin=")[1]!, "base64url").toString());

test("a passkey sign-in on the plain page is bound to a fresh device key and handed to the portal once", async () => {
  const f = setup();
  installAccountUI();
  await f.wait("Sign in with Passkey");
  f.button("Sign in with Passkey").click();
  await f.wait("Your gateways");
  const material = JSON.parse(f.values.get(STORAGE_KEY)!);
  expect(material).toMatchObject({
    operationId: OPERATION,
    requestId: expect.stringMatching(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
    name: expect.stringMatching(/^Portal [a-f0-9]{8}$/),
    secret: expect.stringMatching(/^[a-f0-9]{64}$/),
    privateKey: { kty: "EC", crv: "P-256", d: expect.any(String) },
  });
  // The page's nonce is the one the gateway recomputes, and its key is the one it names.
  expect(f.posted("portal/start")).toEqual([
    { nonce: enrollmentNonce({ ...material, kind: "portal" }) },
  ]);
  const { d: _private, ...publicJwk } = material.privateKey;
  expect(
    createPublicKey({ key: publicJwk, format: "jwk" })
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  ).toBe(material.devicePublicKey);
  expect(f.requests()).toEqual([
    "session",
    "portal/start",
    `passkeys/authenticate/options?portal=${OPERATION}`,
    `passkeys/authenticate/complete?portal=${OPERATION}`,
    `session?portal=${OPERATION}`,
  ]);

  expect(f.openGateway()).toBe(true);
  await vi.waitFor(() => expect(f.location.assign).toHaveBeenCalledOnce());
  expect(f.requests().at(-1)).toBe(`portal/handoff?portal=${OPERATION}`);
  expect(f.posted("portal/handoff")).toEqual([{ gatewayId: "fixture-gateway" }]);
  const href = f.location.assign.mock.calls[0]![0] as string;
  expect(href.startsWith("https://gateway.example.test/portal/#account-signin=")).toBe(true);
  expect(fragment(href)).toEqual({
    v: 1,
    requestId: material.requestId,
    name: material.name,
    secret: material.secret,
    privateKey: material.privateKey,
    devicePublicKey: material.devicePublicKey,
    identityToken: "fictional-attestation",
    proof: handedOver.signInProof,
  });
  // Spent: nothing is left behind, a second click is a plain link, and the next request is ordinary.
  expect(f.values.has(STORAGE_KEY)).toBe(false);
  expect(f.openGateway()).toBe(true);
  await vi.waitFor(() =>
    expect(f.location.assign).toHaveBeenLastCalledWith("https://gateway.example.test/portal/"),
  );
  expect(f.posted("portal/handoff")).toHaveLength(1);
  f.button("Sign out").click();
  await vi.waitFor(() => expect(f.requests()).toContain("logout"));
  await vi.waitFor(() => expect(f.requests().at(-1)).toBe("session"));
});

test("Google sign-in carries the handoff through the round trip and the front door opens the gateway with it", async () => {
  for (const search of ["", "?open=portal"]) {
    const f = setup({ search });
    installAccountUI();
    await f.wait("Sign in with Google");
    f.button("Sign in with Google").click();
    await vi.waitFor(() => expect(f.location.assign).toHaveBeenCalledOnce());
    expect(f.location.assign).toHaveBeenCalledWith(
      `https://relay.example.test/_relay/web/start?${search ? "open=portal&" : ""}portal=${OPERATION}`,
    );
    expect(JSON.parse(f.values.get(STORAGE_KEY)!).operationId).toBe(OPERATION);
  }
  const back = setup({ search: `?portal=${OPERATION}&open=portal`, session: ready, stored });
  installAccountUI();
  await back.wait("Opening your gateway…");
  await vi.waitFor(() => expect(back.location.replace).toHaveBeenCalledOnce());
  expect(back.requests()).toEqual([
    `session?portal=${OPERATION}`,
    `portal/handoff?portal=${OPERATION}`,
  ]);
  expect(fragment(back.location.replace.mock.calls[0]![0] as string)).toMatchObject({
    v: 1,
    requestId: stored.requestId,
    privateKey: stored.privateKey,
    proof: handedOver.signInProof,
  });
  expect(back.values.has(STORAGE_KEY)).toBe(false);
  expect(back.location.assign).not.toHaveBeenCalled();
});

test("a browser that cannot prepare a handoff signs in exactly as before", async () => {
  const refuse = () => {
    throw new Error("synthetic storage refusal");
  };
  for (const [globals, prepare] of [
    // Nowhere to keep it: the page does not even try.
    [{ sessionStorage: () => undefined }, undefined],
    [{ sessionStorage: refuse }, undefined],
    [{ crypto: () => ({}) }, undefined],
    // The relay or the storage refuses at the last step.
    [
      {},
      (f: ReturnType<typeof setup>) =>
        (f.respond["portal/start"] = () => new Response("", { status: 429 })),
    ],
    [{}, (f: ReturnType<typeof setup>) => f.sessionStorage.setItem.mockImplementation(refuse)],
  ] as const) {
    const f = setup({ globals });
    prepare?.(f);
    installAccountUI();
    await f.wait("Sign in with Passkey");
    f.button("Sign in with Passkey").click();
    await f.wait("Your gateways");
    expect(f.requests().filter((path) => path.includes("portal="))).toEqual([]);
    expect(f.values.has(STORAGE_KEY)).toBe(false);
    expect(document.getElementById("account-error")!.textContent).toBe("");
    // Without a handoff a gateway row is a plain link.
    expect(f.openGateway()).toBe(false);
    expect(f.location.assign).not.toHaveBeenCalled();

    const google = setup({ globals });
    prepare?.(google);
    installAccountUI();
    await google.wait("Sign in with Google");
    google.button("Sign in with Google").click();
    await vi.waitFor(() =>
      expect(google.location.assign).toHaveBeenCalledWith(
        "https://relay.example.test/_relay/web/start",
      ),
    );
  }
});

test("stored material is used only for the sign-in it was made for, and cleared otherwise", async () => {
  for (const [options, query] of [
    // Signed in, but the relay knows no ready sign-in for it.
    [{ session: signedIn, stored }, `?portal=${OPERATION}`],
    [{ session: { ...signedIn, handoff: { ready: false } }, stored }, `?portal=${OPERATION}`],
    // Signed out again, such as after a Google sign-in that failed.
    [
      { session: signedOut, stored, search: `?failed=google&portal=${OPERATION}` },
      `?portal=${OPERATION}`,
    ],
    // The address names another operation, or the stored value is not one of ours.
    [{ session: ready, stored, search: "?portal=6f1c7d0e-8a57-4c58-b0f1-2f6f4f3f9d22" }, ""],
    [{ session: ready, stored, search: `?portal=${OPERATION}&portal=${OPERATION}` }, ""],
    [{ session: ready, stored: "{not json" }, ""],
    [{ session: ready, stored: { ...stored, operationId: "elsewhere" } }, ""],
    [{ session: ready, stored: "null" }, ""],
  ] as const) {
    const f = setup(options);
    installAccountUI();
    await f.wait(options.session === signedOut ? "Sign in with Passkey" : "Your gateways");
    expect(f.requests()).toEqual(["session" + query]);
    expect(f.values.has(STORAGE_KEY)).toBe(false);
    if (options.session !== signedOut) expect(f.openGateway()).toBe(false);
  }
  // A browser that refuses storage altogether has nothing to restore or clear.
  const blocked = setup({
    session: ready,
    globals: {
      sessionStorage: () => {
        throw new Error("synthetic storage refusal");
      },
    },
  });
  installAccountUI();
  await blocked.wait("Your gateways");
  expect(blocked.requests()).toEqual(["session"]);
});

test("a handoff the relay refuses falls back to the plain portal link", async () => {
  for (const response of [
    () => new Response("", { status: 409 }),
    // An address the page would not link to is not followed either.
    () => Response.json({ ...handedOver, publicOrigin: "http://gateway.example.test" }),
  ]) {
    const f = setup({ session: ready, stored });
    f.respond["portal/handoff"] = response;
    installAccountUI();
    await f.wait("Your gateways");
    expect(f.openGateway()).toBe(true);
    await vi.waitFor(() =>
      expect(f.location.assign).toHaveBeenCalledWith("https://gateway.example.test/portal/"),
    );
    expect(document.getElementById("account-error")!.textContent).toBe("");
  }
  // A session that ended meanwhile re-renders the front door; the gateway still opens, once.
  const expired = setup({ search: "?open=portal", session: ready, stored });
  expired.respond["portal/handoff"] = () => new Response("", { status: 401 });
  installAccountUI();
  await vi.waitFor(() =>
    expect(expired.location.replace).toHaveBeenCalledWith("https://gateway.example.test/portal/"),
  );
  expect(expired.location.replace).toHaveBeenCalledOnce();
  expect(expired.requests()).toEqual([
    `session?portal=${OPERATION}`,
    `portal/handoff?portal=${OPERATION}`,
    `session?portal=${OPERATION}`,
  ]);
});

test("changes to the sign-in methods never ride on the handoff", async () => {
  const google = { provider: "google", createdAt: Date.UTC(2025, 10, 3, 12) };
  const stale = {
    ...ready,
    credentialsRequireSignIn: true,
    credentials: { ...credentials, federated: [google] },
  };
  const f = setup({ session: stale, stored });
  const ENDORSE = "5d0d1d58-0c35-4f0b-9a53-8a8f6c0a7e21";
  f.respond["passkeys/register/complete"] = () => Response.json({ endorse: ENDORSE });
  installAccountUI();
  await f.wait("Your gateways");
  f.button("Add a passkey").click();
  // The new passkey waits for a sign-in to vouch for it, which is not the handoff's sign-in.
  await f.wait("Confirm it's you");
  f.button("Confirm with Google").click();
  expect(f.location.assign).toHaveBeenCalledWith(
    `https://relay.example.test/_relay/web/start?endorse=${ENDORSE}`,
  );
  // Confirming with a passkey is a sign-in of its own, not the one the handoff waits for.
  await vi.waitFor(() => expect(f.button("Confirm with passkey").disabled).toBe(false));
  f.button("Confirm with passkey").click();
  await vi.waitFor(() =>
    expect(f.requests()).toContain(`passkeys/register/confirm?endorse=${ENDORSE}`),
  );
  expect(
    f.requests().filter((path) => path.startsWith("passkeys/") && path.includes("portal=")),
  ).toEqual([]);
  expect(f.requests()).toContain("passkeys/register/options");
  expect(f.requests()).toContain(`passkeys/authenticate/options?endorse=${ENDORSE}`);

  const linking = setup({ session: ready, stored });
  installAccountUI();
  await linking.wait("Link Google");
  linking.button("Link Google").click();
  await vi.waitFor(() =>
    expect(linking.location.assign).toHaveBeenCalledWith(
      "https://relay.example.test/_relay/web/start?link=1",
    ),
  );
  // An operation page keeps its own sign-in and prepares nothing.
  const operation = setup({
    search: `?desktop=${OPERATION}`,
    session: {
      ...signedOut,
      pending: { purpose: "desktop-discovery", deviceName: "Fictional laptop", needsProof: true },
    },
  });
  installAccountUI();
  await operation.wait("Sign in with Google");
  operation.button("Sign in with Google").click();
  expect(operation.location.assign).toHaveBeenCalledWith(
    `https://relay.example.test/_relay/web/start?desktop=${OPERATION}`,
  );
  expect(operation.requests()).toEqual([`session?desktop=${OPERATION}`]);
});
