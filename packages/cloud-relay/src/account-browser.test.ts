// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { installAccountUI, installConnectUI, installInviteUI } from "./account-browser.js";

const signedOut = { authenticated: false, googleAvailable: true, canCreateAccount: true };
const authenticated = {
  authenticated: true,
  googleAvailable: true,
  gateways: [{ gatewayId: "fixture", publicOrigin: "https://gateway.example.test", online: true }],
  credentials: {
    federated: [] as unknown[],
    passkeys: [
      {
        id: "fixture",
        label: "Test passkey",
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: Date.UTC(2026, 0, 5, 12),
        lastUsedAt: Date.UTC(2026, 1, 9, 12),
      },
    ],
  },
};
const google = { provider: "google", createdAt: Date.UTC(2025, 10, 3, 12) };
/** The name the fixture relay gives a new passkey that waits to be vouched for. */
const parked = "e7a1c0de-1111-4222-8333-444455556666";
const day = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const { document, window } = parseHTML(
    '<html><body><p id="account-error"></p><div id="account-root"></div></body></html>',
  );
  const location = {
    origin: "https://relay.example.test",
    hostname: "relay.example.test",
    search: "",
    assign: vi.fn(),
    replace: vi.fn(),
  };
  const history = { replaceState: vi.fn() };
  Object.assign(window, { location, history, PublicKeyCredential: class {} });
  const binary = new Uint8Array([1, 2, 3]).buffer;
  const credential = {
    id: "AQID",
    rawId: binary,
    type: "public-key",
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: binary,
      attestationObject: binary,
      getTransports: () => ["internal"],
      authenticatorData: binary,
      signature: binary,
      userHandle: binary,
    },
  };
  const credentials = { create: vi.fn(async () => credential), get: vi.fn(async () => credential) };
  const options = { challenge: "AQID", user: { id: "AQID" } };
  let session: unknown = signedOut,
    creatingAccount = false;
  const completions: unknown[] = [],
    continuations: (() => Response)[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), location.origin).pathname;
    if (path.endsWith("/session")) return Response.json(session);
    if (path.endsWith("/options")) {
      creatingAccount = JSON.parse(String(init!.body)).createAccount === true;
      return Response.json({
        ceremonyId: "fixture-ceremony",
        options,
      });
    }
    // A passkey for an existing account is only held, under a name, until a sign-in vouches.
    if (path.endsWith("/register/complete") && !creatingAccount)
      return Response.json({ endorse: parked });
    if (path.endsWith("/register/confirm")) return Response.json({ id: "AQID" });
    if (path.endsWith("/register/cancel")) return Response.json({ ok: true });
    if (path.endsWith("/complete")) {
      if (completions.length > 0) session = completions.shift();
      else if (!(session as { authenticated: boolean }).authenticated) session = authenticated;
      return Response.json({ ok: true });
    }
    if (path.endsWith("/logout")) {
      session = signedOut;
      return Response.json({ ok: true });
    }
    if (path.endsWith("/remove")) return Response.json({ ok: true });
    // The relay keeps the choice on the operation, so the next session describes it.
    if (path.endsWith("/intent")) {
      const described = session as { pending: object };
      session = {
        ...described,
        pending: { ...described.pending, intent: JSON.parse(String(init!.body)).intent },
      };
      return Response.json({ ok: true });
    }
    if (path.endsWith("/continue") && continuations.length > 0) return continuations.shift()!();
    if (path.endsWith("/continue"))
      return Response.json({
        location: "https://gateway.example.test/devices/account/callback?result=fixture",
      });
    throw new Error(`Unknown fixture request ${String(init?.method)}`);
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", { credentials });
  vi.stubGlobal("fetch", request);
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (element) => element.textContent === text,
    ) as unknown as HTMLButtonElement;
  const wait = (text: string) =>
    vi.waitFor(() => expect(document.getElementById("account-root")!.textContent).toContain(text));
  return {
    document,
    window,
    location,
    credentials,
    credential,
    options,
    request,
    button,
    wait,
    history,
    status: () => document.querySelector('[role="status"]')?.textContent ?? "",
    alert: () => document.getElementById("account-error")!.textContent,
    posted: (suffix: string) =>
      request.mock.calls
        .filter(([url]) => String(url).endsWith(suffix))
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>),
    /** The `endorse` name each request to a path ending in `suffix` carried, in order. */
    endorsed: (suffix: string) =>
      request.mock.calls
        .map(([url]) => new URL(String(url), location.origin))
        .filter((url) => url.pathname.endsWith(suffix))
        .map((url) => url.searchParams.get("endorse")),
    session: (value: unknown) => {
      session = value;
    },
    /** How many times the page asked the relay to continue its operation. */
    continued: () =>
      request.mock.calls.filter(([url]) =>
        new URL(String(url), location.origin).pathname.endsWith("/continue"),
      ).length,
    /** What the relay answers to the next requests to continue, in order. */
    onContinue: (...answers: (() => Response)[]) => {
      continuations.push(...answers);
    },
    /** Sessions the next completed passkey ceremonies leave behind, in order. */
    afterCeremony: (...values: unknown[]) => {
      completions.push(...values);
    },
  };
}

test("Google and passkey choices remain explicit and Google opens only its fixed local sign-in route", async () => {
  const f = setup();
  installAccountUI();
  await f.wait("Sign in with Google");
  expect(f.document.querySelector("img")?.getAttribute("src")).toBe("/_relay/account/google-mark");
  f.button("Sign in with Google").click();
  expect(f.location.assign).toHaveBeenCalledWith("https://relay.example.test/_relay/web/start");
  expect(f.credentials.create).not.toHaveBeenCalled();
  expect(f.credentials.get).not.toHaveBeenCalled();
});

const continueLabels = {
  "owner-link": "Connect this gateway",
  "device-enrollment": "Continue pairing",
  "gateway-signup": "Connect this gateway",
  "desktop-discovery": "Continue on this device",
};
const titles = {
  "owner-link": "Sign in to your Omnesis account",
  "device-enrollment": "Pair this browser",
  "gateway-signup": "Sign in to your Omnesis account",
  "desktop-discovery": "Connect this device",
};

test("a pending operation stays in view through sign-in and offers exactly one continuation", async () => {
  const operation = "b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  for (const [key, purpose, label] of [
    ["operation", "owner-link", { hostname: "gateway.example.test" }],
    ["operation", "device-enrollment", { hostname: "gateway.example.test" }],
    ["desktop", "desktop-discovery", { deviceName: "Fictional laptop" }],
    ["signup", "gateway-signup", { gatewayName: "Fictional gateway" }],
  ] as const) {
    const name = Object.values(label)[0]!,
      action = continueLabels[purpose];
    const f = setup();
    f.location.search = `?${key}=${operation}`;
    const pending = { purpose, ...label, needsProof: true };
    f.session({ ...signedOut, pending });
    installAccountUI();
    await f.wait(name);
    await f.wait(titles[purpose]);
    expect(f.document.querySelector("h1")?.textContent).toBe(titles[purpose]);
    expect(
      [...f.document.querySelectorAll("button")].filter((button) => button.textContent === action),
    ).toHaveLength(0);
    f.button("Sign in with Google").click();
    expect(f.location.assign).toHaveBeenCalledWith(
      `https://relay.example.test/_relay/web/start?${key}=${operation}`,
    );

    // A session cookie alone still asks for a sign-in on this operation.
    const cookieOnly = setup();
    cookieOnly.location.search = f.location.search;
    cookieOnly.session({ ...authenticated, pending });
    installAccountUI();
    await cookieOnly.wait("Sign in with Passkey");
    expect(cookieOnly.button("Add a passkey")).toBeUndefined();
    expect(cookieOnly.document.getElementById("account-root")!.textContent).not.toContain(
      "Sign-in methods",
    );

    const signedIn = setup();
    signedIn.location.search = f.location.search;
    signedIn.session({ ...authenticated, pending: { ...pending, needsProof: false } });
    installAccountUI();
    await signedIn.wait(name);
    expect(signedIn.button("Sign in with Passkey")).toBeUndefined();
    expect(
      [...signedIn.document.querySelectorAll("button")].filter(
        (button) => button.textContent === action,
      ),
    ).toHaveLength(1);
    // Only pairing this browser goes on by itself; the others wait for the press.
    if (purpose !== "device-enrollment") signedIn.button(action).click();
    await vi.waitFor(() =>
      expect(signedIn.location.assign).toHaveBeenCalledWith(
        "https://gateway.example.test/devices/account/callback?result=fixture",
      ),
    );
    expect(
      signedIn.request.mock.calls.every(
        ([url]) =>
          new URL(String(url), signedIn.location.origin).searchParams.get(key) === operation,
      ),
    ).toBe(true);
    expect(signedIn.continued()).toBe(1);
  }
});

test("the code is shown with its warning, and approval is never promised unconditionally", async () => {
  const f = setup();
  f.location.search = "?desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  f.session({
    ...signedOut,
    pending: {
      purpose: "desktop-discovery",
      deviceName: "Fictional laptop",
      code: "ABCD-EF23",
      needsProof: true,
    },
  });
  installAccountUI();
  await f.wait("ABCD-EF23");
  const text = f.document.getElementById("account-root")!.textContent;
  expect(text).toContain("Only continue if you started this on that machine and the code matches.");
  expect(f.document.querySelector(".code")?.textContent).toBe("ABCD-EF23");
  for (const purpose of ["desktop-discovery", "device-enrollment"] as const) {
    const ready = setup();
    ready.location.search = "?desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
    ready.session({
      ...authenticated,
      pending: { purpose, deviceName: "Fictional laptop", needsProof: false },
    });
    installAccountUI();
    await ready.wait("decides whether");
    expect(ready.document.getElementById("account-root")!.textContent).not.toContain(
      "still requires",
    );
  }
});

test("a refused sign-in says why, offers nothing else, and asks for nothing to send", async () => {
  for (const [denied, message] of [
    [{ reason: "not-allowed" }, "isn't accepting"],
    [{ reason: "capacity" }, "no room"],
  ] as const) {
    const f = setup();
    f.location.search = "?signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
    f.session({
      ...authenticated,
      pending: {
        purpose: "gateway-signup",
        gatewayName: "Fictional gateway",
        code: "ABCD-EF23",
        needsProof: true,
        denied,
      },
    });
    installAccountUI();
    await f.wait(message);
    expect(f.document.querySelectorAll("button")).toHaveLength(0);
    expect(f.document.querySelector(".code.long")).toBeNull();
    expect(f.document.getElementById("account-root")!.textContent).toContain("start again");
  }
});

const inviteNeeded =
  "Omnesis accounts are invite-only for now. Creating one needs an invite link.If you have one, start again from your gateway and paste it there. Otherwise, sign in to an account you already have.";
const inviteUnusable =
  "This invite can't create an account any more: it has expired or was already used. Ask for a new invite, then start again from your gateway.";

test("a sign-up refused for want of an invite says accounts are invite-only and offers nothing", async () => {
  const f = setup();
  f.location.search = "?signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  f.session({
    ...signedOut,
    pending: {
      purpose: "gateway-signup",
      gatewayName: "Fictional gateway",
      code: "ABCD-EF23",
      needsProof: true,
      denied: { reason: "not-allowed", inviteRequired: true },
    },
  });
  installAccountUI();
  await f.wait("invite-only");
  const root = f.document.getElementById("account-root")!;
  expect(root.textContent).toContain(inviteNeeded);
  expect(root.textContent).not.toContain("isn't accepting");
  expect(f.document.querySelectorAll("button")).toHaveLength(0);
  expect(f.document.querySelector("a")).toBeNull();
});

test("the create view without an invite says one is needed and offers the account the person has", async () => {
  const f = setup();
  f.location.search = "?signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  f.session({
    ...signedOut,
    canCreateAccount: false,
    pending: {
      purpose: "gateway-signup",
      gatewayName: "Fictional gateway",
      needsProof: true,
      intent: "create",
      canCreate: false,
    },
  });
  installAccountUI();
  await f.wait("invite-only");
  expect(f.document.getElementById("account-root")!.textContent).toContain(inviteNeeded);
  expect(f.button("Create with Google")).toBeUndefined();
  expect(f.button("Create with a passkey")).toBeUndefined();
  await press(f, "I already have an account");
  await vi.waitFor(() => expect(f.button("Sign in with Passkey")).toBeDefined());
  const intents = f.request.mock.calls.filter(
    ([url]) => new URL(String(url), f.location.origin).pathname === "/_relay/account/api/intent",
  );
  expect(intents.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([
    { intent: "existing" },
  ]);
});

test("an invite spent before the account was made says so, whether Google or the relay reports it", async () => {
  const f = setup();
  f.location.search = "?failed=invite&signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  f.session({
    ...signedOut,
    pending: {
      purpose: "gateway-signup",
      gatewayName: "Fictional gateway",
      needsProof: true,
      intent: "create",
      canCreate: true,
    },
  });
  installAccountUI();
  await vi.waitFor(() => expect(f.alert()).toBe(inviteUnusable));
  expect(f.button("Create with Google")).toBeDefined();

  // A refusal the relay names as an invite's is said the same way; any other stays generic.
  for (const [body, text] of [
    [{ error: "invite-used" }, inviteUnusable],
    [{ error: "something-else" }, "did not complete"],
    [{}, "did not complete"],
  ] as const) {
    const page = setup();
    page.location.search = "?signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
    page.session({
      ...authenticated,
      pending: { purpose: "gateway-signup", gatewayName: "Fictional gateway", needsProof: false },
    });
    page.onContinue(() => Response.json(body, { status: 403 }));
    installAccountUI();
    await press(page, "Connect this gateway");
    await vi.waitFor(() => expect(page.alert()).toContain(text));
  }
});

test("a refused continuation refreshes the page, so it offers what the operation now needs", async () => {
  const f = setup();
  f.location.search = "?signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  const pending = { purpose: "gateway-signup", gatewayName: "Fictional gateway" };
  f.session({ ...authenticated, pending: { ...pending, needsProof: false } });
  f.onContinue(() => {
    f.session({
      ...authenticated,
      pending: { ...pending, needsProof: true, denied: { reason: "capacity" } },
    });
    return new Response("", { status: 403 });
  });
  installAccountUI();
  await press(f, "Connect this gateway");
  await f.wait("no room");
  await vi.waitFor(() =>
    expect(f.document.getElementById("account-error")!.textContent).toContain("did not complete"),
  );
  expect(f.location.assign).not.toHaveBeenCalled();
  expect(f.continued()).toBe(1);
});

test("account continuation cannot navigate to an unsafe returned address", async () => {
  const f = setup();
  f.location.search = "?operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  f.session({
    ...authenticated,
    pending: { purpose: "owner-link", hostname: "gateway.example.test", needsProof: false },
  });
  const unsafe = () => Response.json({ location: "javascript:alert(1)" });
  f.onContinue(unsafe, unsafe);
  installAccountUI();
  // The button never follows it, however often it is pressed.
  await press(f, "Connect this gateway");
  await vi.waitFor(() =>
    expect(f.document.getElementById("account-error")!.textContent).toContain("did not complete"),
  );
  expect(f.continued()).toBe(1);
  await press(f, "Connect this gateway");
  await vi.waitFor(() => expect(f.continued()).toBe(2));
  await vi.waitFor(() =>
    expect(f.document.getElementById("account-error")!.textContent).toContain("did not complete"),
  );
  expect(f.location.assign).not.toHaveBeenCalled();
});

