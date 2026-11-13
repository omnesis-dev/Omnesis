// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The cloud relay is purely additive: with OMNESIS_CLOUD_RELAY_ENABLED unset the
// Devices view must render exactly as before, even if a device row happens to
// carry relay fields. These tests pin both sides of that switch.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  buildPairQrPayload: vi.fn(),
  getPairAddresses: vi.fn(),
  fleetUpdateTarget: vi.fn(async () => ({ targetVersion: null })),
  forgetDevice: vi.fn(),
  getFleetDoctor: vi.fn(async () => ({ devices: [] })),
  getNetworkIdentities: vi.fn(async () => ({ items: [] })),
  getDoctorReport: vi.fn(),
  listDevices: vi.fn(async () => ({ items: [] as unknown[] })),
  getAccessOverview: vi.fn(async () => ({ levels: [] })),
  listTokens: vi.fn(async () => ({ items: [] })),
  setDeviceAccessLevel: vi.fn(),
  pairDevice: vi.fn(),
  requestFleetDoctor: vi.fn(async () => ({ devices: [] })),
  requestFleetUpdate: vi.fn(),
  revokeDevice: vi.fn(),
  revokeTokenById: vi.fn(),
  whoami: vi.fn(async () => ({ deviceId: null })),
  withdrawRelayPushConsent: vi.fn(),
}));
vi.mock("../api.js", () => apiMocks);
const pairing = vi.hoisted(() => ({
  cloudPairingConfig: vi.fn(),
  cloudPairingRequests: vi.fn(),
  decideCloudPairing: vi.fn(),
}));
vi.mock("../lib/cloud-pairing-api.js", () => pairing);

// @ts-expect-error — portal is plain JS without sibling declarations.
import { DeviceCard, DevicesView } from "./devices.js";

let host: HTMLElement;
const device = {
  id: "device_one",
  name: "Fictional laptop",
  kind: "cli",
  pairedAt: 1,
  lastSeenAt: 2,
  online: true,
  revokedAt: null,
  capabilities: {},
  connectionPath: "relay",
  enrollment: {
    method: "automatic",
    signIn: "google",
    joinedAt: Date.now() - 60_000,
  },
};
beforeEach(() => {
  const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  apiMocks.apiFetch.mockReset();
  apiMocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ items: [] })));
  apiMocks.listDevices.mockResolvedValue({ items: [device] });
  pairing.cloudPairingConfig.mockReset();
  pairing.cloudPairingConfig.mockResolvedValue({ clientId: "fictional" });
  pairing.cloudPairingRequests.mockReset();
  pairing.cloudPairingRequests.mockResolvedValue({ items: [] });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
const card = (props: Record<string, unknown> = {}) =>
  h(DeviceCard, {
    device,
    isThis: false,
    tokens: [],
    expanded: false,
    onToggle: vi.fn(),
    onRevokeDevice: vi.fn(),
    onForgetDevice: vi.fn(),
    onWithdrawRelayConsent: vi.fn(),
    onRevokeToken: vi.fn(),
    ...props,
  });

test("flag off: a device row shows nothing relay-related, even when the row carries relay fields", async () => {
  await act(async () => render(card(), host));
  const text = host.textContent ?? "";
  for (const value of ["Joined", "Remote", "Approved"])
    expect(text).not.toContain(value);
  expect(host.querySelector(".device-connection-pill")).toBeNull();
  expect(host.querySelector(".devices-card-sub")?.textContent).toBe("CLI");
});

test("flag off: the view adds no class, no section and no request", async () => {
  await act(async () => render(h(DevicesView, {}), host));
  await vi.waitFor(() => expect(host.querySelector(".devices-card")).not.toBeNull());
  expect(host.querySelector(".devices-view")?.getAttribute("class")).toBe("devices-view");
  expect(
    host.querySelector(".relay-on, .cloud-pairing-requests"),
  ).toBeNull();
  expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  expect(pairing.cloudPairingConfig).not.toHaveBeenCalled();
});

test("flag on: rows say how each device joined and show the connection path", async () => {
  await act(async () => render(card({ cloudRelay: true }), host));
  expect(host.querySelector(".devices-card-sub")?.textContent).toBe("CLI · Joined with Omnesis account");
  expect(host.querySelector(".device-connection-pill")?.textContent).toBe("Remote");
  // Remove stays one menu away for every device.
  expect(host.querySelector(".devices-card-menu")).not.toBeNull();
  await act(async () =>
    render(card({ cloudRelay: true, device: { ...device, enrollment: undefined } }), host),
  );
  expect(host.querySelector(".devices-card-sub")?.textContent).toBe("CLI");
});

test("flag on: the view scopes its relay styles and adds the approval section", async () => {
  apiMocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ items: [] })));
  await act(async () => render(h(DevicesView, { cloudRelay: true }), host));
  await vi.waitFor(() => expect(pairing.cloudPairingConfig).toHaveBeenCalled());
  expect(host.querySelector(".devices-view")?.getAttribute("class")).toBe("devices-view relay-on");
});
