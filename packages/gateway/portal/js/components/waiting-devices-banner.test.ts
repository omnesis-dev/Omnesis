// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  cloudPairingConfig: vi.fn(),
  cloudPairingRequests: vi.fn(),
  decideCloudPairing: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
const tailscale = vi.hoisted(() => ({ tailscaleJoinRequests: vi.fn() }));
vi.mock("../lib/cloud-pairing-api.js", () => api);
vi.mock("../lib/tailscale-api.js", () => tailscale);
vi.mock("../lib/router.js", () => router);
// @ts-expect-error — portal modules are plain JS.
import { WaitingDevicesBanner } from "./waiting-devices-banner.js";
// @ts-expect-error — portal modules are plain JS.
import { useWaitingDevices, waitingDevicesText } from "../lib/use-waiting-devices.js";
// @ts-expect-error — portal modules are plain JS.
import { waitingCloudPairingRequests } from "../lib/cloud-pairing-waiting.js";
// @ts-expect-error — portal modules are plain JS.
import { PendingRequests } from "../views/access/pending-requests.js";

let host: HTMLElement;
const request = (requestId: string, more: Record<string, unknown> = {}) => ({
  requestId,
  name: "Fictional phone",
  kind: "ios",
  status: "pending",
  verificationCode: "000 111",
  expiresAt: Date.now() + 600_000,
  ...more,
});
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.cloudPairingConfig.mockReset();
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockReset();
  api.cloudPairingRequests.mockResolvedValue({ items: [] });
  router.navigate.mockReset();
  tailscale.tailscaleJoinRequests.mockReset();
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
/** Lets the configuration read, then the first request reads, settle. */
async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
/** The strip as the portal shell mounts it: the shared answer, read with the gateway's features. */
function Shell({ cloudRelay = true, tailscaleEmbed = false, paused = false }: Record<string, boolean>) {
  return h(WaitingDevicesBanner, { waiting: useWaitingDevices({ cloudRelay, tailscaleEmbed }), paused });
}
async function show(props: Record<string, unknown> = {}) {
  await act(async () => render(h(Shell, props), host));
  await settle();
}
/** What a tab coming back into view does: the poll reads again at once. */
async function readAgain() {
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await settle();
}
const strip = () => host.querySelector(".access-pending.cloud-pairing-notice");

test("only requests a person can still answer count as waiting", () => {
  const now = 1_000;
  const row = (status: string, expiresAt = now + 1) => ({ status, expiresAt });
  expect(
    waitingCloudPairingRequests(
      [
        row("pending"),
        row("approving"),
        row("approved"),
        row("denied"),
        row("pending", now),
        row("mystery"),
      ],
      now,
    ),
  ).toEqual([row("pending"), row("approving")]);
  expect(waitingCloudPairingRequests(undefined, now)).toEqual([]);
});

test("nothing waiting, or sign-in pairing not offered: no strip", async () => {
  await show();
  expect(host.textContent).toBe("");
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue(null);
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show();
  expect(host.textContent).toBe("");
  expect(api.cloudPairingRequests).toHaveBeenCalledTimes(1);
});

test("a gateway that cannot say whether sign-in pairing is on shows nothing, and leaving early is safe", async () => {
  api.cloudPairingConfig.mockRejectedValueOnce(new Error("unavailable"));
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show();
  expect(host.textContent).toBe("");
  expect(api.cloudPairingRequests).not.toHaveBeenCalled();
  // The answer arrives after the page is gone.
  let deliver!: (value: unknown) => void;
  api.cloudPairingConfig.mockReturnValueOnce(
    new Promise((resolve) => {
      deliver = resolve;
    }),
  );
  await show();
  render(null, host);
  deliver({ clientId: "fictional-client" });
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.cloudPairingRequests).not.toHaveBeenCalled();
});

test("one waiting device: one line and one action that opens that request", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show();
  expect(strip()?.getAttribute("aria-label")).toBe("Devices waiting for approval");
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "A device is waiting for your approval to pair to this gateway.",
  );
  const action = host.querySelector("button") as HTMLButtonElement;
  expect(action.textContent?.trim()).toBe("Review");
  await act(async () => action.click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices?request=a");
});

