// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The connect dialog on the Access page, with the gateway's own Tailscale device: its
// address joins the others the dialog offers, beside the owner's own and the
// cloud relay's, and the page reads nothing about it with the feature off.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  completeAccessAuthorization: vi.fn(),
  createAccessLevel: vi.fn(),
  decideAccessAuthorization: vi.fn(),
  deleteAccessLevel: vi.fn(),
  getAccessAuthorization: vi.fn(),
  getAccessOverview: vi.fn(),
  listDevices: vi.fn(),
  lookupAccessAuthorization: vi.fn(),
  moveConnectionLevel: vi.fn(),
  pairDevice: vi.fn(),
  renameAccessPrincipal: vi.fn(),
  revokeAccess: vi.fn(),
  updateAccessLevel: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn(), replaceRoute: vi.fn() }));
const relayApi = vi.hoisted(() => ({ relayManagement: vi.fn() }));
const tailscaleApi = vi.hoisted(() => ({ getTailscale: vi.fn() }));

vi.mock("../api.js", () => api);
vi.mock("../lib/router.js", () => router);
vi.mock("../lib/cloud-relay-api.js", () => relayApi);
vi.mock("../lib/tailscale-api.js", () => tailscaleApi);
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));

// @ts-expect-error — portal modules are plain JS.
import { AccessView } from "./access.js";

const RELAY = "https://g-fictional.relay.example.test/mcp";
const LOCAL = "https://localhost:7600/mcp";
const OWN = "https://gateway.example.org/mcp";
const DEVICE = "https://omnesis.example-net.ts.net/mcp";

function overview(resource: string, extra: Record<string, unknown> = {}, others: string[] = [RELAY]) {
  return {
    principals: [],
    levels: [],
    oauth: {
      resource,
      resources: [resource, ...others].map((entry) => ({
        resource: entry,
        servedByGateway: false,
        direct: false,
        publiclyTrusted: true,
      })),
      ...extra,
    },
  };
}

function relayStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    configured: true,
    serviceConfigured: true,
    enrollment: { state: "enrolled" },
    tunnel: { state: "online" },
    publicMcp: { ready: true, url: RELAY },
    ...overrides,
  };
}
function device(publicState: string) {
  return {
    enabled: true,
    connection: "connected",
    url: "https://omnesis.example-net.ts.net",
    public: { wanted: publicState !== "off", state: publicState },
  };
}

describe("Access page with the gateway's Tailscale device", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getAccessAuthorization.mockResolvedValue({ request: null });
    api.listDevices.mockResolvedValue({ items: [] });
    relayApi.relayManagement.mockResolvedValue(relayStatus());
    tailscaleApi.getTailscale.mockResolvedValue(device("on"));
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function mount(props: Record<string, unknown> = {}) {
    await act(async () => { render(h(AccessView, { connectOpen: true, ...props }), host); await Promise.resolve(); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
  }
  const addressSelect = () => host.querySelector<HTMLSelectElement>("#access-mcp-address");
  const addressOptions = () => [...(addressSelect()?.querySelectorAll("option") ?? [])].map((option) => option.textContent);
  const shownAddress = () => host.querySelector(".access-connect-step .access-mcp-resource code")?.textContent;

  test("flag off: the device is never read and its address is no choice", async () => {
    api.getAccessOverview.mockResolvedValue(overview(LOCAL, { loopbackOnly: true }, [DEVICE]));
    await mount();
    expect(tailscaleApi.getTailscale).not.toHaveBeenCalled();
    expect(addressSelect()).toBeNull();
    expect(shownAddress()).toBe(LOCAL);
  });

  test("the device alone gives a choice, starting on its public address", async () => {
    api.getAccessOverview.mockResolvedValue(overview(LOCAL, { loopbackOnly: true }, [DEVICE]));
    await mount({ tailscaleEmbed: true });
    expect(tailscaleApi.getTailscale).toHaveBeenCalled();
    expect(relayApi.relayManagement).not.toHaveBeenCalled();
    expect(addressOptions()).toEqual([`${LOCAL}`, `${DEVICE}`]);
    expect(addressSelect()?.value).toBe(DEVICE);
  });

  test("the owner's address, the relay's and the device's are all offered together", async () => {
    api.getAccessOverview.mockResolvedValue(overview(OWN, {}, [RELAY, DEVICE]));
    await mount({ cloudRelay: true, tailscaleEmbed: true });
    expect(addressOptions()).toEqual([
      `${OWN}`,
      `${RELAY}`,
      `${DEVICE}`,
    ]);
    expect(addressSelect()?.value).toBe(OWN);
  });

  test("with its public address off the device is offered for the tailnet only", async () => {
    tailscaleApi.getTailscale.mockResolvedValue(device("off"));
    api.getAccessOverview.mockResolvedValue(overview(LOCAL, { loopbackOnly: true }, [DEVICE]));
    await mount({ tailscaleEmbed: true });
    expect(addressOptions()).toEqual([`${LOCAL}`, `${DEVICE}`]);
    expect(addressSelect()?.value).toBe(LOCAL);
  });
});