/** Lets every timer that is already due run, so a continuation that should not start has its chance. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const signupOperation = "?signup=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
const handoffAddress = "https://gateway.example.test/devices/account/callback?result=fixture";

test("after sign-in, pairing a browser continues by itself, exactly once", async () => {
  const f = setup();
  f.location.search = "?operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  const pending = {
    purpose: "device-enrollment",
    hostname: "gateway.example.test",
    needsProof: true,
  };
  f.session({ ...signedOut, pending });
  f.afterCeremony({ ...authenticated, pending: { ...pending, needsProof: false } });
  installAccountUI();
  await f.wait("Sign in with Passkey");
  await settle();
  // Nothing continues before the person has signed in on this operation.
  expect(f.continued()).toBe(0);
  await press(f, "Sign in with Passkey");
  await vi.waitFor(() => expect(f.location.assign).toHaveBeenCalledWith(handoffAddress));
  await settle();
  expect(f.continued()).toBe(1);
  expect(f.location.assign).toHaveBeenCalledOnce();
  // The button stays as the fallback.
  expect(f.button("Continue pairing")).toBeDefined();
});

test("after sign-in, a gateway is connected only when the person presses to connect it", async () => {
  for (const [key, purpose, label] of [
    ["operation", "owner-link", { hostname: "gateway.example.test", intent: "existing" }],
    ["signup", "gateway-signup", { gatewayName: "Fictional gateway", intent: "existing" }],
  ] as const) {
    const f = setup();
    f.location.search = `?${key}=b1fba1ce-2398-4c2c-a66b-9044433d1a02`;
    const pending = { purpose, ...label, needsProof: true };
    f.session({ ...signedOut, pending });
    f.afterCeremony({ ...authenticated, pending: { ...pending, needsProof: false } });
    installAccountUI();
    await press(f, "Sign in with Passkey");
    await f.wait("This adds the gateway to your Omnesis account");
    // Whoever started the request named the gateway, so the person compares it before going on.
    await settle();
    expect(f.continued()).toBe(0);
    expect(f.location.assign).not.toHaveBeenCalled();
    await press(f, continueLabels[purpose]);
    await vi.waitFor(() => expect(f.location.assign).toHaveBeenCalledWith(handoffAddress));
    expect(f.continued()).toBe(1);
  }
});

test("a desktop sign-in never continues by itself", async () => {
  const f = setup();
  f.location.search = "?desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  const pending = { purpose: "desktop-discovery", deviceName: "Fictional laptop" };
  f.session({ ...signedOut, pending: { ...pending, needsProof: true } });
  f.afterCeremony({ ...authenticated, pending: { ...pending, needsProof: false } });
  installAccountUI();
  await press(f, "Sign in with Passkey");
  await f.wait("Continue on this device");
  await settle();
  expect(f.continued()).toBe(0);
  expect(f.location.assign).not.toHaveBeenCalled();
  await press(f, "Continue on this device");
  await vi.waitFor(() => expect(f.location.assign).toHaveBeenCalledOnce());
  expect(f.continued()).toBe(1);
});

test("a failed automatic continuation is not retried: it leaves the error and the button, which still works", async () => {
  const f = setup();
  f.location.search = "?operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  f.session({
    ...authenticated,
    pending: { purpose: "device-enrollment", hostname: "gateway.example.test", needsProof: false },
  });
  f.onContinue(() => new Response("", { status: 503 }));
  installAccountUI();
  await vi.waitFor(() => expect(f.alert()).toContain("did not complete"));
  // The failure refreshed and redrew the page, which must not start another attempt.
  await settle();
  expect(f.continued()).toBe(1);
  expect(f.location.assign).not.toHaveBeenCalled();
  expect(f.alert()).toContain("did not complete");
  await press(f, "Continue pairing");
  await vi.waitFor(() => expect(f.location.assign).toHaveBeenCalledWith(handoffAddress));
  expect(f.continued()).toBe(2);
  expect(f.alert()).toBe("");
});

test("an account is created only from the create view, which the person can switch to and from", async () => {
  for (const [key, purpose, label] of [
    ["signup", "gateway-signup", { gatewayName: "Fictional gateway" }],
    ["operation", "owner-link", { hostname: "gateway.example.test" }],
  ] as const) {
    const f = setup(),
      query = `${key}=b1fba1ce-2398-4c2c-a66b-9044433d1a02`;
    f.location.search = `?${query}`;
    f.session({ ...signedOut, pending: { purpose, ...label, needsProof: true, intent: "create" } });
    installAccountUI();
    await f.wait("Create your Omnesis account");
    const text = () => f.document.getElementById("account-root")!.textContent;
    expect(f.document.querySelector("h1")?.textContent).toBe("Create your Omnesis account");
    expect(text()).toContain(Object.values(label)[0]);
    expect(text()).toContain("Your data stays on your gateway.");
    expect(text()).toContain("Creating the account also connects this gateway to it.");
    expect(text()).toContain("already has an Omnesis account, you'll be signed in to it instead");
    expect(buttons(f, "#account-root")).toEqual([
      "Create with Google",
      "Create with a passkey",
      "I already have an account",
    ]);
    expect(f.button("Create with a passkey").className).toBe("secondary");
    // Switching to signing in is recorded on the operation, and that view creates nothing.
    await press(f, "I already have an account");
    await f.wait("Sign in with Passkey");
    expect(f.posted(`/intent?${query}`)).toEqual([{ intent: "existing" }]);
    expect(f.document.querySelector("h1")?.textContent).toBe("Sign in to your Omnesis account");
    expect(buttons(f, "#account-root")).toEqual([
      "Sign in with Passkey",
      "Sign in with Google",
      "Create an account instead",
    ]);
    expect(text()).not.toContain("Create with");
    // And back again.
    await press(f, "Create an account instead");
    await f.wait("Create your Omnesis account");
    expect(f.posted(`/intent?${query}`)).toEqual([{ intent: "existing" }, { intent: "create" }]);
    await press(f, "Create with Google");
    expect(f.location.assign).toHaveBeenCalledWith(
      `https://relay.example.test/_relay/web/start?${query}`,
    );
    expect(f.credentials.create).not.toHaveBeenCalled();
    expect(f.continued()).toBe(0);
  }
});

test("creating with a passkey is offered only on the create view, and only when the relay allows it", async () => {
  const pending = {
    purpose: "gateway-signup",
    gatewayName: "Fictional gateway",
    needsProof: true,
  };
  // An allowlisted relay admits no new passkey account, so only Google can create one.
  const closed = setup();
  closed.location.search = signupOperation;
  closed.session({
    ...signedOut,
    canCreateAccount: false,
    pending: { ...pending, intent: "create" },
  });
  installAccountUI();
  await closed.wait("Create your Omnesis account");
  expect(buttons(closed, "#account-root")).toEqual([
    "Create with Google",
    "I already have an account",
  ]);
  // A relay with no Google sign-in leaves the passkey as the one way: the primary button, no note.
  const passkeyOnly = setup();
  passkeyOnly.location.search = signupOperation;
  passkeyOnly.session({
    ...signedOut,
    googleAvailable: false,
    pending: { ...pending, intent: "create" },
  });
  installAccountUI();
  await passkeyOnly.wait("Create your Omnesis account");
  expect(buttons(passkeyOnly, "#account-root")).toEqual([
    "Create with a passkey",
    "I already have an account",
  ]);
  expect(passkeyOnly.button("Create with a passkey").className).toBe("");
  expect(passkeyOnly.document.getElementById("account-root")!.textContent).not.toContain(
    "signed in to it instead",
  );
  // Signing in to an account never offers to create one, even where the relay would allow it.
  for (const [search, described] of [
    [signupOperation, { ...pending, intent: "existing" }],
    [
      "?operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
      { purpose: "device-enrollment", hostname: "gateway.example.test", needsProof: true },
    ],
    [
      "?desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
      { purpose: "desktop-discovery", deviceName: "Fictional laptop", needsProof: true },
    ],
    ["", undefined],
  ] as const) {
    const f = setup();
    f.location.search = search;
    f.session({ ...signedOut, ...(described ? { pending: described } : {}) });
    installAccountUI();
    await f.wait("Sign in with Passkey");
    expect(f.button("Create with a passkey")).toBeUndefined();
    expect(f.button("Create with Google")).toBeUndefined();
    // Only an operation that can create an account offers the switch.
    expect(f.button("Create an account instead") !== undefined).toBe(
      (described as { intent?: string } | undefined)?.intent !== undefined,
    );
    await press(f, "Sign in with Passkey");
    await vi.waitFor(() => expect(f.credentials.get).toHaveBeenCalledOnce());
    expect(f.credentials.create).not.toHaveBeenCalled();
    expect(f.posted("/options").some((body) => body.createAccount === true)).toBe(false);
  }
});

test("the create view gives way once the person is signed in or was refused", async () => {
  const pending = {
    purpose: "gateway-signup",
    gatewayName: "Fictional gateway",
    intent: "create",
  };
  const ready = setup();
  ready.location.search = signupOperation;
  ready.session({ ...authenticated, pending: { ...pending, needsProof: false } });
  installAccountUI();
  await ready.wait("This adds the gateway to your Omnesis account");
  // Signed in, the page names the one step left.
  expect(ready.document.querySelector("h1")?.textContent).toBe(
    "Connect this gateway to your Omnesis account",
  );
  expect(ready.button("Create with Google")).toBeUndefined();
  await press(ready, "Connect this gateway");
  await vi.waitFor(() => expect(ready.location.assign).toHaveBeenCalledWith(handoffAddress));
  const refused = setup();
  refused.location.search = signupOperation;
  refused.session({
    ...signedOut,
    pending: { ...pending, needsProof: true, denied: { reason: "capacity" } },
  });
  installAccountUI();
  await refused.wait("no room");
  expect(refused.document.querySelectorAll("button")).toHaveLength(0);
  // A session cookie alone has not signed in on this operation, so creating is still the view.
  const cookieOnly = setup();
  cookieOnly.location.search = signupOperation;
  cookieOnly.session({ ...authenticated, pending: { ...pending, needsProof: true } });
  installAccountUI();
  await cookieOnly.wait("Create your Omnesis account");
  await settle();
  expect(cookieOnly.continued()).toBe(0);
});

test("a sign-in that no account uses says so, and where an account can be created", async () => {
  const none = "There's no Omnesis account for this sign-in.";
  const plain = setup();
  plain.location.search = "?failed=no-account";
  installAccountUI();
  await vi.waitFor(() =>
    expect(plain.alert()).toBe(
      `${none} Create one from your gateway: open its portal, then Settings and Omnesis account.`,
    ),
  );
  expect(plain.button("Create an account instead")).toBeUndefined();
  for (const [search, pending] of [
    [
      "?failed=no-account&operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
      { purpose: "device-enrollment", hostname: "gateway.example.test", needsProof: true },
    ],
    [
      "?failed=no-account&desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
      { purpose: "desktop-discovery", deviceName: "Fictional laptop", needsProof: true },
    ],
  ] as const) {
    const f = setup();
    f.location.search = search;
    f.session({ ...signedOut, pending });
    installAccountUI();
    await vi.waitFor(() => expect(f.alert()).toContain("Create one from your gateway"));
    expect(f.button("Create an account instead")).toBeUndefined();
  }
  for (const [search, pending] of [
    [
      `?failed=no-account&${signupOperation.slice(1)}`,
      { purpose: "gateway-signup", gatewayName: "Fictional gateway", needsProof: true },
    ],
    [
      "?failed=no-account&operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02",
      { purpose: "owner-link", hostname: "gateway.example.test", needsProof: true },
    ],
  ] as const) {
    const f = setup();
    f.location.search = search;
    f.session({ ...signedOut, pending: { ...pending, intent: "existing" } });
    installAccountUI();
    await vi.waitFor(() => expect(f.alert()).toBe(`${none} You can create one below.`));
    await press(f, "Create an account instead");
    await f.wait("Create your Omnesis account");
  }
});

test("a desktop sign-in hands off only to the desktop's loopback callback, and says when approval is needed", async () => {
  const pending = {
    purpose: "desktop-discovery",
    deviceName: "Fictional laptop",
    needsProof: false,
  };
  const local = setup();
  local.location.search = "?desktop=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  local.session({ ...authenticated, pending });
  installAccountUI();
  await local.wait("decides whether");
  const callback =
    "http://127.0.0.1:49152/omnesis/callback?operationId=b1fba1ce-2398-4c2c-a66b-9044433d1a02&completion=fixture";
  local.request.mockResolvedValueOnce(Response.json({ location: callback }));
  local.button("Continue on this device").click();
  await vi.waitFor(() => expect(local.location.assign).toHaveBeenCalledWith(callback));
  for (const location of [
    "http://127.0.0.1:49152/elsewhere",
    "http://localhost:49152/omnesis/callback",
    "http://relay.example.test/omnesis/callback",
    "http://name@127.0.0.1:49152/omnesis/callback",
  ]) {
    const refused = setup();
    refused.location.search = local.location.search;
    refused.session({ ...authenticated, pending });
    installAccountUI();
    await refused.wait("Continue on this device");
    refused.request.mockResolvedValueOnce(Response.json({ location }));
    refused.button("Continue on this device").click();
    await vi.waitFor(() =>
      expect(refused.document.getElementById("account-error")!.textContent).toContain(
        "did not complete",
      ),
    );
    expect(refused.location.assign).not.toHaveBeenCalled();
  }
  const remote = setup();
  remote.location.search = local.location.search;
  remote.session({ ...authenticated, pending: { ...pending, approvalRequired: true } });
  installAccountUI();
  await remote.wait("approve it on your phone");
  expect(remote.document.getElementById("account-root")!.textContent).not.toContain(
    "decides whether",
  );
  // Only the desktop purpose has approval copy; other purposes keep theirs.
  const portal = setup();
  portal.location.search = "?operation=b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  portal.session({
    ...authenticated,
    pending: {
      purpose: "device-enrollment",
      deviceName: "Fictional laptop",
      needsProof: false,
      approvalRequired: true,
    },
  });
  installAccountUI();
  await portal.wait("decides whether");
});

test("credential allow and exclude lists are decoded and requests cannot overlap", async () => {
  const f = setup();
  Object.assign(f.options, {
    allowCredentials: [{ type: "public-key", id: "AQID" }],
    excludeCredentials: [{ type: "public-key", id: "AQID" }],
  });
  Object.assign(f.credential.response, { getTransports: undefined });
  installAccountUI();
  await f.wait("Sign in with Passkey");
  let release!: (credential: typeof f.credential) => void;
  f.credentials.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const button = f.button("Sign in with Passkey");
  button.click();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  button.dispatchEvent(new f.window.Event("click"));
  expect(f.credentials.get).toHaveBeenCalledOnce();
  const get = f.credentials.get.mock.calls[0] as unknown as [
    { publicKey: { allowCredentials: { id: Uint8Array }[] } },
  ];
  expect([...get[0].publicKey.allowCredentials[0]!.id]).toEqual([1, 2, 3]);
  release(f.credential);
  await f.wait("Sign-in methods");
  f.button("Add a passkey").click();
  await press(f, "Create passkey");
  await vi.waitFor(() => expect(f.credentials.create).toHaveBeenCalledOnce());
  const create = f.credentials.create.mock.calls[0] as unknown as [
    { publicKey: { excludeCredentials: { id: Uint8Array }[] } },
  ];
  expect([...create[0].publicKey.excludeCredentials[0]!.id]).toEqual([1, 2, 3]);
  const completed = f.request.mock.calls.find(([url]) => String(url).endsWith("register/complete"));
  expect(JSON.parse(String(completed![1]!.body)).credential.response.transports).toEqual([]);
});

test("Google availability and provider labels reflect the account while unsafe gateway addresses stay inert", async () => {
  const disabled = setup();
  disabled.session({ ...signedOut, googleAvailable: false });
  installAccountUI();
  await disabled.wait("Sign in with Passkey");
  expect(disabled.button("Sign in with Google")).toBeUndefined();
  const linked = setup();
  linked.session({
    ...authenticated,
    credentials: {
      ...authenticated.credentials,
      federated: [{ ...google, provider: "future-provider" }],
    },
  });
  installAccountUI();
  await linked.wait(`future-providerLinked ${day(google.createdAt)}`);
  for (const publicOrigin of [
    "http://gateway.example.test",
    "https://name@gateway.example.test",
    "https://name:password@gateway.example.test",
  ]) {
    const invalid = setup();
    invalid.session({ ...authenticated, gateways: [{ publicOrigin }] });
    installAccountUI();
    await vi.waitFor(() =>
      expect(invalid.document.getElementById("account-error")!.textContent).toContain(
        "did not complete",
      ),
    );
    expect(invalid.document.querySelector("a")).toBeNull();
  }
});

test("passkey registration encodes the authenticator response and renders escaped gateway and credential text", async () => {
  const creating = setup();
  creating.location.search = signupOperation;
  const pending = { purpose: "gateway-signup", gatewayName: "Fictional gateway", intent: "create" };
  creating.session({ ...signedOut, pending: { ...pending, needsProof: true } });
  creating.afterCeremony({ ...authenticated, pending: { ...pending, needsProof: false } });
  installAccountUI();
  await creating.wait("Create your Omnesis account");
  creating.button("Create with a passkey").click();
  await vi.waitFor(() => expect(creating.credentials.create).toHaveBeenCalledOnce());
  expect(creating.posted("register/options" + signupOperation)).toEqual([
    { createAccount: true, label: "Passkey" },
  ]);
  // Once the account exists, the gateway is connected by the person's own press.
  await press(creating, "Connect this gateway");
  await vi.waitFor(() => expect(creating.location.assign).toHaveBeenCalledWith(handoffAddress));
  const [request] = creating.request.mock.calls.filter(([url]) =>
    String(url).endsWith("register/complete" + signupOperation),
  );
  expect(JSON.parse(String(request![1]!.body))).toMatchObject({
    ceremonyId: "fixture-ceremony",
    credential: {
      id: "AQID",
      rawId: "AQID",
      response: { clientDataJSON: "AQID", attestationObject: "AQID", transports: ["internal"] },
    },
  });
  const f = setup();
  f.session({
    ...authenticated,
    gateways: [
      {
        publicOrigin: "https://gateway.example.test",
        displayName: "<script>Test gateway</script>",
      },
    ],
  });
  installAccountUI();
  await f.wait("Sign-in methods");
  expect(f.document.querySelector("script")).toBeNull();
  expect(f.document.querySelector("a")?.getAttribute("href")).toBe(
    "https://gateway.example.test/portal/",
  );
  f.button("Link Google").click();
  expect(f.location.assign).toHaveBeenCalledWith(
    "https://relay.example.test/_relay/web/start?link=1",
  );
});

test("passkey sign-in serializes its signature and user handle then lets the user sign out", async () => {
  const f = setup();
  installAccountUI();
  await f.wait("Sign in with Passkey");
  f.button("Sign in with Passkey").click();
  await f.wait("Sign-in methods");
  expect(f.credentials.get).toHaveBeenCalledOnce();
  const [request] = f.request.mock.calls.filter(([url]) =>
    String(url).endsWith("authenticate/complete"),
  );
  expect(JSON.parse(String(request![1]!.body)).credential.response).toEqual({
    clientDataJSON: "AQID",
    authenticatorData: "AQID",
    signature: "AQID",
    userHandle: "AQID",
  });
  f.button("Sign out").click();
  await f.wait("Sign in with Passkey");
});

test("existing credentials can be removed and a new passkey joins the authenticated account", async () => {
  const f = setup();
  f.session({
    ...authenticated,
    gateways: [],
    credentials: { ...authenticated.credentials, federated: [google] },
  });
  installAccountUI();
  await f.wait("No gateways");
  expect(f.button("Link Google")).toBeUndefined();
  f.button("Remove").click();
  await vi.waitFor(() =>
    expect(f.request.mock.calls.some(([url]) => String(url).endsWith("passkeys/remove"))).toBe(
      true,
    ),
  );
  await vi.waitFor(() => expect(f.button("Add a passkey").disabled).toBe(false));
  f.button("Add a passkey").click();
  await press(f, "Create passkey");
  await vi.waitFor(() => expect(f.credentials.create).toHaveBeenCalledOnce());
  const [request] = f.request.mock.calls.filter(([url]) =>
    String(url).endsWith("register/options"),
  );
  expect(JSON.parse(String(request![1]!.body))).toEqual({
    createAccount: false,
    label: "Passkey",
  });
});

test("cancelled, unavailable, malformed and failed sign-in stays recoverable without an automatic Google redirect", async () => {
  for (const mode of [
    "cancel",
    "abort",
    "missing",
    "wrong-type",
    "no-handle",
    "network",
    "unsupported",
  ] as const) {
    const f = setup();
    installAccountUI();
    await f.wait("Sign in with Passkey");
    if (mode === "cancel" || mode === "abort")
      f.credentials.get.mockRejectedValue(
        Object.assign(new Error("private provider detail"), {
          name: mode === "cancel" ? "NotAllowedError" : "AbortError",
        }),
      );
    if (mode === "missing")
      f.credentials.get.mockResolvedValue(null as unknown as typeof f.credential);
    if (mode === "wrong-type") f.credential.type = "password";
    if (mode === "no-handle") f.credential.response.userHandle = null as unknown as ArrayBuffer;
    if (mode === "network") f.request.mockResolvedValueOnce(new Response("", { status: 503 }));
    if (mode === "unsupported") Object.assign(f.window, { PublicKeyCredential: undefined });
    f.button("Sign in with Passkey").click();
    await vi.waitFor(() =>
      expect(f.document.getElementById("account-error")!.textContent).toMatch(
        /cancelled|did not complete/,
      ),
    );
    expect(f.document.getElementById("account-error")!.textContent).not.toContain(
      "private provider detail",
    );
    expect(f.location.assign).not.toHaveBeenCalled();
  }
});

test("the served function remains self-contained after production-style bundling with preserved function names", async () => {
  const f = setup();
  const bundled = await build({
    entryPoints: ["packages/cloud-relay/src/account-browser.js"],
    write: false,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    keepNames: true,
    minify: true,
  });
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString("base64")}`
  )) as { installAccountUI: () => void };
  runInNewContext(`(${module.installAccountUI.toString()})();`, {
    document: f.document,
    window: f.window,
    navigator: { credentials: f.credentials },
    fetch: f.request,
    URL,
    URLSearchParams,
    Uint8Array,
    atob,
    btoa,
  });
  await f.wait("Sign in with Passkey");
});

test("a front-door request opens the only gateway's portal and otherwise shows the account page", async () => {
  const gateway = (name: string) => ({
    gatewayId: name,
    publicOrigin: `https://${name}.example.test`,
  });
  const only = setup();
  only.location.search = "?open=portal";
  only.session(authenticated);
  installAccountUI();
  await only.wait("Opening your gateway");
  expect(only.location.replace).toHaveBeenCalledExactlyOnceWith(
    "https://gateway.example.test/portal/",
  );
  expect(only.document.querySelector("a")).toBeNull();
  expect(only.button("Sign out")).toBeUndefined();
  for (const [search, gateways] of [
    ["?open=portal", []],
    ["?open=portal", [gateway("first"), gateway("second")]],
    ["", authenticated.gateways],
    ["?open=", authenticated.gateways],
    ["?open=Portal", authenticated.gateways],
    ["?open=portal&open=portal", authenticated.gateways],
    ["?open=https%3A%2F%2Fforeign.example.test%2F", authenticated.gateways],
  ] as const) {
    const f = setup();
    f.location.search = search;
    f.session({ ...authenticated, gateways });
    installAccountUI();
    await f.wait("Sign-in methods");
    expect(f.location.replace).not.toHaveBeenCalled();
    expect(f.document.querySelectorAll("a.gateway")).toHaveLength(gateways.length);
    expect(f.button("Sign out")).toBeDefined();
  }
});

test("a front-door request never opens an unsafe gateway address or leaves an operation", async () => {
  for (const publicOrigin of [
    "http://gateway.example.test",
    "https://name@gateway.example.test",
    "https://name:password@gateway.example.test",
    "not an address",
  ]) {
    const invalid = setup();
    invalid.location.search = "?open=portal";
    invalid.session({ ...authenticated, gateways: [{ publicOrigin }] });
    installAccountUI();
    await vi.waitFor(() =>
      expect(invalid.document.getElementById("account-error")!.textContent).toContain(
        "did not complete",
      ),
    );
    expect(invalid.location.replace).not.toHaveBeenCalled();
    expect(invalid.document.querySelector("a")).toBeNull();
  }
  const operation = "b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  for (const key of ["operation", "desktop", "signup"]) {
    for (const pending of [
      { purpose: "desktop-discovery", deviceName: "Fictional laptop", needsProof: false },
      undefined,
    ]) {
      const f = setup();
      f.location.search = `?open=portal&${key}=${operation}`;
      f.session({ ...authenticated, ...(pending ? { pending } : {}) });
      installAccountUI();
      await f.wait(pending ? "Continue on this device" : "Sign-in methods");
      expect(f.location.replace).not.toHaveBeenCalled();
    }
  }
  // A page served for an operation that is still pending never opens the portal either.
  const pending = setup();
  pending.location.search = "?open=portal";
  pending.session({
    ...authenticated,
    pending: { purpose: "desktop-discovery", deviceName: "Fictional laptop", needsProof: false },
  });
  installAccountUI();
  await pending.wait("Continue on this device");
  expect(pending.location.replace).not.toHaveBeenCalled();
});

test("a front-door request survives passkey and Google sign-in, and is dropped when it is not exact", async () => {
  const passkey = setup();
  passkey.location.search = "?open=portal";
  installAccountUI();
  await passkey.wait("Sign in with Passkey");
  expect(passkey.location.replace).not.toHaveBeenCalled();
  passkey.button("Sign in with Passkey").click();
  await vi.waitFor(() =>
    expect(passkey.location.replace).toHaveBeenCalledExactlyOnceWith(
      "https://gateway.example.test/portal/",
    ),
  );
  const google = setup();
  google.location.search = "?open=portal";
  installAccountUI();
  await google.wait("Sign in with Google");
  google.button("Sign in with Google").click();
  expect(google.location.assign).toHaveBeenCalledWith(
    "https://relay.example.test/_relay/web/start?open=portal",
  );
  for (const search of ["?open=other", "?open=portal&open=portal", "?open"]) {
    const dropped = setup();
    dropped.location.search = search;
    installAccountUI();
    await dropped.wait("Sign in with Google");
    dropped.button("Sign in with Google").click();
    expect(dropped.location.assign).toHaveBeenCalledWith(
      "https://relay.example.test/_relay/web/start",
    );
  }
  // Adding a Google sign-in is account management, so it returns to the account page itself.
  const link = setup();
  link.location.search = "?open=portal";
  link.session({ ...authenticated, gateways: [] });
  installAccountUI();
  await link.wait("Link Google");
  link.button("Link Google").click();
  expect(link.location.assign).toHaveBeenCalledWith(
    "https://relay.example.test/_relay/web/start?link=1",
  );
});

test("a failed Google redirect explains the failure without exposing provider details", async () => {
  const f = setup();
  f.location.search = "?failed=google&providerError=private-provider-detail";
  installAccountUI();
  await vi.waitFor(() =>
    expect(f.document.getElementById("account-error")!.textContent).toBe(
      "Google sign-in did not complete. Try again or use a passkey.",
    ),
  );
  expect(f.document.body.textContent).not.toContain("private-provider-detail");
  expect(f.button("Sign in with Passkey").disabled).toBe(false);
});

test("back from a Google start the browser didn't vouch for, the page asks for one more press", async () => {
  const again = "To continue with Google, press the Google button again.";
  const f = setup();
  f.location.search = `${signupOperation}&failed=again`;
  f.session({
    ...signedOut,
    pending: { purpose: "gateway-signup", gatewayName: "Fictional gateway", needsProof: true },
  });
  installAccountUI();
  await vi.waitFor(() => expect(f.status()).toBe(again));
  expect(f.alert()).toBe("");
  await press(f, "Sign in with Google");
  await vi.waitFor(() =>
    expect(f.location.assign).toHaveBeenCalledWith(
      `https://relay.example.test/_relay/web/start${signupOperation}`,
    ),
  );
  // A new passkey that was waiting for Google is still waiting for it.
  const endorsing = setup();
  endorsing.location.search = `?endorse=${parked}&failed=again`;
  endorsing.session(authenticated);
  installAccountUI();
  await endorsing.wait("Adding a passkey · step 2 of 2");
  expect(endorsing.status()).toBe(again);
  expect(endorsing.endorsed("register/confirm")).toEqual([]);
});

test("a sign-in the gateway's page already chose is the page's one step", async () => {
  const operation = "b1fba1ce-2398-4c2c-a66b-9044433d1a02",
    pairing = { purpose: "device-enrollment", hostname: "gateway.example.test", needsProof: true };
  const shown = (f: Page) =>
    [...f.document.querySelectorAll("button")].map((button) => button.textContent);
  const open = async (pending: object, session: object = signedOut) => {
    const f = setup();
    f.location.search = `?operation=${operation}`;
    f.session({ ...session, pending });
    installAccountUI();
    await f.wait("gateway.example.test");
    await vi.waitFor(() => expect(f.document.querySelector("h1")).not.toBeNull());
    return f;
  };

  // "Continue with Google" on the gateway: Google alone, then the same round trip as before.
  const google = await open({ ...pairing, method: "google" });
  expect(google.document.querySelector("h1")?.textContent).toBe("Continue with Google");
  expect(google.document.getElementById("account-root")!.textContent).toContain(
    "Sign in to this gateway with the Google account you use for Omnesis.",
  );
  expect(shown(google)).toEqual(["Continue with Google"]);
  expect(google.button("Continue with Google").className).not.toBe("secondary");
  await press(google, "Continue with Google");
  expect(google.location.assign).toHaveBeenCalledWith(
    `https://relay.example.test/_relay/web/start?operation=${operation}`,
  );

  // A passkey hop offers the passkey alone.
  const passkey = await open({ ...pairing, method: "passkey" });
  expect(passkey.document.querySelector("h1")?.textContent).toBe("Continue with your passkey");
  expect(shown(passkey)).toEqual(["Continue with passkey"]);
  await press(passkey, "Continue with passkey");
  await vi.waitFor(() => expect(passkey.credentials.get).toHaveBeenCalledOnce());

  // Google that this service can't offer is no dead end: the page offers what it has.
  const unavailable = await open(
    { ...pairing, method: "google" },
    { ...signedOut, googleAvailable: false },
  );
  expect(unavailable.document.querySelector("h1")?.textContent).toBe("Pair this browser");
  expect(shown(unavailable)).toEqual(["Sign in with Passkey"]);

  // Signed in, the page goes on exactly as before.
  const done = await open({ ...pairing, method: "google", needsProof: false }, authenticated);
  expect(done.document.querySelector("h1")?.textContent).toBe("Pair this browser");

  // Creating an account offers only the chosen sign-in too.
  const link = { purpose: "owner-link", hostname: "gateway.example.test", needsProof: true };
  const creating = await open({ ...link, intent: "create", method: "passkey" });
  expect(creating.document.querySelector("h1")?.textContent).toBe("Create your Omnesis account");
  expect(shown(creating)).toEqual(["Create with a passkey", "I already have an account"]);
  expect(creating.document.querySelector(".note")).toBeNull();
  const creatingGoogle = await open({ ...link, intent: "create", method: "google" });
  expect(shown(creatingGoogle)).toEqual(["Create with Google", "I already have an account"]);
  // A refusal says why, whatever was chosen.
  const denied = await open({ ...link, method: "google", denied: { reason: "capacity" } });
  expect(denied.document.querySelector("h1")?.textContent).toBe("Sign in to your Omnesis account");
});

test("the plain sign-in page never offers to create an account, whatever the relay would allow", async () => {
  for (const canCreateAccount of [false, true]) {
    const f = setup();
    f.session({ ...signedOut, canCreateAccount });
    installAccountUI();
    await f.wait("Sign in with Passkey");
    expect(buttons(f, "#account-root")).toEqual(["Sign in with Passkey", "Sign in with Google"]);
    expect(f.document.getElementById("account-root")!.textContent).not.toContain("Create");
    expect(f.credentials.create).not.toHaveBeenCalled();
  }
});

const added = {
  id: "AQID",
  label: "Passkey",
  deviceType: "singleDevice",
  backedUp: false,
  createdAt: Date.UTC(2026, 2, 7, 12),
  lastUsedAt: null,
};
const withAdded = {
  ...authenticated,
  credentials: { federated: [], passkeys: [...authenticated.credentials.passkeys, added] },
};
const stale = { ...authenticated, credentialsRequireSignIn: true };
/** True once the page has finished its action and re-enabled what can be used. */
const idle = (document: Document) => {
  const buttons = [...document.querySelectorAll("button")];
  return (
    buttons.length > 0 &&
    buttons.every((button) => button.disabled === (button.dataset.unavailable === "1"))
  );
};
const named = (name: string) => Object.assign(new Error("private provider detail"), { name });
type Page = ReturnType<typeof setup>;
/** Presses a button once the page has finished what it was doing. */
async function press(f: Page, text: string) {
  await vi.waitFor(() => expect(f.button(text)?.disabled).toBe(false));
  f.button(text).click();
}
/** What the endorsement step calls the fixture account's one passkey. */
const existingPasskey = `Confirm with your passkey “Test passkey”, added ${day(
  authenticated.credentials.passkeys[0]!.createdAt,
)}`;
/** Creates a passkey, which then waits for a sign-in the account already has. */
async function createPasskey(f: Page) {
  await press(f, "Add a passkey");
  await press(f, "Create passkey");
  await f.wait("Adding a passkey · step 2 of 2");
  await vi.waitFor(() => expect(f.button("Cancel").disabled).toBe(false));
}
/** Creates a passkey and vouches for it with the passkey the account already has. */
async function addPasskey(f: Page) {
  await createPasskey(f);
  await press(f, existingPasskey);
}
const buttons = (f: Page, within = ".confirm") =>
  [...f.document.querySelectorAll(`${within} button`)].map((button) => button.textContent);

