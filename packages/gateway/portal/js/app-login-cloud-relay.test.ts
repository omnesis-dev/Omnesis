// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The login page and the optional cloud relay.
 *
 * A gateway without the opt-in must be asked nothing new by its login page:
 * sign-in is mounted only when the session answer the page already fetches
 * says the gateway offers it.
 */

import { render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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

test("a gateway without the cloud relay gets no sign-in request and no sign-in section", async () => {
  await mountLogin({ authenticated: false });
  expect(mocks.cloudPairingConfig).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(host.querySelector(".cloud-pairing-login")).toBeNull();
  expect(host.querySelector(".login-input")).not.toBeNull();
});

test("a gateway advertising the cloud relay is asked for its sign-in configuration", async () => {
  await mountLogin({ authenticated: false, cloudRelay: true });
  await vi.waitFor(() => expect(mocks.cloudPairingConfig).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(host.querySelector(".cloud-pairing-login")).not.toBeNull());
});