test("several waiting devices share one strip with a count, and answered ones are not counted", async () => {
  api.cloudPairingRequests.mockResolvedValue({
    items: [
      request("a"),
      request("b"),
      request("c", { status: "approved" }),
      request("d", { status: "denied" }),
      request("e", { expiresAt: Date.now() - 1 }),
    ],
  });
  await show();
  expect(host.querySelectorAll(".access-pending-item")).toHaveLength(1);
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "2 devices are waiting for your approval to pair to this gateway.",
  );
  expect(waitingDevicesText(3)).toBe(
    "3 devices are waiting for your approval to pair to this gateway.",
  );
  // Several open the list, where each one is answered.
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices");
});

test("the strip goes once nothing waits, and a failed read keeps the last answer", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show();
  expect(strip()).not.toBeNull();
  api.cloudPairingRequests.mockRejectedValueOnce(new Error("offline"));
  await readAgain();
  expect(strip()).not.toBeNull();
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a", { status: "approved" })] });
  await readAgain();
  expect(strip()).toBeNull();
});

test("on the devices page the strip is off, while the count stays current for the marks", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show({ paused: true });
  expect(host.textContent).toBe("");
  expect(api.cloudPairingRequests).toHaveBeenCalled();
  // Leaving the devices page shows the strip from the answer already read.
  await show({ paused: false });
  expect(strip()).not.toBeNull();
});

test("it is the same strip an access request from an MCP client uses, and both can show together", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await act(async () =>
    render(
      h("div", {}, [
        h(Shell, { cloudRelay: true }),
        h(PendingRequests, {
          requests: [{ id: "approval-a", clientName: "Fictional client", expiresAt: Date.now() + 60_000 }],
        }),
      ]),
      host,
    ),
  );
  await vi.waitFor(() => expect(host.querySelectorAll("section.access-pending")).toHaveLength(2));
  const strips = [...host.querySelectorAll("section.access-pending")];
  for (const item of strips) {
    expect(item.querySelector("ul.access-pending-list > li.access-pending-item")).not.toBeNull();
    expect(item.querySelector("button.btn-primary.access-pending-review")).not.toBeNull();
  }
  expect(strips[1].querySelector("h3")?.textContent).toBe("1 access request waiting");
  expect(strips[1].querySelector("button")?.textContent?.trim()).toBe("Configure & Approve");
});

const join = (id: string, expiresIn = 600_000) => ({
  id,
  name: "studio-laptop",
  kind: "collector",
  machine: "studio-laptop",
  login: "maya@example.com",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + expiresIn).toISOString(),
});

test("without the Tailscale feature the gateway is never asked for join requests", async () => {
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
  await show();
  expect(host.textContent).toBe("");
  expect(tailscale.tailscaleJoinRequests).not.toHaveBeenCalled();
});

test("with neither feature nothing is asked and nothing shows", async () => {
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show({ cloudRelay: false });
  expect(host.textContent).toBe("");
  expect(api.cloudPairingConfig).not.toHaveBeenCalled();
  expect(api.cloudPairingRequests).not.toHaveBeenCalled();
  expect(tailscale.tailscaleJoinRequests).not.toHaveBeenCalled();
});

test("a request made while the page is open shows on the next read, with no reload", async () => {
  await show({ tailscaleEmbed: true });
  expect(strip()).toBeNull();
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
  await readAgain();
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "A device is waiting for your approval to pair to this gateway.",
  );
});

test("a collector waiting to join through Tailscale shows the same strip and opens the list", async () => {
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1"), join("t2", -1)] });
  await show({ cloudRelay: false, tailscaleEmbed: true });
  expect(api.cloudPairingConfig).not.toHaveBeenCalled();
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "A device is waiting for your approval to pair to this gateway.",
  );
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices");
});

test("both kinds count together in one strip, which opens the list", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
  await show({ tailscaleEmbed: true });
  expect(host.querySelectorAll(".access-pending-item")).toHaveLength(1);
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "2 devices are waiting for your approval to pair to this gateway.",
  );
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices");
});