test("a new passkey is added once a sign-in the account already has vouches for it, then marked as new until sign-out", async () => {
  const f = setup();
  f.session(authenticated);
  installAccountUI();
  await f.wait("Add a passkey");
  expect(f.status()).toBe("");
  expect(f.document.body.textContent).not.toContain("Confirm");
  // The first press says what adding takes; nothing is created yet.
  await press(f, "Add a passkey");
  await f.wait("Adding a passkey · step 1 of 2");
  expect(f.credentials.create).not.toHaveBeenCalled();
  expect([...f.document.querySelectorAll(".confirm p")].map((line) => line.textContent)).toEqual([
    "Your browser or password manager will ask where to save the new passkey.",
    "Next, you'll confirm with a sign-in you already use.",
  ]);
  expect(buttons(f)).toEqual(["Create passkey", "Cancel"]);
  expect(f.button("Add a passkey")).toBeUndefined();
  await press(f, "Create passkey");
  await f.wait("Adding a passkey · step 2 of 2");
  // The passkey exists on the device, and the account does not have it yet. It signed nothing.
  expect(f.credentials.create).toHaveBeenCalledOnce();
  expect(f.credentials.get).not.toHaveBeenCalled();
  expect(f.endorsed("authenticate/options")).toEqual([]);
  expect(f.document.querySelector(".confirm h3")!.textContent).toBe(
    "Adding a passkey · step 2 of 2",
  );
  expect(f.document.querySelector(".confirm p")!.textContent).toBe(
    "Confirm with a sign-in you already use, so that someone else using this browser can't add a passkey of their own.",
  );
  // The account's passkey is named, with where to turn if it is on another device.
  expect(buttons(f)).toEqual([existingPasskey, "Cancel"]);
  expect(f.document.querySelector(".confirm .note")!.textContent).toBe(
    "If that passkey is on another device, your browser will offer to use it from there, for example with a QR code.",
  );
  expect(f.button("Add a passkey")).toBeUndefined();
  expect(f.button("Link Google")).toBeUndefined();
  expect(f.status()).toBe("");
  expect(f.document.querySelector(".badge")).toBeNull();
  expect(f.endorsed("register/confirm")).toEqual([]);
  f.session(withAdded);
  await press(f, existingPasskey);
  await vi.waitFor(() => expect(f.status()).toBe("Passkey added. You can now use it to sign in."));
  // The confirming sign-in names the passkey it vouches for, and so does storing it.
  expect(f.credentials.get).toHaveBeenCalledOnce();
  expect(f.endorsed("register/options")).toEqual([null]);
  expect(f.endorsed("register/complete")).toEqual([null]);
  expect(f.endorsed("authenticate/options")).toEqual([parked]);
  expect(f.endorsed("authenticate/complete")).toEqual([parked]);
  expect(f.endorsed("register/confirm")).toEqual([parked]);
  expect(f.endorsed("register/cancel")).toEqual([]);
  expect(f.document.querySelector(".confirm")).toBeNull();
  const status = f.document.querySelector('[role="status"]')!;
  // The quiet actions sit under the list they add to, inside its section.
  expect(status.nextElementSibling!.className).toBe("list-actions");
  expect(buttons(f, ".list-actions")).toEqual(["Add a passkey", "Link Google"]);
  expect(f.button("Add a passkey").className).toBe("quiet add");
  expect(f.button("Link Google").className).toBe("quiet");
  expect(status.previousElementSibling!.className).toBe("list");
  expect(status.parentElement!.querySelector("h2")!.textContent).toBe("Sign-in methods");
  const rows = [...f.document.querySelectorAll(".credential")];
  expect(rows.map((row) => row.querySelectorAll(".badge").length)).toEqual([0, 1]);
  expect(rows[1]!.querySelector(".row-title")!.textContent).toMatch(/^Passkey\s/);
  expect(rows[1]!.querySelector(".badge")!.textContent).toBe("New");
  expect(f.alert()).toBe("");
  f.button("Sign out").click();
  await f.wait("Sign in with Passkey");
  expect(f.status()).toBe("");
  f.afterCeremony(withAdded);
  f.button("Sign in with Passkey").click();
  await f.wait("Sign-in methods");
  expect(f.document.querySelectorAll(".credential")).toHaveLength(2);
  expect(f.document.querySelector(".badge")).toBeNull();
  expect(f.status()).toBe("");
});

