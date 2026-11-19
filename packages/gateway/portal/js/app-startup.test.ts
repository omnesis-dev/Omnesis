// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ComponentChildren } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: true,
  handoff: null as string | null,
  metadataReady: false,
  mounts: 0,
  view: undefined as (() => ComponentChildren) | undefined,
  loadSourceMeta: vi.fn<() => Promise<void>>(),
  redeemHandoff: vi.fn(async () => true),
}));

vi.mock("./lib/cloud-pairing-handoff.js", () => ({
  takeAccountSignIn: vi.fn(),
  takePortalHandoff: () => mocks.handoff,
  redeemPortalHandoff: mocks.redeemHandoff,
}));
vi.mock("./views/search.js", () => ({ SearchView: () => null }));
vi.mock("./api.js", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ conversations: [], nextCursor: null }) })),
  checkSession: vi.fn(async () => ({ authenticated: mocks.authenticated })),
  getStatus: vi.fn(async () => ({ experimental: false, developer: false })),
  getHostFleetUpdate: vi.fn(async () => ({ plan: null, operation: null })),
  isAuthenticated: vi.fn(() => mocks.authenticated),
  login: vi.fn(),
  logout: vi.fn(),
  getTaskCounts: vi.fn(async () => ({ today: 0 })),
  getPendingAccessRequests: vi.fn(async () => ({ pendingRequests: [] })),
  listPrivacyApprovals: vi.fn(async () => ({ totalCount: 0 })),
  listSubscriptionApprovals: vi.fn(async () => ({ totalCount: 0 })),
  startHostFleetUpdate: vi.fn(),
}));
vi.mock("./lib/format.js", () => ({ loadSourceMeta: mocks.loadSourceMeta }));
vi.mock("./lib/router.js", () => ({
  navigate: vi.fn(),
  onRouteChange: vi.fn(() => () => {}),
  parseRoute: vi.fn(() => ({ view: "agent", convoId: null })),
  replaceUrl: vi.fn(),
}));
vi.mock("./lib/lazy.js", () => ({
  lazy: () => function View() { return mocks.view!(); },
}));

let host: HTMLElement;
let unmount: (() => void) | undefined;
let act: typeof import("preact/test-utils").act;
let resolveMetadata: () => void;
let rejectMetadata: (error: Error) => void;

beforeEach(() => {
  const parsed = parseHTML("<html><body><div id='app'></div></body></html>");
  Object.defineProperty(parsed.window, "location", {
    configurable: true,
    value: { href: "https://gateway.example.test/portal/agent", reload: vi.fn() },
  });
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#app") as unknown as HTMLElement;
  mocks.authenticated = true;
  mocks.handoff = null;
  mocks.redeemHandoff.mockReset().mockImplementation(async () => {
    mocks.authenticated = true;
    return true;
  });
  mocks.metadataReady = false;
  mocks.mounts = 0;
  const pending = new Promise<void>((resolve, reject) => {
    resolveMetadata = resolve;
    rejectMetadata = reject;
  });
  mocks.loadSourceMeta.mockReset().mockReturnValue(pending);
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  vi.resetModules();
  // Every mount uses one fresh renderer/hooks graph after resetModules.
  const { h, render } = await import("preact");
  const { useState, useEffect } = await import("preact/hooks");
  ({ act } = await import("preact/test-utils"));
  unmount = () => render(null, host);
  mocks.view = () => {
    const [draft, setDraft] = useState("");
    useEffect(() => { mocks.mounts++; }, []);
    return h("div", { class: "startup-view" },
      h("span", { class: "metadata-label" }, mocks.metadataReady ? "Resolved source label" : "Generic source label"),
      h("input", { class: "draft", value: draft, onInput: (event: Event) => setDraft((event.target as HTMLInputElement).value) }),
    );
  };
  // @ts-expect-error — the portal is plain JS without declarations.
  await import("./app.js");
}

test("renders the login screen without fetching or waiting for source metadata", async () => {
  mocks.authenticated = false;
  await mount();
  await vi.waitFor(() => expect(host.querySelector(".login-card")).not.toBeNull());
  expect(mocks.loadSourceMeta).not.toHaveBeenCalled();
});

test("redeems a portal handoff before mounting the shell without waiting for metadata", async () => {
  mocks.authenticated = false;
  mocks.handoff = "fictional-preview-handoff";
  await mount();
  await vi.waitFor(() => expect(host.querySelector(".app-layout")).not.toBeNull());
  expect(mocks.redeemHandoff).toHaveBeenCalledWith("fictional-preview-handoff");
  await vi.waitFor(() => expect(mocks.loadSourceMeta).toHaveBeenCalledTimes(1));
  expect(mocks.metadataReady).toBe(false);
});

test("renders the authenticated shell first, then refreshes labels without remounting or losing a draft", async () => {
  await mount();
  await vi.waitFor(() => expect(host.querySelector(".app-layout")).not.toBeNull());
  await vi.waitFor(() => expect(mocks.loadSourceMeta).toHaveBeenCalledTimes(1));
  expect(host.querySelector(".metadata-label")?.textContent).toBe("Generic source label");
  const input = host.querySelector(".draft") as HTMLInputElement;
  await act(async () => {
    input.value = "A fictional draft";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  mocks.metadataReady = true;
  await act(async () => resolveMetadata());
  await vi.waitFor(() => expect(host.querySelector(".metadata-label")?.textContent).toBe("Resolved source label"));
  expect(host.querySelector(".draft")).toBe(input);
  expect(input.value).toBe("A fictional draft");
  expect(mocks.mounts).toBe(1);
  expect(mocks.loadSourceMeta).toHaveBeenCalledTimes(1);
});

test("keeps the shell usable when metadata fails", async () => {
  await mount();
  await vi.waitFor(() => expect(mocks.loadSourceMeta).toHaveBeenCalledTimes(1));
  await act(async () => rejectMetadata(new Error("Metadata unavailable")));
  expect(host.querySelector(".app-layout")).not.toBeNull();
  expect(host.querySelector(".metadata-label")?.textContent).toBe("Generic source label");
});

test("ignores metadata settlement after the app has unmounted", async () => {
  await mount();
  await vi.waitFor(() => expect(mocks.loadSourceMeta).toHaveBeenCalledTimes(1));
  unmount!();
  mocks.metadataReady = true;
  await act(async () => resolveMetadata());
  expect(host.childElementCount).toBe(0);
  expect(mocks.mounts).toBe(1);
});
