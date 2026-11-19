// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The login page and Omnesis account sign-in.
 *
 * The page asks the gateway whether it offers sign-in; a gateway that never
 * linked an account answers 404 (`cloudPairingConfig` resolves null), and its
 * login page is the token and pairing-code form alone.
 */

import { render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { authenticated: false } as Record<string, unknown>,
  cloudPairingConfig: vi.fn(async () => ({
    webSignIn: true,
    gatewayFingerprint: "a".repeat(64),
  })),
}));

vi.mock("./api.js", () => ({
  apiFetch: vi.fn(),
  checkSession: vi.fn(async () => mocks.session),
  getStatus: vi.fn(),
  getHostFleetUpdate: vi.fn(),
  isAuthenticated: vi.fn(() => false),
  login: vi.fn(async () => ({ ok: false })),
  logout: vi.fn(),
  getPendingAccessRequests: vi.fn(),
  listPrivacyApprovals: vi.fn(),
  listSubscriptionApprovals: vi.fn(),
  startHostFleetUpdate: vi.fn(),
}));
vi.mock("./lib/cloud-pairing-api.js", () => ({ cloudPairingConfig: mocks.cloudPairingConfig }));
vi.mock("./lib/format.js", () => ({ loadSourceMeta: vi.fn(async () => {}) }));
vi.mock("./lib/router.js", () => ({
  navigate: vi.fn(),
  onRouteChange: vi.fn(() => () => {}),
  parseRoute: vi.fn(() => ({ view: "agent" })),
  replaceUrl: vi.fn(),
}));
vi.mock("./lib/lazy.js", () => ({ lazy: () => () => null }));

let host: HTMLElement;
const transport = vi.fn();

async function mountLogin(session: Record<string, unknown>): Promise<void> {
  mocks.session = session;
  vi.resetModules();
  // @ts-expect-error — portal modules are plain JS without sibling declarations.
  await import("./app.js");
  await vi.waitFor(() => expect(host.querySelector(".login-card")).not.toBeNull());
  // Let any effect a mounted component starts run.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
  Object.defineProperty(parsed.window, "location", {
    configurable: true,
    value: { href: "https://gateway.example.test/portal/", reload: vi.fn() },
  });
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  vi.stubGlobal("fetch", transport);
  host = parsed.document.querySelector("#app") as unknown as HTMLElement;
  transport.mockReset();
  mocks.cloudPairingConfig.mockClear();
});

afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

test("a gateway with no linked account shows the token form alone", async () => {
  mocks.cloudPairingConfig.mockResolvedValueOnce(null as never);
  await mountLogin({ authenticated: false });
  await vi.waitFor(() => expect(mocks.cloudPairingConfig).toHaveBeenCalledTimes(1));
  expect(transport).not.toHaveBeenCalled();
  expect(host.querySelector(".cloud-pairing-login")).toBeNull();
  expect(host.querySelector(".cloud-pairing-quiet")).toBeNull();
  expect(host.querySelector(".login-input")).not.toBeNull();
});

test("the login page asks the gateway for its sign-in configuration", async () => {
  await mountLogin({ authenticated: false });
  await vi.waitFor(() => expect(mocks.cloudPairingConfig).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(host.querySelector(".cloud-pairing-login")).not.toBeNull());
  // The older Google-only pairing doesn't lead: the token form stays where it was.
  expect(host.querySelector(".login-input")).not.toBeNull();
  expect(host.querySelector(".cloud-pairing-quiet")).toBeNull();
});

test("with account sign-in on offer, it leads and the token form waits behind a quiet link", async () => {
  mocks.cloudPairingConfig.mockResolvedValueOnce({
    webSignIn: true,
    gatewayFingerprint: "a".repeat(64),
    accountSignIn: true,
  } as never);
  await mountLogin({ authenticated: false });
  await vi.waitFor(() => expect(host.querySelector(".cloud-pairing-login")).not.toBeNull());
  await vi.waitFor(() => expect(host.querySelector(".login-input")).toBeNull());
  const quiet = host.querySelector(".cloud-pairing-quiet") as HTMLButtonElement;
  expect(quiet.textContent?.trim()).toBe("Have a pairing code? Enter it");
  quiet.click();
  await vi.waitFor(() => expect(host.querySelector(".login-input")).not.toBeNull());
  // The sign-in stays where it was.
  expect(host.querySelector(".cloud-pairing-login")).not.toBeNull();
});

describe("opening the gateway's own address from a signed-in portal", () => {
  const CODE = "h".repeat(43);
  function arriveWith(hash: string) {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: `https://gateway.example.test/portal/settings/account${hash}`,
        hash,
        pathname: "/portal/settings/account",
        search: "",
        reload: vi.fn(),
      },
    });
    Object.defineProperty(window, "history", {
      configurable: true,
      value: { state: null, replaceState: vi.fn() },
    });
  }
  const redeemed = () =>
    transport.mock.calls.filter(([path]) => path === "/portal/api/handoff/redeem");

  test("a handoff signs this browser in, then the session is read again", async () => {
    arriveWith(`#portal-handoff=${CODE}`);
    transport.mockImplementation(async () => new Response("{}"));
    await mountLogin({ authenticated: false });
    expect(redeemed()).toHaveLength(1);
    expect(JSON.parse(redeemed()[0]![1].body)).toEqual({ code: CODE });
    expect(host.querySelector(".login-reason")).toBeNull();
  });

  test("a spent or expired handoff says so above the sign-in", async () => {
    arriveWith(`#portal-handoff=${CODE}`);
    transport.mockImplementation(async (path: string) =>
      path === "/portal/api/handoff/redeem" ? new Response("{}", { status: 401 }) : new Response("{}"),
    );
    await mountLogin({ authenticated: false });
    expect(host.querySelector(".login-reason")?.textContent).toContain(
      "That link expired or was already used.",
    );
  });

  test("a browser already signed in here never sends a handoff", async () => {
    arriveWith(`#portal-handoff=${CODE}`);
    mocks.session = { authenticated: true };
    vi.resetModules();
    // @ts-expect-error — portal modules are plain JS without sibling declarations.
    await import("./app.js");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redeemed()).toHaveLength(0);
  });
});