test("the confirmation names each of the account's passkeys, offers Google first, and only the named passkey is asked for", async () => {
  const older = {
    ...authenticated.credentials.passkeys[0]!,
    id: "BAUG",
    label: "Passkey on iPhone",
    createdAt: Date.UTC(2025, 8, 1, 12),
  };
  const f = setup();
  f.session({
    ...authenticated,
    credentials: {
      federated: [google],
      passkeys: [older, ...authenticated.credentials.passkeys],
    },
  });
  Object.assign(f.options, {
    allowCredentials: [
      { type: "public-key", id: "AQID" },
      { type: "public-key", id: "BAUG" },
    ],
  });
  installAccountUI();
  await f.wait("Add a passkey");
  await createPasskey(f);
  // Google first, then each passkey newest first by its name and date, then Google again for a
  // passkey that lives on another device.
  const newest = existingPasskey,
    oldest = `Confirm with your passkey “Passkey on iPhone”, added ${day(older.createdAt)}`;
  expect(buttons(f)).toEqual([
    "Confirm with Google",
    newest,
    oldest,
    "Confirm with Google instead",
    "Cancel",
  ]);
  expect(f.button("Confirm with Google").className).toBe("");
  expect(f.button(newest).className).toBe("secondary");
  expect(f.document.querySelector(".confirm .note")!.textContent).toBe(
    "If your browser shows a QR code, those passkeys are on another device. Confirm with Google instead",
  );
  // A named passkey is the only one the browser is asked for.
  f.credentials.get.mockRejectedValueOnce(named("NotAllowedError"));
  await press(f, oldest);
  await vi.waitFor(() => expect(f.alert()).toContain("No passkey was used."));
  const [asked] = f.credentials.get.mock.calls[0] as unknown as [
    { publicKey: { allowCredentials: { id: Uint8Array }[] } },
  ];
  expect(asked.publicKey.allowCredentials.map((credential) => [...credential.id])).toEqual([
    [4, 5, 6],
  ]);
  // The step stays, and Google instead takes the round trip that vouches for the new passkey.
  expect(f.document.querySelector(".confirm h3")!.textContent).toBe(
    "Adding a passkey · step 2 of 2",
  );
  await press(f, "Confirm with Google instead");
  expect(f.location.assign).toHaveBeenCalledWith(
    `https://relay.example.test/_relay/web/start?endorse=${parked}`,
  );
});

test("a passkey added from a gateway's setup counts the gateway's step, through sign-in and back", async () => {
  const storage = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  const f = setup();
  Object.assign(f.window, { sessionStorage });
  f.location.search = "?add=passkey";
  installAccountUI();
  // Signed out, the page signs in first, and remembers the request.
  await f.wait("Sign in with Passkey");
  expect(storage.get("omnesis.adding-passkey")).toBe("gateway");
  expect(f.history.replaceState).toHaveBeenCalledWith(null, "", "/_relay/account");
  await press(f, "Sign in with Passkey");
  // Signed in, the first step is already on screen, and counts three steps.
  await f.wait("Adding a passkey · step 1 of 3");
  expect([...f.document.querySelectorAll(".confirm p")].map((line) => line.textContent)).toEqual([
    "Your browser or password manager will ask where to save the new passkey.",
    "Next, you'll confirm with a sign-in you already use, then use the new passkey once on your gateway.",
  ]);
  await press(f, "Create passkey");
  await f.wait("Adding a passkey · step 2 of 3");
  f.session(withAdded);
  await press(f, existingPasskey);
  await vi.waitFor(() =>
    expect(f.status()).toBe(
      "Passkey added. To finish, go back to your gateway's page and use the new passkey once there. You can close this tab.",
    ),
  );
  expect(storage.has("omnesis.adding-passkey")).toBe(false);
  expect(f.document.querySelector(".confirm")).toBeNull();
  // Cancelling either step forgets the gateway too.
  storage.set("omnesis.adding-passkey", "gateway");
  await press(f, "Add a passkey");
  await f.wait("Adding a passkey · step 1 of 3");
  await press(f, "Cancel");
  await vi.waitFor(() => expect(f.document.querySelector(".confirm")).toBeNull());
  expect(storage.has("omnesis.adding-passkey")).toBe(false);
  // Without storage the page still works; it just counts the relay's own steps.
  const blocked = setup();
  Object.assign(blocked.window, {
    sessionStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  });
  blocked.location.search = "?add=passkey";
  blocked.session(authenticated);
  installAccountUI();
  await blocked.wait("Add a passkey");
  await press(blocked, "Add a passkey");
  await blocked.wait("Adding a passkey · step 1 of 2");
  // The fixture windows share their globals: later pages run without storage, as before.
  for (const page of [f, blocked])
    delete (page.window as { sessionStorage?: unknown }).sessionStorage;
});

test("cancelling before confirming adds nothing and asks the browser to forget the unused passkey", async () => {
  for (const mode of ["signalled", "unsupported", "signal-fails", "relay-fails"] as const) {
    const f = setup();
    const signal = vi.fn(() =>
      mode === "signal-fails"
        ? Promise.reject(new Error("private browser detail"))
        : Promise.resolve(),
    );
    if (mode !== "unsupported")
      Object.assign(f.window.PublicKeyCredential, { signalUnknownCredential: signal });
    f.session(authenticated);
    installAccountUI();
    await f.wait("Add a passkey");
    await createPasskey(f);
    if (mode === "relay-fails") f.request.mockResolvedValueOnce(new Response("", { status: 503 }));
    f.button("Cancel").click();
    await vi.waitFor(() => expect(f.status()).toBe("No passkey was added."));
    await vi.waitFor(() => expect(f.button("Add a passkey").disabled).toBe(false));
    expect(f.endorsed("register/cancel")).toEqual([parked]);
    expect(f.endorsed("register/confirm")).toEqual([]);
    expect(f.document.querySelector(".confirm")).toBeNull();
    expect(f.document.querySelector(".badge")).toBeNull();
    expect(f.alert()).toBe("");
    expect(f.credentials.get).not.toHaveBeenCalled();
    if (mode !== "unsupported")
      expect(signal).toHaveBeenCalledExactlyOnceWith({
        rpId: "relay.example.test",
        credentialId: "AQID",
      });
  }
});

test("a confirmation that is cancelled keeps the new passkey waiting, and one the relay refuses ends it", async () => {
  const f = setup();
  f.session(authenticated);
  installAccountUI();
  await f.wait("Add a passkey");
  await createPasskey(f);
  f.credentials.get.mockRejectedValueOnce(named("NotAllowedError"));
  f.button(existingPasskey).click();
  await vi.waitFor(() => expect(f.alert()).toContain("No passkey was used."));
  expect(f.document.querySelector(".confirm h3")!.textContent).toBe(
    "Adding a passkey · step 2 of 2",
  );
  expect(f.endorsed("register/confirm")).toEqual([]);
  expect(f.status()).toBe("");
  // The same passkey is confirmed on the next try, without creating another.
  f.session(withAdded);
  await press(f, existingPasskey);
  await vi.waitFor(() => expect(f.status()).toBe("Passkey added. You can now use it to sign in."));
  expect(f.credentials.create).toHaveBeenCalledOnce();
  expect(f.alert()).toBe("");

  // The relay no longer holds the passkey, or the confirmation was another account's.
  const refused = setup();
  refused.session(authenticated);
  installAccountUI();
  await refused.wait("Add a passkey");
  await createPasskey(refused);
  refused.request.mockImplementation((url) =>
    Promise.resolve(
      String(url).includes("register/confirm")
        ? new Response("", { status: 409 })
        : Response.json(
            String(url).includes("/session")
              ? authenticated
              : { ceremonyId: "fixture-ceremony", options: refused.options, ok: true },
          ),
    ),
  );
  refused.button(existingPasskey).click();
  await vi.waitFor(() =>
    expect(refused.alert()).toBe("The passkey could not be added. Please try again."),
  );
  await vi.waitFor(() => expect(refused.button("Add a passkey").disabled).toBe(false));
  expect(refused.document.querySelector(".confirm")).toBeNull();
  expect(refused.document.querySelector(".badge")).toBeNull();
  expect(refused.status()).toBe("");

  // A session that ended in the meantime is a sign-in, with nothing left waiting.
  const ended = setup();
  ended.session(authenticated);
  installAccountUI();
  await ended.wait("Add a passkey");
  await createPasskey(ended);
  ended.request.mockImplementation((url) =>
    Promise.resolve(
      String(url).includes("register/confirm")
        ? new Response("{}", { status: 401 })
        : Response.json(
            String(url).includes("/session")
              ? signedOut
              : { ceremonyId: "fixture-ceremony", options: ended.options, ok: true },
          ),
    ),
  );
  ended.button(existingPasskey).click();
  await ended.wait("Sign in with Passkey");
  await vi.waitFor(() => expect(ended.alert()).toContain("Sign in again"));
  await vi.waitFor(() => expect(ended.button("Sign in with Passkey").disabled).toBe(false));
  expect(ended.document.querySelector(".confirm")).toBeNull();
  expect(ended.status()).toBe("");
});

test("a cancelled passkey sheet is reported plainly and a real failure keeps a real error", async () => {
  for (const [name, status, alert] of [
    ["NotAllowedError", "No passkey was added.", ""],
    ["AbortError", "No passkey was added.", ""],
    ["InvalidStateError", "This device already has a passkey for your Omnesis account.", ""],
    ["UnknownError", "", "The passkey could not be added. Please try again."],
  ] as const) {
    const f = setup();
    f.session(authenticated);
    installAccountUI();
    await f.wait("Add a passkey");
    f.credentials.create.mockRejectedValueOnce(named(name));
    await press(f, "Add a passkey");
    await press(f, "Create passkey");
    await vi.waitFor(() => expect(f.status() + f.alert()).toBe(status + alert));
    await vi.waitFor(() => expect(f.button("Create passkey").disabled).toBe(false));
    expect(f.status()).toBe(status);
    expect(f.alert()).toBe(alert);
    expect(f.document.querySelector(".badge")).toBeNull();
    expect(f.posted("register/complete")).toEqual([]);
    // The first step stays, so the next attempt is one press, and it starts clean.
    expect(f.document.querySelector(".confirm h3")!.textContent).toBe(
      "Adding a passkey · step 1 of 2",
    );
    f.session(withAdded);
    await press(f, "Create passkey");
    await f.wait("Adding a passkey · step 2 of 2");
    await press(f, existingPasskey);
    await vi.waitFor(() => expect(f.status()).toContain("Passkey added."));
    expect(f.alert()).toBe("");
  }
});

test("a removed passkey is confirmed whether or not the removal ended the session", async () => {
  for (const [after, status] of [
    [authenticated, "Passkey removed."],
    [signedOut, "Passkey removed. Sign in again to continue."],
  ] as const) {
    const f = setup();
    f.session(withAdded);
    installAccountUI();
    await f.wait("Add a passkey");
    const remove = [...f.document.querySelectorAll(".credential button")];
    expect(remove).toHaveLength(2);
    f.session(after);
    (remove[1] as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.status()).toBe(status));
    expect(f.posted("passkeys/remove")).toEqual([{ id: "AQID" }]);
    expect(f.document.querySelector('[role="status"]')!.previousElementSibling!.tagName).toBe(
      after === signedOut ? "H1" : "DIV",
    );
  }
  const failed = setup();
  failed.session(withAdded);
  installAccountUI();
  await failed.wait("Add a passkey");
  failed.request.mockResolvedValueOnce(new Response("", { status: 503 }));
  failed.button("Remove").click();
  await vi.waitFor(() =>
    expect(failed.alert()).toBe("The passkey could not be removed. Please try again."),
  );
  expect(failed.status()).toBe("");
});

