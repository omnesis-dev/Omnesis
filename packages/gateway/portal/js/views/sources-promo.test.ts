// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const navigation = vi.hoisted(() => vi.fn());
vi.mock("../lib/router.js", () => ({ navigate: navigation }));
const api = vi.hoisted(() => ({
  getAdminSources: vi.fn(),
  getAdminSyncStatus: vi.fn(),
  getOverallStatus: vi.fn(),
  getIndexStats: vi.fn(),
  getAccessOverview: vi.fn(),
  listDevices: vi.fn(),
  getSourceDescriptorsUnion: vi.fn(),
  getSourcesSnapshot: vi.fn(),
  triggerSourceSync: vi.fn(),
  joinSourceMember: vi.fn(),
  detachSourceMember: vi.fn(),
  getSourceDebug: vi.fn(),
  getSourceWatermark: vi.fn(),
  resyncSource: vi.fn(),
  removeAdminSource: vi.fn(),
  pauseSource: vi.fn(),
  resumeSource: vi.fn(),
  addSource: vi.fn(),
  discoverSourceAccounts: vi.fn(),
  enableSourceMultiDeviceMode: vi.fn(),
  getCredentialsStatus: vi.fn(),
  moveSourceToDevice: vi.fn(),
  resolveSourceAccount: vi.fn(),
  updateSourceMemberConfig: vi.fn(),
  validateSourceParam: vi.fn(),
  getAdminConfig: vi.fn(),
  setProviderCredentials: vi.fn(),
  startAuthFlow: vi.fn(),
  cancelAuthFlow: vi.fn(),
  answerAuthChallenge: vi.fn(),
  submitAuthFlowCode: vi.fn(),
  submitAuthFlowWidgetResult: vi.fn(),
  pairDevice: vi.fn(),
}));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal is plain JS without sibling declarations.
import { SourcesView } from "./sources.js";

const companion = {
  id: "invented-companion",
  name: "Invented companion",
  description: "Invented external capture",
  provider: { id: "invented", name: "Invented" },
  execution: "external",
  pushBased: true,
  devices: [],
  setupGuide: "opaque-companion-guide",
  setupGuideContent: {
    version: 1,
    title: "Install the invented companion",
    paragraphs: ["Install, then connect the companion."],
    links: [{ label: "Install companion", url: "https://companion.example.com/install" }],
    pairing: { deviceKind: "browser", label: "Connect companion" },
  },
};

function expectNoSetupMutation() {
  for (const callback of [
    api.getSourcesSnapshot,
    api.addSource,
    api.startAuthFlow,
    api.discoverSourceAccounts,
    api.setProviderCredentials,
    api.validateSourceParam,
    api.pairDevice,
  ]) {
    expect(callback).not.toHaveBeenCalled();
  }
}

describe("Sources companion discovery through Add source", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("main") as unknown as HTMLElement;
    api.getAdminSources.mockResolvedValue({ items: [] });
    api.getAdminSyncStatus.mockResolvedValue({ items: [] });
    api.getOverallStatus.mockResolvedValue({});
    api.getIndexStats.mockResolvedValue(null);
    api.getAccessOverview.mockResolvedValue({ principals: [] });
    api.listDevices.mockResolvedValue({ items: [] });
    api.getSourceDescriptorsUnion.mockResolvedValue({ items: [companion] });
  });
  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("an external companion remains discoverable without a collector, with real guide links and no automatic setup", async () => {
    await act(async () => render(h(SourcesView, {}), host));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading…"));
    expect(host.querySelector(".extension-promo")).toBeNull();
    const add = host.querySelector(".sources-add-btn") as HTMLButtonElement;
    expect(add).toBeTruthy();
    expect(add.disabled).toBe(false);
    expectNoSetupMutation();
    await act(async () => add.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Invented companion"));
    const tile = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Invented companion"),
    ) as HTMLButtonElement;
    expect(tile).toBeTruthy();
    await act(async () => tile.click());
    expect(host.querySelector('[data-setup-guide="available"]')).toBeTruthy();
    expect(host.textContent).toContain("Install the invented companion");
    expect(host.textContent).not.toContain("No online collector");
    expect(host.textContent).not.toContain("Source added");
    const install = host.querySelector("[data-setup-install]") as HTMLAnchorElement;
    expect(install.getAttribute("href")).toBe("https://companion.example.com/install");
    expect(install.getAttribute("target")).toBe("_blank");
    expect(install.getAttribute("rel")).toContain("noopener");
    const pair = host.querySelector("[data-setup-pairing]") as HTMLAnchorElement;
    expect(pair.getAttribute("href")).toBe("/portal/settings/devices?pair=browser");
    expect(navigation).not.toHaveBeenCalled();
    expectNoSetupMutation();
    // LinkeDOM binds bubbling listeners to event.target; dispatch only to this target.
    // Real bubbling navigation is qualified separately in the isolated browser check.
    await act(async () => {
      pair.dispatchEvent(new window.Event("click", { bubbles: false, cancelable: true }));
    });
    expect(navigation).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices?pair=browser");
    expectNoSetupMutation();
  });

  test("a registered external source does not remove access to its provider guide", async () => {
    api.getAdminSources.mockResolvedValue({
      items: [
        {
          id: "invented-companion:fixture",
          type: "invented-companion",
          accountId: "fixture",
          deviceId: "fixture-device",
          enabled: true,
        },
      ],
    });
    await act(async () => render(h(SourcesView, {}), host));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading…"));
    await act(async () => (host.querySelector(".sources-add-btn") as HTMLButtonElement).click());
    await vi.waitFor(() => expect(host.textContent).toContain("Invented companion"));
    const tile = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Invented companion"),
    ) as HTMLButtonElement;
    await act(async () => tile.click());
    expect(host.querySelector('[data-setup-guide="available"]')).toBeTruthy();
    expectNoSetupMutation();
  });

  test("loading withholds setup suggestions without inventing a companion installation", async () => {
    api.getAdminSources.mockReturnValue(new Promise(() => {}));
    await act(async () => render(h(SourcesView, {}), host));
    expect(host.textContent).toContain("Loading…");
    expect(host.querySelector(".sources-promo-row")).toBeNull();
    expect(host.querySelector("[data-setup-guide]")).toBeNull();
    expectNoSetupMutation();
  });
});
