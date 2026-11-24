// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The devices view and the Omnesis account: a device that joined by signing in
// says so, and one paired with a code or QR renders as it always has, with no
// sign-in, connection pill or extra request on a gateway that never linked an
// account.

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
  getDeviceForgetImpact: vi.fn(async () => ({ sources: [], fingerprint: "fictional-impact" })),
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
const relayApi = vi.hoisted(() => ({ stopTrustingSignIn: vi.fn() }));
vi.mock("../lib/cloud-relay-api.js", async (original) => ({
  ...(await original<object>()),
  ...relayApi,
}));

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
    signInId: "f".repeat(64),
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
  apiMocks.revokeDevice.mockReset();
  apiMocks.revokeDevice.mockResolvedValue({ ok: true });
  relayApi.stopTrustingSignIn.mockReset();
  relayApi.stopTrustingSignIn.mockResolvedValue({});
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

const paired = { ...device, connectionPath: undefined, enrollment: undefined };

test("a device paired with a code shows nothing about sign-ins or its connection", async () => {
  await act(async () => render(card({ device: paired, expanded: true }), host));
  expect(host.querySelector(".devices-card-sign-in")).toBeNull();
  await act(async () => render(card({ device: paired }), host));
  const text = host.textContent ?? "";
  for (const value of ["Joined", "Remote", "Approved"]) expect(text).not.toContain(value);
  expect(host.querySelector(".device-connection-pill")).toBeNull();
  expect(host.querySelector(".devices-card-sub")?.textContent).toBe("CLI");
});

test("a gateway without sign-in pairing asks for no requests and shows no approval section", async () => {
  pairing.cloudPairingConfig.mockResolvedValue(null);
  apiMocks.listDevices.mockResolvedValue({ items: [paired] });
  await act(async () => render(h(DevicesView, {}), host));
  await vi.waitFor(() => expect(host.querySelector(".devices-card")).not.toBeNull());
  await vi.waitFor(() => expect(pairing.cloudPairingConfig).toHaveBeenCalled());
  expect(host.querySelector(".cloud-pairing-requests")?.children.length ?? 0).toBe(0);
  expect(pairing.cloudPairingRequests).not.toHaveBeenCalled();
});

test("rows say how each device joined and show the connection path", async () => {
  await act(async () => render(card(), host));
  expect(host.querySelector(".devices-card-sub")?.textContent).toBe("CLI · Joined with Omnesis account");
  expect(host.querySelector(".device-connection-pill")?.textContent).toBe("Remote");
  // Remove stays one menu away for every device.
  expect(host.querySelector(".devices-card-menu")).not.toBeNull();
  await act(async () =>
    render(card({ device: { ...device, enrollment: undefined } }), host),
  );
  expect(host.querySelector(".devices-card-sub")?.textContent).toBe("CLI");
});

test("with sign-in pairing configured, the view reads the waiting requests", async () => {
  await act(async () => render(h(DevicesView, {}), host));
  await vi.waitFor(() => expect(pairing.cloudPairingRequests).toHaveBeenCalled());
  expect(host.querySelector(".devices-view")?.getAttribute("class")).toBe("devices-view");
});

test("an open device names the sign-in it joined with", async () => {
  await act(async () => render(card({ expanded: true }), host));
  expect(host.querySelector(".devices-card-sign-in")?.textContent).toContain(
    "Joined by signing in with a Google account",
  );
  expect(host.querySelector(".devices-card-sign-in code")?.textContent).toBe(
    device.enrollment.signInId,
  );
});

/** Opens the device's menu, chooses Revoke device, and returns the dialog. */
async function openRevokeDialog() {
  const win = globalThis.window as unknown as { innerHeight: number; innerWidth: number };
  win.innerHeight = 800;
  win.innerWidth = 1200;
  await act(async () => render(h(DevicesView, {}), host));
  await vi.waitFor(() => expect(host.querySelector(".source-action-trigger")).not.toBeNull());
  const trigger = host.querySelector(".source-action-trigger") as HTMLElement;
  trigger.getBoundingClientRect = () => ({ top: 100, bottom: 120, right: 400 }) as DOMRect;
  await act(async () => (trigger as unknown as { click(): void }).click());
  const revoke = [...host.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes("Revoke device"),
  ) as HTMLElement;
  await act(async () => (revoke as unknown as { click(): void }).click());
  const dialog = host.querySelector(".confirm-modal") as HTMLElement;
  expect(dialog).not.toBeNull();
  return dialog;
}
const confirm = async (dialog: HTMLElement) => {
  const button = dialog.querySelector(".confirm-modal-actions .btn-primary") as HTMLElement;
  await act(async () => (button as unknown as { click(): void }).click());
};

test("revoking leaves the sign-in trusted unless the owner ticks the box", async () => {
  const dialog = await openRevokeDialog();
  const box = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(Boolean(box.checked)).toBe(false);
  expect(dialog.textContent).toContain("Also stop trusting the Google account it signed in with");
  await confirm(dialog);
  await vi.waitFor(() => expect(apiMocks.revokeDevice).toHaveBeenCalledTimes(1));
  expect(apiMocks.revokeDevice.mock.calls[0]![0]).toBe(device.id);
  expect(relayApi.stopTrustingSignIn).not.toHaveBeenCalled();
});

test("ticking the box stops trusting that sign-in after the device is revoked", async () => {
  const order: string[] = [];
  apiMocks.revokeDevice.mockImplementation(async () => order.push("revoke"));
  relayApi.stopTrustingSignIn.mockImplementation(async (id: string) => order.push(`stop ${id}`));
  const dialog = await openRevokeDialog();
  const box = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
  box.checked = true;
  await act(async () => {
    box.dispatchEvent(new window.Event("change"));
  });
  await confirm(dialog);
  await vi.waitFor(() => expect(order).toEqual(["revoke", `stop ${device.enrollment.signInId}`]));
});

test("a sign-in that cannot be removed says the device was still revoked", async () => {
  relayApi.stopTrustingSignIn.mockRejectedValue(new Error("Try again."));
  const dialog = await openRevokeDialog();
  const box = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
  box.checked = true;
  await act(async () => {
    box.dispatchEvent(new window.Event("change"));
  });
  await confirm(dialog);
  await vi.waitFor(() =>
    expect(host.textContent).toContain(
      "The device was revoked, but this gateway still trusts its Google account.",
    ),
  );
});

test("revoking a device paired with a code offers nothing about sign-ins", async () => {
  apiMocks.listDevices.mockResolvedValue({ items: [paired] });
  const dialog = await openRevokeDialog();
  expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
  await confirm(dialog);
  await vi.waitFor(() => expect(apiMocks.revokeDevice).toHaveBeenCalledTimes(1));
  expect(relayApi.stopTrustingSignIn).not.toHaveBeenCalled();
});