test("a new passkey is labelled with the platform family and nothing more specific", async () => {
  for (const [platform, label] of [
    [{ userAgentData: { platform: "macOS" } }, "Passkey on Mac"],
    [{ platform: "MacIntel", maxTouchPoints: 0 }, "Passkey on Mac"],
    [{ platform: "MacIntel", maxTouchPoints: 5 }, "Passkey on iPad"],
    [{ platform: "iPad" }, "Passkey on iPad"],
    [{ platform: "iPhone" }, "Passkey on iPhone"],
    [{ userAgentData: { platform: "Android" }, platform: "Linux armv8l" }, "Passkey on Android"],
    [{ userAgentData: { platform: "Windows" } }, "Passkey on Windows"],
    [{ platform: "Win32" }, "Passkey on Windows"],
    [{ userAgentData: { platform: "" }, platform: "Linux x86_64" }, "Passkey"],
    [{}, "Passkey"],
  ] as const) {
    const f = setup();
    vi.stubGlobal("navigator", { credentials: f.credentials, ...platform });
    f.session(authenticated);
    installAccountUI();
    await f.wait("Add a passkey");
    await createPasskey(f);
    expect(f.posted("register/options")).toEqual([{ createAccount: false, label }]);
  }
});

test("sign-in methods show when each was added and used, and whether a passkey is synced", async () => {
  const second = Date.UTC(2026, 3, 20, 12);
  const f = setup();
  f.session({
    ...authenticated,
    credentials: {
      federated: [google],
      passkeys: [
        ...authenticated.credentials.passkeys,
        { ...added, id: "single", label: "Passkey" },
        { ...added, id: "unknown", deviceType: "multiDevice", createdAt: second },
      ],
    },
  });
  installAccountUI();
  await f.wait("Add a passkey");
  const rows = [...f.document.querySelectorAll(".credential")].map((row) => [
    row.querySelector(".row-title")!.textContent,
    row.querySelector(".row-meta")!.textContent!.replaceAll("\u00a0", " "),
    (row.querySelector("button") as unknown as HTMLButtonElement | null)?.disabled,
  ]);
  expect(rows).toEqual([
    ["Google", `Linked ${day(google.createdAt)}`, undefined],
    [
      "Test passkey",
      `Added ${day(authenticated.credentials.passkeys[0]!.createdAt)} · Last used ${day(authenticated.credentials.passkeys[0]!.lastUsedAt)} · Synced`,
      false,
    ],
    ["Passkey", `Added ${day(added.createdAt)} · Never used · One device only`, false],
    ["Passkey", `Added ${day(second)} · Never used`, false],
  ]);
  expect(day(second)).not.toBe(day(added.createdAt));
  expect(day(second)).not.toMatch(/:/);
  // A line may break between two facts, never inside one.
  expect(f.document.querySelectorAll(".credential .row-meta")[2]!.textContent).toMatch(
    /^[^ ]+\u00a0· [^ ]+\u00a0· [^ ]+$/,
  );
  // An account with no passkey has nothing to remove, and a lone passkey stays.
  const none = setup();
  none.session({ ...authenticated, credentials: { federated: [google], passkeys: [] } });
  installAccountUI();
  await none.wait("Add a passkey");
  expect(none.document.querySelectorAll(".credential")).toHaveLength(1);
  expect(none.button("Remove")).toBeUndefined();
  for (const [googleAvailable, federated, disabled] of [
    [true, [], true],
    [false, [google], true],
    [true, [google], false],
  ] as const) {
    const one = setup();
    one.session({
      ...authenticated,
      googleAvailable,
      credentials: { ...authenticated.credentials, federated },
    });
    installAccountUI();
    await one.wait("Add a passkey");
    expect(one.button("Remove").disabled).toBe(disabled);
    expect(one.button("Remove").title).toBe(disabled ? "Keep at least one sign-in method" : "");
  }
});

test("each gateway is one link with its name above its address", async () => {
  const f = setup();
  f.session({
    ...authenticated,
    gateways: [
      { gatewayId: "unnamed", publicOrigin: "https://g-1a2b3c4d.relay.example.test" },
      {
        gatewayId: "named",
        publicOrigin: "https://g-5e6f7a8b.relay.example.test",
        displayName: "Fictional gateway",
      },
    ],
  });
  installAccountUI();
  await f.wait("Sign-in methods");
  const links = [...f.document.querySelectorAll(".list a.gateway")];
  expect(
    links.map((link) => [
      link.getAttribute("href"),
      link.getAttribute("title"),
      link.querySelector(".row-title")!.textContent,
      link.querySelector(".row-meta")!.textContent,
    ]),
  ).toEqual([
    [
      "https://g-1a2b3c4d.relay.example.test/portal/",
      "g-1a2b3c4d.relay.example.test",
      "Gateway",
      "g-1a2b3c4d.relay.example.test",
    ],
    [
      "https://g-5e6f7a8b.relay.example.test/portal/",
      "g-5e6f7a8b.relay.example.test",
      "Fictional gateway",
      "g-5e6f7a8b.relay.example.test",
    ],
  ]);
  const empty = setup();
  empty.session({ ...authenticated, gateways: [] });
  installAccountUI();
  await empty.wait("No gateways");
  expect(empty.document.querySelectorAll(".list")).toHaveLength(1);
});

test("returning from adding a Google sign-in confirms it once", async () => {
  const linked = {
    ...authenticated,
    credentials: { ...authenticated.credentials, federated: [google] },
  };
  const f = setup();
  f.location.search = "?linked=google";
  f.session(linked);
  installAccountUI();
  await vi.waitFor(() =>
    expect(f.status()).toBe("Google linked. You can now sign in with Google."),
  );
  expect(f.document.querySelector(".credential .row-title .badge")!.textContent).toBe("New");
  expect(f.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/_relay/account");
  f.button("Sign out").click();
  await f.wait("Sign in with Passkey");
  expect(f.status()).toBe("");
  for (const [search, session, rest] of [
    ["?linked=google", authenticated, ""],
    ["?linked=other&failed=google", linked, "?failed=google"],
    ["?linked=google", { ...linked, credentialsRequireSignIn: true }, ""],
    ["?linked=google", signedOut, ""],
  ] as const) {
    const quiet = setup();
    quiet.location.search = search;
    quiet.session(session);
    installAccountUI();
    await vi.waitFor(() =>
      expect(quiet.history.replaceState).toHaveBeenCalledExactlyOnceWith(
        null,
        "",
        "/_relay/account" + rest,
      ),
    );
    await vi.waitFor(() => expect(idle(quiet.document)).toBe(true));
    expect(quiet.status()).toBe("");
    expect(quiet.document.querySelector(".badge")).toBeNull();
  }
});

test("a stale sign-in asks for a confirmation in place, and cancelling leaves the account as it was", async () => {
  const f = setup();
  f.session(stale);
  installAccountUI();
  await f.wait("Link Google");
  expect(f.document.body.textContent).not.toContain("Confirm");
  expect(f.button("Link Google").disabled).toBe(false);
  f.button("Link Google").click();
  await f.wait("Confirm it's you");
  expect(f.document.querySelector(".confirm h3")!.textContent).toBe("Confirm it's you");
  expect(f.document.querySelector(".confirm p")!.textContent).toBe(
    "Changing how you sign in needs a fresh confirmation, so that someone else using this browser can't remove your passkeys.",
  );
  expect(f.document.querySelectorAll(".confirm p")).toHaveLength(1);
  expect(buttons(f)).toEqual(["Confirm with passkey", "Cancel"]);
  expect(f.button("Add a passkey")).toBeUndefined();
  expect(f.button("Link Google")).toBeUndefined();
  expect(f.location.assign).not.toHaveBeenCalled();
  expect(f.request.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
  f.button("Cancel").click();
  await vi.waitFor(() => expect(f.button("Link Google").disabled).toBe(false));
  expect(f.document.querySelector(".confirm")).toBeNull();
  expect(f.credentials.get).not.toHaveBeenCalled();
  // A cancelled or failed confirmation keeps the question open.
  f.button("Link Google").click();
  await f.wait("Confirm it's you");
  f.credentials.get.mockRejectedValueOnce(named("NotAllowedError"));
  f.button("Confirm with passkey").click();
  await vi.waitFor(() => expect(f.alert()).toContain("No passkey was used."));
  expect(f.document.querySelector(".confirm")).not.toBeNull();
  expect(f.location.assign).not.toHaveBeenCalled();
  // An account that signs in some other way has no confirmation to offer here.
  const other = setup();
  other.session({
    ...stale,
    credentials: { federated: [{ ...google, provider: "future-provider" }], passkeys: [] },
  });
  installAccountUI();
  await other.wait("Link Google");
  other.button("Link Google").click();
  await other.wait("Confirm it's you");
  expect(buttons(other)).toEqual(["Cancel"]);
});

test("a stale sign-in can still create a passkey, because the confirmation comes afterwards", async () => {
  const f = setup();
  f.session(stale);
  installAccountUI();
  await f.wait("Add a passkey");
  await createPasskey(f);
  // No confirmation was asked before the passkey sheet opened.
  expect(f.credentials.create).toHaveBeenCalledOnce();
  expect(f.credentials.get).not.toHaveBeenCalled();
  expect(f.document.querySelector(".confirm h3")!.textContent).toBe(
    "Adding a passkey · step 2 of 2",
  );
  f.afterCeremony(withAdded);
  await press(f, existingPasskey);
  await vi.waitFor(() => expect(f.status()).toBe("Passkey added. You can now use it to sign in."));
  expect(f.endorsed("register/confirm")).toEqual([parked]);
});

test("a passkey confirmation continues the requested change without a second click", async () => {
  const remove = setup();
  remove.session({ ...withAdded, credentialsRequireSignIn: true });
  installAccountUI();
  await remove.wait("Add a passkey");
  (
    remove.document.querySelectorAll(".credential button")[1] as unknown as HTMLButtonElement
  ).click();
  await remove.wait("Confirming with a passkey removes “Passkey” right away.");
  expect(remove.posted("passkeys/remove")).toEqual([]);
  remove.afterCeremony(withAdded);
  remove.button("Confirm with passkey").click();
  await vi.waitFor(() => expect(remove.status()).toBe("Passkey removed."));
  expect(remove.posted("passkeys/remove")).toEqual([{ id: "AQID" }]);

  // A passkey of another account confirms that account, where there is nothing to remove.
  const other = setup();
  other.session({ ...withAdded, credentialsRequireSignIn: true });
  installAccountUI();
  await other.wait("Add a passkey");
  (
    other.document.querySelectorAll(".credential button")[1] as unknown as HTMLButtonElement
  ).click();
  await other.wait("Confirm it's you");
  other.afterCeremony(authenticated);
  other.button("Confirm with passkey").click();
  await vi.waitFor(() => expect(other.document.querySelector(".confirm")).toBeNull());
  await vi.waitFor(() => expect(other.button("Add a passkey").disabled).toBe(false));
  expect(other.posted("passkeys/remove")).toEqual([]);
  expect(other.status()).toBe("");

  const link = setup();
  link.session(stale);
  installAccountUI();
  await link.wait("Link Google");
  link.button("Link Google").click();
  await link.wait("Confirm it's you");
  expect(link.location.assign).not.toHaveBeenCalled();
  link.afterCeremony(authenticated);
  link.button("Confirm with passkey").click();
  await vi.waitFor(() =>
    expect(link.location.assign).toHaveBeenCalledExactlyOnceWith(
      "https://relay.example.test/_relay/web/start?link=1",
    ),
  );
});

test("a Google confirmation carries a removal, or the passkey it vouches for, through the round trip", async () => {
  const linked = {
    ...withAdded,
    credentialsRequireSignIn: true,
    credentials: { ...withAdded.credentials, federated: [google] },
  };
  const choices = [
    ["Confirm with passkey", ""],
    ["Confirm with Google", "secondary"],
    ["Cancel", "secondary"],
  ];
  const shown = (f: Page) =>
    [...f.document.querySelectorAll(".confirm button")].map((button) => [
      button.textContent,
      button.className,
    ]);
  const remove = setup();
  remove.session(linked);
  installAccountUI();
  await remove.wait("Add a passkey");
  remove.button("Remove").click();
  await remove.wait("Confirm it's you");
  expect(shown(remove)).toEqual(choices);
  remove.button("Confirm with Google").click();
  expect(remove.location.assign).toHaveBeenCalledExactlyOnceWith(
    "https://relay.example.test/_relay/web/start?then=remove-passkey",
  );
  // A new passkey is created first; Google is then asked to vouch for exactly that one.
  const add = setup();
  add.session(linked);
  installAccountUI();
  await add.wait("Add a passkey");
  await createPasskey(add);
  // Google first, then the account's passkey by name, and Google again for a passkey elsewhere.
  expect(shown(add)).toEqual([
    ["Confirm with Google", ""],
    [existingPasskey, "secondary"],
    ["Confirm with Google instead", "quiet"],
    ["Cancel", "secondary"],
  ]);
  expect(add.location.assign).not.toHaveBeenCalled();
  add.button("Confirm with Google").click();
  expect(add.location.assign).toHaveBeenCalledExactlyOnceWith(
    `https://relay.example.test/_relay/web/start?endorse=${parked}`,
  );
  expect(add.endorsed("register/confirm")).toEqual([]);
  // Without a passkey Google is the only confirmation, and without Google there is none to offer.
  for (const [googleAvailable, offered] of [
    [true, ["Confirm with Google", "Cancel"]],
    [false, ["Cancel"]],
  ] as const) {
    const f = setup();
    f.session({
      ...linked,
      googleAvailable,
      credentials: { federated: [google], passkeys: [] },
    });
    installAccountUI();
    await f.wait("Add a passkey");
    await createPasskey(f);
    expect(buttons(f)).toEqual(offered);
    expect(f.document.querySelector(".confirm button")!.className).toBe(
      googleAvailable ? "" : "secondary",
    );
  }
});

test("returning from Google stores the passkey it vouched for, and a failed return offers the confirmation again", async () => {
  const f = setup();
  f.location.search = `?endorse=${parked}`;
  f.session(withAdded);
  installAccountUI();
  await vi.waitFor(() => expect(f.status()).toBe("Passkey added. You can now use it to sign in."));
  expect(f.endorsed("register/confirm")).toEqual([parked]);
  expect(f.credentials.create).not.toHaveBeenCalled();
  expect(f.credentials.get).not.toHaveBeenCalled();
  expect(f.document.querySelectorAll(".badge")).toHaveLength(1);
  expect(f.document.querySelector(".confirm")).toBeNull();
  // A reload repeats nothing.
  expect(f.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/_relay/account");

  // An old session finishes too: the vouching just made is the fresh confirmation.
  const old = setup();
  old.location.search = `?endorse=${parked}`;
  old.session({ ...withAdded, credentialsRequireSignIn: true });
  installAccountUI();
  await vi.waitFor(() =>
    expect(old.status()).toBe("Passkey added. You can now use it to sign in."),
  );

  const failed = setup();
  failed.location.search = `?endorse=${parked}&failed=google`;
  failed.session(authenticated);
  installAccountUI();
  await failed.wait("Adding a passkey · step 2 of 2");
  expect(failed.alert()).toBe("Google sign-in did not complete. Try again or use a passkey.");
  expect(failed.history.replaceState).toHaveBeenCalledExactlyOnceWith(
    null,
    "",
    "/_relay/account?failed=google",
  );
  expect(failed.endorsed("register/confirm")).toEqual([]);
  // The same passkey can still be confirmed with a passkey, or given up.
  failed.session(withAdded);
  await press(failed, existingPasskey);
  await vi.waitFor(() =>
    expect(failed.status()).toBe("Passkey added. You can now use it to sign in."),
  );
  expect(failed.endorsed("authenticate/options")).toEqual([parked]);
  expect(failed.endorsed("register/confirm")).toEqual([parked]);
  expect(failed.credentials.create).not.toHaveBeenCalled();

  const abandoned = setup();
  const signal = vi.fn();
  Object.assign(abandoned.window.PublicKeyCredential, { signalUnknownCredential: signal });
  abandoned.location.search = `?endorse=${parked}&failed=google`;
  abandoned.session(authenticated);
  installAccountUI();
  await abandoned.wait("Adding a passkey · step 2 of 2");
  await press(abandoned, "Cancel");
  await vi.waitFor(() => expect(abandoned.status()).toBe("No passkey was added."));
  expect(abandoned.endorsed("register/cancel")).toEqual([parked]);
  // After the round trip the page no longer knows which passkey the browser made.
  expect(signal).not.toHaveBeenCalled();

  // Google vouched, but the relay no longer holds the passkey.
  const expired = setup();
  expired.location.search = `?endorse=${parked}`;
  expired.session(authenticated);
  expired.request.mockImplementation((url) =>
    Promise.resolve(
      String(url).includes("register/confirm")
        ? new Response("", { status: 403 })
        : Response.json(authenticated),
    ),
  );
  installAccountUI();
  await vi.waitFor(() =>
    expect(expired.alert()).toBe("The passkey could not be added. Please try again."),
  );
  await vi.waitFor(() => expect(expired.button("Add a passkey").disabled).toBe(false));
  expect(expired.document.querySelector(".confirm")).toBeNull();
  expect(expired.status()).toBe("");

  const remove = setup();
  remove.location.search = "?then=remove-passkey";
  remove.session(withAdded);
  installAccountUI();
  await vi.waitFor(() => expect(remove.status()).toBe("Confirmed. You can remove it now."));
  expect(remove.button("Remove").disabled).toBe(false);
  expect(remove.posted("passkeys/remove")).toEqual([]);
  expect(remove.credentials.create).not.toHaveBeenCalled();
});

test("a change named in the address is dropped unless it is exact and the sign-in is fresh", async () => {
  const operation = "b1fba1ce-2398-4c2c-a66b-9044433d1a02";
  const two = {
    ...authenticated,
    gateways: [
      ...authenticated.gateways,
      { gatewayId: "b", publicOrigin: "https://b.example.test" },
    ],
  };
  for (const [search, session] of [
    ["?then=other", authenticated],
    ["?then=", authenticated],
    // Adding a passkey is confirmed afterwards, so no address resumes it.
    ["?then=add-passkey", authenticated],
    ["?then=remove-passkey&then=remove-passkey", authenticated],
    ["?then=remove-passkey", stale],
    ["?then=remove-passkey", signedOut],
    [`?then=remove-passkey&operation=${operation}`, authenticated],
    ["?then=remove-passkey&open=portal", two],
    // A passkey to finish is named exactly once, to a signed-in account page.
    [`?endorse=${parked}&endorse=${parked}`, authenticated],
    [`?endorse=${parked}`, signedOut],
    [`?endorse=${parked}&operation=${operation}`, authenticated],
    [`?endorse=${parked}&open=portal`, two],
  ] as const) {
    const f = setup();
    f.location.search = search;
    f.session(session);
    installAccountUI();
    await vi.waitFor(() => expect(f.history.replaceState).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(idle(f.document)).toBe(true));
    expect(f.status()).toBe("");
    expect(f.document.querySelector(".confirm")).toBeNull();
    expect(f.credentials.create).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
  }
});

test("a confirmation that lapses while the page is open asks again instead of failing", async () => {
  const f = setup();
  f.session(withAdded);
  installAccountUI();
  await f.wait("Add a passkey");
  f.session({ ...withAdded, credentialsRequireSignIn: true });
  f.request.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  (f.document.querySelectorAll(".credential button")[1] as unknown as HTMLButtonElement).click();
  await f.wait("Confirm it's you");
  expect(f.alert()).toBe("");
  expect(f.location.assign).not.toHaveBeenCalled();
  f.afterCeremony(withAdded, authenticated);
  f.button("Confirm with passkey").click();
  await vi.waitFor(() => expect(f.status()).toBe("Passkey removed."));
  expect(f.posted("passkeys/remove")).toEqual([{ id: "AQID" }, { id: "AQID" }]);

  // Creating a passkey never asks first, so a refusal there is reported as it is.
  const adding = setup();
  adding.session(authenticated);
  installAccountUI();
  await adding.wait("Add a passkey");
  adding.session(stale);
  await press(adding, "Add a passkey");
  adding.request.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  await press(adding, "Create passkey");
  await vi.waitFor(() => expect(adding.alert()).toContain("Sign in again"));
  // The first step stays on screen for the retry.
  expect(adding.document.querySelector(".confirm h3")!.textContent).toBe(
    "Adding a passkey · step 1 of 2",
  );
  expect(adding.credentials.create).not.toHaveBeenCalled();

  // A session that ended altogether is a sign-in, with the change left to retry.
  const ended = setup();
  ended.session(authenticated);
  installAccountUI();
  await ended.wait("Add a passkey");
  ended.session(signedOut);
  await press(ended, "Add a passkey");
  ended.request.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  await press(ended, "Create passkey");
  await ended.wait("Sign in with Passkey");
  await vi.waitFor(() => expect(ended.alert()).toContain("Sign in again"));
  expect(ended.credentials.create).not.toHaveBeenCalled();
  ended.button("Sign in with Passkey").click();
  await ended.wait("Add a passkey");
  expect(ended.document.querySelector(".confirm")).toBeNull();
});

test("a sign-in the relay refuses for another reason keeps the generic message", async () => {
  const f = setup();
  f.session(signedOut);
  installAccountUI();
  await f.wait("Sign in with Passkey");
  f.request.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  f.button("Sign in with Passkey").click();
  await vi.waitFor(() =>
    expect(f.alert()).toBe("That didn't sign you in. Try again, or use another sign-in method."),
  );
  expect(f.button("Sign in with Passkey").disabled).toBe(false);
});

test("a passkey whose account is gone says so, and only a deleted account's is forgotten", async () => {
  for (const [reason, googleAvailable, forgotten] of [
    ["deleted-passkey", true, true],
    ["unknown-passkey", true, false],
    ["deleted-passkey", false, true],
  ] as const) {
    const f = setup();
    const signal = vi.fn(async () => {});
    Object.assign(f.window.PublicKeyCredential, { signalUnknownCredential: signal });
    f.session({ ...signedOut, googleAvailable });
    installAccountUI();
    await f.wait("Sign in with Passkey");
    // The relay names the passkey only on the step that checks it.
    f.request.mockImplementationOnce(async () =>
      Response.json({ ceremonyId: "fixture-ceremony", options: f.options }),
    );
    f.request.mockResolvedValueOnce(Response.json({ error: reason }, { status: 401 }));
    f.button("Sign in with Passkey").click();
    await vi.waitFor(() =>
      expect(f.alert()).toBe(
        "That passkey is for an Omnesis account that no longer exists. " +
          (googleAvailable
            ? "Choose another passkey, or continue with Google."
            : "Choose another passkey."),
      ),
    );
    // A passkey the relay never had may belong to a live account elsewhere: the browser keeps it.
    expect(signal.mock.calls).toEqual(
      forgotten ? [[{ rpId: "relay.example.test", credentialId: "AQID" }]] : [],
    );
    expect(f.button("Sign in with Passkey").disabled).toBe(false);
  }
});

const mine = "a".repeat(64);
const deletionLines = [
  "All your gateways are disconnected from this account and can no longer be reached from outside your home network.",
  "New devices can no longer join by signing in.",
  "Devices you already paired keep working on your home network.",
  "Your sign-in methods and everything this service stores about your account are deleted.",
  "This can't be undone. You can create a new account later from a gateway.",
];
/** Chooses an entry of the "more options" menu, opening the menu first. */
async function choose(f: Page, text: string) {
  await vi.waitFor(() => expect(more(f).trigger.disabled).toBe(false));
  more(f).trigger.click();
  f.button(text).click();
}
/** Opens the deletion view from an account page showing `session`. */
async function askToDelete(session: object) {
  const f = setup();
  f.session(session);
  installAccountUI();
  await f.wait("Sign-in methods");
  await choose(f, "Delete account");
  await f.wait("Delete your Omnesis account?");
  return f;
}
const deletions = (f: Page) => f.posted("/api/delete");
const choices = (f: Page) => buttons(f, ".delete-account");

test("deleting the account is set apart, says what it does, and takes a second press after a fresh sign-in", async () => {
  const f = setup();
  f.session({ ...withAdded, accountId: mine });
  installAccountUI();
  await f.wait("Sign-in methods");
  // Nothing about deleting is on the page itself: it is one entry of the menu.
  const root = f.document.getElementById("account-root")!;
  expect(f.document.querySelector(".delete-account")).toBeNull();
  expect(root.textContent).not.toContain("Delete your Omnesis account");
  expect([...root.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "Your gateways",
    "Sign-in methods",
  ]);
  expect(root.parentElement!.className).toBe("wide");

  const focused = focuses(f);
  await choose(f, "Delete account");
  await f.wait("Delete your Omnesis account?");
  // The question takes the place of the account, and reading resumes at it.
  const title = f.document.querySelector("h1")!;
  expect(title.textContent).toBe("Delete your Omnesis account?");
  expect(title.getAttribute("tabindex")).toBe("-1");
  expect(focused.at(-1)).toBe(title);
  expect(more(f).trigger).toBeNull();
  expect(root.querySelectorAll("section")).toHaveLength(1);
  const panel = f.document.querySelector(".delete-account")!;
  expect(panel.querySelector("p")!.textContent).toBe(
    "Disconnects your gateways from this account and deletes everything this service stores about it.",
  );
  expect(panel.querySelectorAll("h2")).toHaveLength(0);
  expect([...panel.querySelectorAll("li")].map((line) => line.textContent)).toEqual(deletionLines);
  expect(choices(f)).toEqual(["Delete account permanently", "Cancel"]);
  expect(f.button("Delete account permanently").className).toBe("danger");
  expect(deletions(f)).toEqual([]);
  await press(f, "Cancel");
  // Cancelling returns to the account, with the focus on the button the person came from.
  await f.wait("Sign-in methods");
  expect(f.document.querySelector(".delete-account")).toBeNull();
  expect(f.document.querySelector("h1")!.textContent).toBe("Your Omnesis account");
  expect(focused.at(-1)).toBe(more(f).trigger);
  expect(deletions(f)).toEqual([]);

  // The browser is told each passkey is gone; one it cannot be told about changes nothing.
  const signal = vi
    .fn<(options: { rpId: string; credentialId: string }) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Fixture password manager refused"))
    .mockResolvedValue(undefined);
  Object.assign(f.window.PublicKeyCredential, { signalUnknownCredential: signal });
  await choose(f, "Delete account");
  await vi.waitFor(() => expect(f.button("Delete account permanently")?.disabled).toBe(false));
  f.session(signedOut);
  f.request.mockResolvedValueOnce(Response.json({ ok: true }));
  f.button("Delete account permanently").click();
  await vi.waitFor(() => expect(f.status()).toBe("Your Omnesis account was deleted."));
  expect(deletions(f)).toEqual([{ accountId: mine }]);
  expect(f.document.querySelector("h1")!.textContent).toBe("Sign in to your Omnesis account");
  expect(f.document.querySelector(".delete-account")).toBeNull();
  expect(f.alert()).toBe("");
  expect(signal.mock.calls).toEqual([
    [{ rpId: "relay.example.test", credentialId: "fixture" }],
    [{ rpId: "relay.example.test", credentialId: "AQID" }],
  ]);
});

test("a stale sign-in confirms first, and the confirmation alone deletes nothing", async () => {
  const account = { ...stale, accountId: mine },
    fresh = { ...authenticated, accountId: mine };
  const f = await askToDelete(account);
  const panel = () => f.document.querySelector(".delete-account")!;
  expect(f.document.querySelector("h1")!.textContent).toBe("Delete your Omnesis account?");
  expect([...panel().querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "Confirm it's you",
  ]);
  expect([...panel().querySelectorAll("li")].map((line) => line.textContent)).toEqual(
    deletionLines,
  );
  expect(panel().querySelector("h2 + p")!.textContent).toBe(
    "Deleting your account needs a fresh confirmation, so that someone else using this browser can't delete it. Nothing is deleted until you press Delete account afterwards.",
  );
  expect(choices(f)).toEqual(["Confirm with passkey", "Cancel"]);
  // A cancelled confirmation keeps the question open and deletes nothing.
  f.credentials.get.mockRejectedValueOnce(named("NotAllowedError"));
  await press(f, "Confirm with passkey");
  await vi.waitFor(() => expect(f.alert()).toContain("No passkey was used."));
  expect(choices(f)).toEqual(["Confirm with passkey", "Cancel"]);

  f.afterCeremony(fresh);
  await press(f, "Confirm with passkey");
  await vi.waitFor(() => expect(choices(f)).toEqual(["Delete account permanently", "Cancel"]));
  expect(f.alert()).toBe("");
  expect(deletions(f)).toEqual([]);

  // The confirmation can lapse while the panel is open: it asks again, with no error.
  await vi.waitFor(() => expect(f.button("Delete account permanently").disabled).toBe(false));
  f.session(account);
  f.request.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  f.button("Delete account permanently").click();
  await vi.waitFor(() => expect(choices(f)).toEqual(["Confirm with passkey", "Cancel"]));
  await vi.waitFor(() => expect(idle(f.document)).toBe(true));
  expect(f.alert()).toBe("");
  expect(f.status()).toBe("");

  f.afterCeremony(fresh);
  await press(f, "Confirm with passkey");
  await vi.waitFor(() => expect(f.button("Delete account permanently")?.disabled).toBe(false));
  f.session(signedOut);
  f.request.mockResolvedValueOnce(Response.json({ ok: true }));
  f.button("Delete account permanently").click();
  await vi.waitFor(() => expect(f.status()).toBe("Your Omnesis account was deleted."));
  expect(deletions(f)).toEqual([{ accountId: mine }, { accountId: mine }]);
});

test("a confirmation made with another account's passkey deletes neither account", async () => {
  const f = await askToDelete({ ...stale, accountId: mine });
  f.afterCeremony({ ...authenticated, accountId: "b".repeat(64) });
  await press(f, "Confirm with passkey");
  await vi.waitFor(() =>
    expect(f.status()).toBe("You confirmed with a different Omnesis account. Nothing was deleted."),
  );
  expect(f.document.querySelector(".delete-account")).toBeNull();
  expect(f.document.querySelector("h1")!.textContent).toBe("Your Omnesis account");
  expect(deletions(f)).toEqual([]);
});

test("a deletion the relay refuses leaves the account and the question as they were", async () => {
  const f = await askToDelete({ ...authenticated, accountId: mine });
  await vi.waitFor(() => expect(f.button("Delete account permanently").disabled).toBe(false));
  f.request.mockResolvedValueOnce(new Response("{}", { status: 409 }));
  f.button("Delete account permanently").click();
  await vi.waitFor(() =>
    expect(f.alert()).toBe("Your account could not be deleted. Please try again."),
  );
  expect(choices(f)).toEqual(["Delete account permanently", "Cancel"]);
  expect(f.document.querySelector("h1")!.textContent).toBe("Delete your Omnesis account?");
  expect(f.status()).toBe("");
});

test("a Google confirmation returns to the account page, where deleting is still a press away", async () => {
  const linked = {
    ...stale,
    accountId: mine,
    credentials: { ...stale.credentials, federated: [google] },
  };
  const f = await askToDelete(linked);
  expect(
    [...f.document.querySelectorAll(".delete-account button")].map((button) => [
      button.textContent,
      button.className,
    ]),
  ).toEqual([
    ["Confirm with passkey", ""],
    ["Confirm with Google", "secondary"],
    ["Cancel", "secondary"],
  ]);
  await press(f, "Confirm with Google");
  expect(f.location.assign).toHaveBeenCalledExactlyOnceWith(
    "https://relay.example.test/_relay/web/start?then=delete-account",
  );
  expect(deletions(f)).toEqual([]);

  // Google alone confirms an account without passkeys; a relay without Google offers none.
  const googleOnly = await askToDelete({
    ...linked,
    credentials: { federated: [google], passkeys: [] },
  });
  expect(
    [...googleOnly.document.querySelectorAll(".delete-account button")].map((button) => [
      button.textContent,
      button.className,
    ]),
  ).toEqual([
    ["Confirm with Google", ""],
    ["Cancel", "secondary"],
  ]);
  const withoutGoogle = await askToDelete({ ...linked, googleAvailable: false });
  expect(choices(withoutGoogle)).toEqual(["Confirm with passkey", "Cancel"]);

  // Back from Google with a fresh sign-in: the page says so and has deleted nothing.
  const back = setup();
  back.location.search = "?then=delete-account";
  back.session({ ...linked, credentialsRequireSignIn: false });
  installAccountUI();
  await vi.waitFor(() => expect(back.status()).toBe("Confirmed. You can delete your account now."));
  expect(back.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/_relay/account");
  expect(back.document.querySelector(".delete-account")).toBeNull();
  expect(deletions(back)).toEqual([]);
  await choose(back, "Delete account");
  await vi.waitFor(() => expect(choices(back)).toEqual(["Delete account permanently", "Cancel"]));
  // A sign-in that is not fresh, or an address that is not exact, resumes nothing.
  for (const [search, session] of [
    ["?then=delete-account", linked],
    ["?then=delete-account&then=delete-account", { ...linked, credentialsRequireSignIn: false }],
  ] as const) {
    const ignored = setup();
    ignored.location.search = search;
    ignored.session(session);
    installAccountUI();
    await vi.waitFor(() => expect(ignored.history.replaceState).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(idle(ignored.document)).toBe(true));
    expect(ignored.status()).toBe("");
    expect(ignored.document.querySelector(".delete-account")).toBeNull();
  }
});

/** The parts of the "more options" menu on the page. */
const more = (f: Page) => ({
  trigger: f.document.querySelector(".more-button") as unknown as HTMLButtonElement,
  list: f.document.querySelector('[role="menu"]') as unknown as HTMLElement,
});
/** Records what is given the focus, which the fixture document does not track itself. */
function focuses(f: Page) {
  const focused: unknown[] = [];
  (f.window as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype.focus =
    function (this: HTMLElement) {
      focused.push(this);
    };
  return focused;
}
const key = (f: Page, target: Element, name: string) => {
  const event = Object.assign(new f.window.Event("keydown", { bubbles: true, cancelable: true }), {
    key: name,
  });
  target.dispatchEvent(event);
  return event;
};

test("signing out and deleting sit behind one button that works from the keyboard", async () => {
  const f = setup();
  f.session({ ...withAdded, accountId: mine });
  installAccountUI();
  await f.wait("Sign-in methods");
  const focused = focuses(f),
    { trigger, list } = more(f),
    root = f.document.getElementById("account-root")!;
  // First on the page, so it is reached first and drawn in the corner.
  expect(root.firstElementChild).toBe(trigger.parentElement);
  expect(trigger.getAttribute("aria-label")).toBe("More options");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toBe("");
  expect(list.hidden).toBe(true);
  const items = [...list.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  expect(
    items.map((item) => [item.textContent, item.getAttribute("role"), item.className]),
  ).toEqual([
    ["Sign out", "menuitem", ""],
    ["Delete account", "menuitem", "danger"],
  ]);
  expect(buttons(f, "#account-root > section")).toEqual([
    "",
    "Unlink from account",
    "Remove",
    "Remove",
    "Add a passkey",
    "Link Google",
  ]);
  // Keys mean nothing to a closed menu.
  key(f, trigger, "Escape");
  expect(focused).toEqual([]);

  await vi.waitFor(() => expect(trigger.disabled).toBe(false));
  f.document.querySelector('[role="status"]')!.textContent = "Fixture notice";
  trigger.click();
  expect(list.hidden).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(focused).toEqual([items[0]]);
  // Opening it is not an action: what the page was saying stays.
  expect(f.status()).toBe("Fixture notice");
  // The arrows go round the entries, and any other key is left to the browser.
  expect(key(f, items[0]!, "ArrowDown").defaultPrevented).toBe(true);
  key(f, items[1]!, "ArrowDown");
  key(f, items[0]!, "ArrowUp");
  key(f, trigger, "ArrowUp");
  expect(focused.slice(1)).toEqual([items[1], items[0], items[1], items[0]]);
  expect(key(f, items[0]!, "Enter").defaultPrevented).toBe(false);
  expect(list.hidden).toBe(false);

  // Escape closes it and hands the focus back; Tab closes it and lets the focus move on.
  key(f, items[0]!, "Escape");
  expect(list.hidden).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(focused.at(-1)).toBe(trigger);
  trigger.click();
  focused.length = 0;
  key(f, items[1]!, "Tab");
  expect(list.hidden).toBe(true);
  expect(focused).toEqual([]);
  // The button closes what it opened.
  trigger.click();
  trigger.click();
  expect(list.hidden).toBe(true);

  // A press elsewhere closes it: on nothing, the button has the focus again; on a control, that control keeps it.
  trigger.click();
  list.dispatchEvent(new f.window.Event("click", { bubbles: true }));
  expect(list.hidden).toBe(false);
  focused.length = 0;
  f.document.querySelector("h1")!.dispatchEvent(new f.window.Event("click", { bubbles: true }));
  expect(list.hidden).toBe(true);
  expect(focused).toEqual([trigger]);
  trigger.click();
  focused.length = 0;
  f.document
    .querySelector(".gateway .row-title")!
    .dispatchEvent(new f.window.Event("click", { bubbles: true, cancelable: true }));
  expect(list.hidden).toBe(true);
  expect(focused).toEqual([]);

  // Signing out is the first entry, and it leaves no menu behind.
  await choose(f, "Sign out");
  await f.wait("Sign in with Passkey");
  expect(f.posted("/api/logout")).toEqual([{}]);
  expect(more(f).trigger).toBeNull();
  expect(root.parentElement!.className).toBe("");
  // A press where there is no menu is nobody's business.
  f.document.body.click();
});
function connectSetup() {
  const { document, window } = parseHTML(
    '<html><body><p id="account-error"></p><form id="connect-form"><input id="connect-code"><button type="submit">Continue</button></form></body></html>',
  );
  const location = { origin: "https://relay.example.test", assign: vi.fn() };
  Object.assign(window, { location });
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ location: "/_relay/account?desktop=fixture" }),
  );
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("fetch", request);
  installConnectUI();
  const submit = async () => {
    (document.getElementById("connect-code") as unknown as HTMLInputElement).value = "abcd-ef23";
    document.getElementById("connect-form")!.dispatchEvent(new window.Event("submit"));
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
  };
  const alert = () => document.getElementById("account-error")!.textContent;
  return { document, location, request, submit, alert };
}

test("the connect page claims the typed code and follows only a same-origin location", async () => {
  const f = connectSetup();
  await f.submit();
  await vi.waitFor(() =>
    expect(f.location.assign).toHaveBeenCalledWith(
      "https://relay.example.test/_relay/account?desktop=fixture",
    ),
  );
  const [path, init] = f.request.mock.calls[0]!;
  expect(path).toBe("/_relay/v3/connect/claim");
  expect(JSON.parse(String(init!.body))).toEqual({ code: "abcd-ef23" });
});

test("the connect page explains refusals and lets the user try again", async () => {
  for (const [response, text] of [
    [() => new Response("", { status: 404 }), "didn't work"],
    [() => new Response("", { status: 429 }), "Too many tries"],
    [() => new Response("", { status: 409 }), "already used in another browser"],
    [() => Response.json({ location: "https://foreign.example.test/" }), "went wrong"],
    [
      () => {
        throw new TypeError("private network detail");
      },
      "went wrong",
    ],
  ] as const) {
    const f = connectSetup();
    f.request.mockImplementationOnce(async () => response());
    await f.submit();
    await vi.waitFor(() => expect(f.alert()).toContain(text));
    expect(f.alert()).not.toContain("private");
    expect(f.location.assign).not.toHaveBeenCalled();
    const button = f.document.querySelector("button") as unknown as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  }
});

test("the connect script stays self-contained when served as one function", async () => {
  const f = connectSetup();
  expect(() =>
    runInNewContext(`(${installConnectUI.toString()})();`, {
      document: f.document,
      window: { location: f.location },
      fetch: f.request,
      URL,
      JSON,
      TypeError,
    }),
  ).not.toThrow();
});

// ── Gateways: whether each is online, and unlinking one ──────────────────────

const home = {
  gatewayId: "00000000-0000-4000-8000-000000000001",
  publicOrigin: "https://g-home.example.test",
  displayName: "Fictional home",
  online: true,
};
const cabin = {
  gatewayId: "00000000-0000-4000-8000-000000000002",
  publicOrigin: "https://g-cabin.example.test",
  displayName: "Fictional cabin",
  online: false,
};
const twoGateways = { ...authenticated, accountId: mine, gateways: [home, cabin] };
const unlinkLines = [
  "Nothing on the gateway is deleted. Its data stays where it is.",
  "It can no longer be reached from outside your home network, and new devices can no longer join it by signing in. Devices you already paired keep working on your home network.",
  "To use it from outside your home network again, connect it again from its settings.",
];
const unlinks = (f: Page) => f.posted("/api/gateways/unlink");
/** Each gateway row: its name, address and whether it is online, as text. */
const rows = (f: Page) =>
  [...f.document.querySelectorAll(".gateway-item")].map((row) => ({
    text: [...row.querySelectorAll(".row-title, .row-meta, .presence")].map(
      (part) => part.textContent,
    ),
    online: row.querySelector(".presence")!.className === "presence online",
    action: row.querySelector(".more-button")!.getAttribute("aria-label"),
  }));
/** The "…" menu on a gateway's row, by the gateway's name. */
const rowMenu = (f: Page, name: string) => {
  const trigger = [...f.document.querySelectorAll(".gateway-item .more-button")].find(
    (button) => button.getAttribute("aria-label") === `More actions for “${name}”`,
  ) as unknown as HTMLButtonElement;
  const wrapper = trigger.parentElement!;
  return {
    trigger,
    list: wrapper.querySelector('[role="menu"]') as unknown as HTMLElement,
    item: wrapper.querySelector('[role="menuitem"]') as unknown as HTMLButtonElement,
  };
};
async function askToUnlink(session: object, name = "Fictional home") {
  const f = setup();
  f.session(session);
  installAccountUI();
  await f.wait("Fictional cabin");
  await vi.waitFor(() => expect(rowMenu(f, name).trigger.disabled).toBe(false));
  rowMenu(f, name).trigger.click();
  rowMenu(f, name).item.click();
  await f.wait("from your account?");
  return f;
}

test("each gateway says whether it is online, with a dot and the word, and the list is read again when the tab comes back", async () => {
  const f = setup();
  f.session(twoGateways);
  installAccountUI();
  await f.wait("Fictional cabin");
  expect(rows(f)).toEqual([
    {
      text: ["Fictional home", "g-home.example.test", "Online"],
      online: true,
      action: "More actions for “Fictional home”",
    },
    {
      text: ["Fictional cabin", "g-cabin.example.test", "Offline"],
      online: false,
      action: "More actions for “Fictional cabin”",
    },
  ]);
  // The portal link is unchanged: the row still opens the gateway.
  expect(f.document.querySelector(".gateway-item a")!.getAttribute("href")).toBe(
    "https://g-home.example.test/portal/",
  );
  const sessions = () =>
    f.request.mock.calls.filter(([url]) => String(url).includes("/api/session")).length;
  await vi.waitFor(() => expect(idle(f.document)).toBe(true));
  const read = sessions();
  // Nothing polls while the tab stays as it is.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sessions()).toBe(read);
  // Hidden, then shown again: the relay is asked once more, and the dots follow.
  f.session({
    ...twoGateways,
    gateways: [
      { ...home, online: false },
      { ...cabin, online: true },
    ],
  });
  Object.defineProperty(f.document, "visibilityState", { value: "hidden", configurable: true });
  f.document.dispatchEvent(new f.window.Event("visibilitychange"));
  expect(sessions()).toBe(read);
  Object.defineProperty(f.document, "visibilityState", { value: "visible", configurable: true });
  f.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await vi.waitFor(() =>
    expect(rows(f).map((row) => [row.text[0], row.online])).toEqual([
      ["Fictional home", false],
      ["Fictional cabin", true],
    ]),
  );
  expect(sessions()).toBe(read + 1);
  expect(f.alert()).toBe("");
});

test("unlinking a gateway asks in the page, says nothing on the gateway is deleted, and unlinks only after the press", async () => {
  const f = await askToUnlink(twoGateways);
  const panel = f.document.querySelector(".unlink")!;
  // The question sits under the gateway it is about.
  expect(panel.previousElementSibling!.textContent).toContain("Fictional home");
  expect(panel.querySelector("h3")!.textContent).toBe("Unlink “Fictional home” from your account?");
  expect([...panel.querySelectorAll("p")].map((line) => line.textContent)).toEqual(unlinkLines);
  expect(buttons(f, ".unlink")).toEqual(["Unlink gateway", "Cancel"]);
  expect(f.button("Unlink gateway").className).toBe("danger");
  expect(unlinks(f)).toEqual([]);
  // Cancelling leaves the gateway where it was.
  await press(f, "Cancel");
  await vi.waitFor(() => expect(f.document.querySelector(".unlink")).toBeNull());
  expect(unlinks(f)).toEqual([]);

  const g = await askToUnlink(twoGateways);
  await vi.waitFor(() => expect(g.button("Unlink gateway").disabled).toBe(false));
  g.request.mockResolvedValueOnce(Response.json({ ok: true }));
  g.session({ ...twoGateways, gateways: [cabin] });
  g.button("Unlink gateway").click();
  await vi.waitFor(() =>
    expect(g.status()).toBe("“Fictional home” was unlinked from your account."),
  );
  expect(unlinks(g)).toEqual([{ accountId: mine, gatewayId: home.gatewayId }]);
  expect(g.document.querySelector(".unlink")).toBeNull();
  expect(rows(g).map((row) => row.text[0])).toEqual(["Fictional cabin"]);
  // The message stands under the gateways, where the person is looking.
  expect(g.document.querySelector('[role="status"]')!.closest("section")!.textContent).toContain(
    "Your gateways",
  );
  expect(g.alert()).toBe("");
});

test("unlinking the last, offline gateway says it learns of it when it is back, and leaves an empty list", async () => {
  const f = await askToUnlink({ ...twoGateways, gateways: [cabin, home] }, "Fictional cabin");
  await vi.waitFor(() => expect(f.button("Unlink gateway").disabled).toBe(false));
  f.request.mockResolvedValueOnce(Response.json({ ok: true }));
  f.session({ ...twoGateways, gateways: [] });
  f.button("Unlink gateway").click();
  await vi.waitFor(() =>
    expect(f.status()).toBe(
      "“Fictional cabin” was unlinked from your account. It shows as not connected the next time it comes online.",
    ),
  );
  expect(f.document.querySelectorAll(".gateway-item")).toHaveLength(0);
  expect(f.document.getElementById("account-root")!.textContent).toContain(
    "No gateways are connected to your Omnesis account. Connect one from its settings.",
  );
});

test("a stale sign-in confirms with the passkey, which unlinks at once, and another account's passkey unlinks nothing", async () => {
  const account = { ...twoGateways, credentialsRequireSignIn: true };
  const f = await askToUnlink(account);
  const panel = () => f.document.querySelector(".unlink")!;
  expect([...panel().querySelectorAll("p")].map((line) => line.textContent)).toEqual([
    ...unlinkLines,
    "Unlinking needs a fresh confirmation, so that someone else using this browser can't unlink your gateways. Confirming with your passkey unlinks it right away.",
  ]);
  expect(buttons(f, ".unlink")).toEqual(["Confirm with passkey", "Cancel"]);
  // A cancelled passkey prompt keeps the question open and unlinks nothing.
  f.credentials.get.mockRejectedValueOnce(named("NotAllowedError"));
  await press(f, "Confirm with passkey");
  await vi.waitFor(() => expect(f.alert()).toContain("No passkey was used."));
  expect(buttons(f, ".unlink")).toEqual(["Confirm with passkey", "Cancel"]);
  expect(unlinks(f)).toEqual([]);

  f.afterCeremony({ ...twoGateways });
  await vi.waitFor(() => expect(f.button("Confirm with passkey").disabled).toBe(false));
  f.button("Confirm with passkey").click();
  await vi.waitFor(() => expect(unlinks(f)).toHaveLength(1));
  expect(unlinks(f)).toEqual([{ accountId: mine, gatewayId: home.gatewayId }]);

  const other = await askToUnlink(account);
  other.afterCeremony({ ...twoGateways, accountId: "b".repeat(64) });
  await press(other, "Confirm with passkey");
  await vi.waitFor(() =>
    expect(other.status()).toBe(
      "You confirmed with a different Omnesis account. Nothing was unlinked.",
    ),
  );
  expect(other.document.querySelector(".unlink")).toBeNull();
  expect(unlinks(other)).toEqual([]);
});

test("an account without a passkey is never asked for one: Google confirms, and unlinking is a press away on return", async () => {
  const googleOnly = {
    ...twoGateways,
    credentialsRequireSignIn: true,
    credentials: { federated: [google], passkeys: [] },
  };
  const f = await askToUnlink(googleOnly);
  expect(
    [...f.document.querySelectorAll(".unlink button")].map((button) => [
      button.textContent,
      button.className,
    ]),
  ).toEqual([
    ["Confirm with Google", ""],
    ["Cancel", "secondary"],
  ]);
  expect(f.document.querySelector(".unlink")!.textContent).not.toContain("passkey");
  await press(f, "Confirm with Google");
  expect(f.location.assign).toHaveBeenCalledExactlyOnceWith(
    "https://relay.example.test/_relay/web/start?then=unlink-gateway",
  );
  expect(f.credentials.get).not.toHaveBeenCalled();
  expect(unlinks(f)).toEqual([]);

  // Back from Google with a fresh sign-in: the page says so, and nothing is unlinked yet.
  const back = setup();
  back.location.search = "?then=unlink-gateway";
  back.session({ ...googleOnly, credentialsRequireSignIn: false });
  installAccountUI();
  await vi.waitFor(() => expect(back.status()).toBe("Confirmed. You can unlink it now."));
  expect(back.document.querySelector('[role="status"]')!.closest("section")!.textContent).toContain(
    "Your gateways",
  );
  expect(back.history.replaceState).toHaveBeenCalledWith(null, "", "/_relay/account");
  expect(unlinks(back)).toEqual([]);
  // Still stale, the return says nothing.
  const lapsed = setup();
  lapsed.location.search = "?then=unlink-gateway";
  lapsed.session(googleOnly);
  installAccountUI();
  await lapsed.wait("Fictional cabin");
  await vi.waitFor(() => expect(idle(lapsed.document)).toBe(true));
  expect(lapsed.status()).toBe("");
});

test("a confirmation that lapses asks again, a gateway already gone is said plainly, and a refusal keeps the question", async () => {
  const f = await askToUnlink(twoGateways);
  // The fresh sign-in lapsed while the panel was open.
  await vi.waitFor(() => expect(f.button("Unlink gateway").disabled).toBe(false));
  f.session({ ...twoGateways, credentialsRequireSignIn: true });
  f.request.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  f.button("Unlink gateway").click();
  await vi.waitFor(() => expect(buttons(f, ".unlink")).toEqual(["Confirm with passkey", "Cancel"]));
  await vi.waitFor(() => expect(idle(f.document)).toBe(true));
  expect(f.alert()).toBe("");

  const gone = await askToUnlink(twoGateways);
  await vi.waitFor(() => expect(gone.button("Unlink gateway").disabled).toBe(false));
  gone.request.mockResolvedValueOnce(new Response("{}", { status: 404 }));
  gone.session({ ...twoGateways, gateways: [cabin] });
  gone.button("Unlink gateway").click();
  await vi.waitFor(() => expect(gone.status()).toBe("That gateway is no longer in your account."));
  expect(gone.document.querySelector(".unlink")).toBeNull();
  expect(gone.alert()).toBe("");

  const refused = await askToUnlink(twoGateways);
  await vi.waitFor(() => expect(refused.button("Unlink gateway").disabled).toBe(false));
  refused.request.mockResolvedValueOnce(new Response("{}", { status: 503 }));
  refused.button("Unlink gateway").click();
  await vi.waitFor(() =>
    expect(refused.alert()).toBe("The gateway could not be unlinked. Please try again."),
  );
  expect(buttons(refused, ".unlink")).toEqual(["Unlink gateway", "Cancel"]);

  // Unlinked from another browser meanwhile, the question goes with the gateway.
  const elsewhere = await askToUnlink(twoGateways);
  elsewhere.session({ ...twoGateways, gateways: [cabin] });
  Object.defineProperty(elsewhere.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  await vi.waitFor(() => expect(idle(elsewhere.document)).toBe(true));
  elsewhere.document.dispatchEvent(new elsewhere.window.Event("visibilitychange"));
  await vi.waitFor(() => expect(elsewhere.document.querySelector(".unlink")).toBeNull());
  expect(unlinks(elsewhere)).toEqual([]);
});

test("a passkey confirmation for a gateway unlinked meanwhile says so instead of failing", async () => {
  const f = await askToUnlink({ ...twoGateways, credentialsRequireSignIn: true });
  // Unlinked from another browser while the passkey prompt was open.
  f.afterCeremony({ ...twoGateways, gateways: [cabin] });
  await press(f, "Confirm with passkey");
  await vi.waitFor(() => expect(f.status()).toBe("That gateway is no longer in your account."));
  expect(unlinks(f)).toEqual([]);
  expect(f.alert()).toBe("");
  expect(f.document.querySelector(".unlink")).toBeNull();
});

test("a refresh from returning to the tab that lands during an unlink draws nothing over its result", async () => {
  const f = await askToUnlink(twoGateways);
  await vi.waitFor(() => expect(f.button("Unlink gateway").disabled).toBe(false));
  // The person returns to the tab; the relay is slow to answer that read.
  let answer!: (response: Response) => void;
  f.request.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
  Object.defineProperty(f.document, "visibilityState", { value: "visible", configurable: true });
  f.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await vi.waitFor(() => expect(answer).toBeDefined());
  // Meanwhile they press Unlink, which finishes first.
  f.request.mockResolvedValueOnce(Response.json({ ok: true }));
  f.session({ ...twoGateways, gateways: [cabin] });
  f.button("Unlink gateway").click();
  await vi.waitFor(() =>
    expect(f.status()).toBe("“Fictional home” was unlinked from your account."),
  );
  // The late answer still lists the gateway; it is dropped.
  answer(Response.json(twoGateways));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(rows(f).map((row) => row.text[0])).toEqual(["Fictional cabin"]);
  expect(f.status()).toBe("“Fictional home” was unlinked from your account.");
});

test("an unnamed gateway is unlinked by its address's placeholder name, the message survives a refresh, and a refresh that fails changes nothing", async () => {
  const unnamed = { ...home, displayName: undefined };
  const f = await askToUnlink({ ...twoGateways, gateways: [unnamed, cabin] }, "Gateway");
  expect(f.document.querySelector(".unlink h3")!.textContent).toBe(
    "Unlink “Gateway” from your account?",
  );
  await vi.waitFor(() => expect(f.button("Unlink gateway").disabled).toBe(false));
  f.request.mockResolvedValueOnce(Response.json({ ok: true }));
  f.session({ ...twoGateways, gateways: [cabin] });
  f.button("Unlink gateway").click();
  await vi.waitFor(() => expect(f.status()).toBe("“Gateway” was unlinked from your account."));
  await vi.waitFor(() => expect(idle(f.document)).toBe(true));
  const inGateways = () =>
    f.document.querySelector('[role="status"]')!.closest("section")!.querySelector("h2")!
      .textContent;
  Object.defineProperty(f.document, "visibilityState", { value: "visible", configurable: true });
  // Read again on return to the tab, the message stays where it was.
  f.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await vi.waitFor(() =>
    expect(
      f.request.mock.calls.filter(([url]) => String(url).includes("/api/session")).length,
    ).toBeGreaterThan(2),
  );
  await vi.waitFor(() => expect(inGateways()).toBe("Your gateways"));
  expect(f.status()).toBe("“Gateway” was unlinked from your account.");
  // A read that fails says nothing and leaves the page as it was.
  f.request.mockRejectedValueOnce(new TypeError("Fixture network down"));
  f.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.alert()).toBe("");
  expect(rows(f).map((row) => row.text[0])).toEqual(["Fictional cabin"]);
});

test("each gateway's actions sit behind its own \u201c…\u201d menu, apart from the link, and work from the keyboard", async () => {
  const f = setup();
  f.session(twoGateways);
  installAccountUI();
  await f.wait("Fictional cabin");
  await vi.waitFor(() => expect(idle(f.document)).toBe(true));
  const focused = focuses(f);
  const homeMenu = rowMenu(f, "Fictional home"),
    cabinMenu = rowMenu(f, "Fictional cabin"),
    account = more(f);
  // Beside the link, never inside it, so opening the menu never opens the gateway.
  expect(homeMenu.trigger.closest("a")).toBeNull();
  expect(homeMenu.trigger.closest(".gateway-item")!.querySelector("a.gateway")).not.toBeNull();
  expect(homeMenu.trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(homeMenu.trigger.textContent).toBe("");
  expect(homeMenu.list.hidden).toBe(true);
  expect(
    [...homeMenu.list.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
  ).toEqual(["Unlink from account"]);
  // One menu open at a time: opening a row's closes the account's, and the other way round.
  account.trigger.click();
  homeMenu.trigger.click();
  expect(account.list.hidden).toBe(true);
  expect(homeMenu.list.hidden).toBe(false);
  expect(homeMenu.trigger.getAttribute("aria-expanded")).toBe("true");
  expect(focused.at(-1)).toBe(homeMenu.item);
  cabinMenu.trigger.click();
  expect(homeMenu.list.hidden).toBe(true);
  expect(cabinMenu.list.hidden).toBe(false);
  // Escape closes it and hands the focus back to its button.
  key(f, cabinMenu.item, "Escape");
  expect(cabinMenu.list.hidden).toBe(true);
  expect(focused.at(-1)).toBe(cabinMenu.trigger);
  // A press elsewhere closes it.
  homeMenu.trigger.click();
  f.document.querySelector("h1")!.dispatchEvent(new f.window.Event("click", { bubbles: true }));
  expect(homeMenu.list.hidden).toBe(true);
  expect(unlinks(f)).toEqual([]);
  // Choosing the one entry asks in the page; cancelling returns to the menu's button.
  homeMenu.trigger.click();
  homeMenu.item.click();
  await f.wait("Unlink “Fictional home” from your account?");
  await press(f, "Cancel");
  await vi.waitFor(() => expect(f.document.querySelector(".unlink")).toBeNull());
  expect(focused.at(-1)).toBe(rowMenu(f, "Fictional home").trigger);
  expect(unlinks(f)).toEqual([]);
  expect(f.location.assign).not.toHaveBeenCalled();
});

// ── The invite page ──────────────────────────────────────────────────────────

const inviteToken = "aGVhZGVy.Y2xhaW1z." + "s".repeat(86);
function inviteSetup(hash = `#${inviteToken}`) {
  const { document, window } = parseHTML(
    '<html><body><div id="invite-missing" hidden><h1>This link has no invite in it</h1></div><div id="invite-found" hidden><h1>You\'re invited to Omnesis</h1><p id="invite-status"></p><p id="invite-value"></p><button type="button" id="invite-copy" hidden>Copy invite</button><code id="invite-command"></code></div></body></html>',
  );
  const href = `https://relay.example.test/invite${hash}`;
  const location = { origin: "https://relay.example.test", hash, href };
  Object.assign(window, { location });
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "valid", expiresAt: Date.UTC(2026, 11, 24, 12) / 1000 }),
  );
  const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", { clipboard });
  vi.stubGlobal("fetch", request);
  const status = () => document.getElementById("invite-status")!.textContent;
  const copy = () => document.getElementById("invite-copy") as unknown as HTMLButtonElement;
  const command = () => document.getElementById("invite-command")!.textContent;
  const shown = () => ({
    missing: !document.getElementById("invite-missing")!.hasAttribute("hidden"),
    found: !document.getElementById("invite-found")!.hasAttribute("hidden"),
  });
  return { document, window, href, request, clipboard, status, copy, command, shown };
}

test("the invite page checks the invite in its fragment and says until when it works", async () => {
  const f = inviteSetup();
  installInviteUI();
  await vi.waitFor(() => expect(f.status()).toMatch(/^This invite works until .*2026\.$/));
  const [path, init] = f.request.mock.calls[0]!;
  expect(path).toBe("/_relay/v3/signup/invite");
  expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
  expect(JSON.parse(String(init!.body))).toEqual({ invite: inviteToken });
  // The whole link is what the person pastes into their gateway, or passes to the CLI.
  expect(f.shown()).toEqual({ missing: false, found: true });
  expect(f.document.getElementById("invite-value")!.textContent).toBe(f.href);
  expect(f.command()).toBe(`omnesis cloud connect --invite '${f.href}'`);
  expect(f.copy().hidden).toBe(false);
  f.copy().dispatchEvent(new f.window.Event("click"));
  await vi.waitFor(() => expect(f.copy().textContent).toBe("Copied"));
  expect(f.clipboard.writeText).toHaveBeenCalledWith(f.href);
  const refused = inviteSetup();
  refused.clipboard.writeText.mockRejectedValueOnce(new Error("not allowed"));
  installInviteUI();
  refused.copy().dispatchEvent(new refused.window.Event("click"));
  await vi.waitFor(() =>
    expect(refused.copy().textContent).toBe("Select the invite above and copy it"),
  );
});

test("the invite page says plainly when an invite is missing, unusable or can't be checked", async () => {
  // A link with no invite in its fragment shows only that, with nothing to use or copy.
  for (const hash of ["", "#", "#  ", "#%20%20", "#top section"]) {
    const empty = inviteSetup(hash);
    installInviteUI();
    expect(empty.shown()).toEqual({ missing: true, found: false });
    expect(empty.status()).toBe("");
    expect(empty.command()).toBe("");
    expect(empty.document.getElementById("invite-value")!.textContent).toBe("");
    expect(empty.request).not.toHaveBeenCalled();
    expect(empty.copy().hidden).toBe(true);
  }
  for (const [answer, text] of [
    [() => Response.json({ status: "used" }), "already used to create an account"],
    [() => Response.json({ status: "expired" }), "has expired"],
    [() => Response.json({ status: "invalid" }), "isn't valid"],
    [() => Response.json({ status: "something new" }), "isn't valid"],
    [() => new Response("", { status: 429 }), "couldn't check this invite"],
    [
      () => {
        throw new TypeError("private network detail");
      },
      "couldn't check this invite",
    ],
  ] as const) {
    const f = inviteSetup();
    f.request.mockImplementationOnce(async () => answer());
    installInviteUI();
    await vi.waitFor(() => expect(f.status()).toContain(text));
    expect(f.status()).not.toContain("private");
  }
});

test("the invite page checks again when only the link's fragment changes", async () => {
  const f = inviteSetup();
  let answerFirst!: (response: Response) => void;
  f.request.mockImplementationOnce(
    () => new Promise<Response>((resolve) => (answerFirst = resolve)),
  );
  f.request.mockImplementationOnce(async () => Response.json({ status: "used" }));
  installInviteUI();
  expect(f.status()).toBe("Checking your invite…");
  // Another link pasted into the address bar: same page, new fragment, no reload.
  const other = "b3RoZXI.Y2xhaW1z." + "t".repeat(86);
  Object.assign(f.window.location, {
    hash: `#${other}`,
    href: `https://relay.example.test/invite#${other}`,
  });
  f.window.dispatchEvent(new f.window.Event("hashchange"));
  await vi.waitFor(() => expect(f.status()).toContain("already used to create an account"));
  expect(JSON.parse(String(f.request.mock.calls[1]![1]!.body))).toEqual({ invite: other });
  expect(f.document.getElementById("invite-value")!.textContent).toContain(other);
  // The first link's late answer doesn't replace the newer one.
  answerFirst(Response.json({ status: "valid", expiresAt: Date.UTC(2026, 11, 24, 12) / 1000 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.status()).toContain("already used to create an account");
  // Nor does an older check that fails after a newer one answered.
  let failFirst!: (error: Error) => void;
  f.request.mockImplementationOnce(
    () => new Promise<Response>((_resolve, reject) => (failFirst = reject)),
  );
  f.request.mockImplementationOnce(async () => Response.json({ status: "expired" }));
  for (const hash of [`#${inviteToken}`, `#${other}`]) {
    Object.assign(f.window.location, { hash, href: `https://relay.example.test/invite${hash}` });
    f.window.dispatchEvent(new f.window.Event("hashchange"));
  }
  await vi.waitFor(() => expect(f.status()).toContain("has expired"));
  failFirst(new TypeError("offline"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.status()).toContain("has expired");
  expect(f.command()).toContain(other);
  // Clearing the fragment shows only that there is no invite.
  Object.assign(f.window.location, { hash: "", href: "https://relay.example.test/invite" });
  f.window.dispatchEvent(new f.window.Event("hashchange"));
  expect(f.shown()).toEqual({ missing: true, found: false });
  expect(f.command()).toBe("");
  expect(f.copy().hidden).toBe(true);
  expect(f.request).toHaveBeenCalledTimes(4);
});

test("the invite page's command keeps a quote in the link inside the shell quoting", () => {
  const f = inviteSetup();
  Object.assign(f.window.location, { href: `https://relay.example.test/in'vite#${inviteToken}` });
  installInviteUI();
  expect(f.command()).toBe(
    `omnesis cloud connect --invite 'https://relay.example.test/in'\\''vite#${inviteToken}'`,
  );
});

test("the invite script stays self-contained when served as one function", async () => {
  const f = inviteSetup();
  expect(() =>
    runInNewContext(`(${installInviteUI.toString()})();`, {
      document: f.document,
      window: { location: { hash: `#${inviteToken}`, href: f.href }, addEventListener() {} },
      navigator: { clipboard: f.clipboard },
      fetch: f.request,
      JSON,
      Date,
    }),
  ).not.toThrow();
});
