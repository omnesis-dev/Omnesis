// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => router);
// @ts-expect-error — portal modules are plain JS.
import { WaitingDevicesBanner } from "./waiting-devices-banner.js";
// @ts-expect-error — portal modules are plain JS.
import { PendingRequests } from "../views/access/pending-requests.js";

let host: HTMLElement;
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  router.navigate.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

/** `useAttention().devices` with these waiting sign-in requests and Tailscale joins. */
const devices = (cloud: string[] = [], tailscale: string[] = []) => ({
  cloud: cloud.map((requestId) => ({ requestId })),
  tailscale: tailscale.map((id) => ({ id })),
  count: cloud.length + tailscale.length,
});
async function show(props: Record<string, unknown>) {
  await act(async () => render(h(WaitingDevicesBanner, props), host));
}
const strip = () => host.querySelector(".access-pending.cloud-pairing-notice");

test("nothing waiting: no strip", async () => {
  await show({ devices: devices() });
  expect(host.textContent).toBe("");
});

test("one waiting sign-in: one line and one action that opens that request", async () => {
  await show({ devices: devices(["a"]) });
  expect(strip()?.getAttribute("aria-label")).toBe("Devices waiting for approval");
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "A device is waiting for your approval to pair to this gateway.",
  );
  const action = host.querySelector("button") as HTMLButtonElement;
  expect(action.textContent?.trim()).toBe("Review");
  await act(async () => action.click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices?request=a");
});

test("several waiting devices share one strip with a count, which opens the list", async () => {
  await show({ devices: devices(["a"], ["t1"]) });
  expect(host.querySelectorAll(".access-pending-item")).toHaveLength(1);
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "2 devices are waiting for your approval to pair to this gateway.",
  );
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices");
});

test("a collector waiting to join through Tailscale opens the list", async () => {
  await show({ devices: devices([], ["t1"]) });
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices");
});

test("on the devices page the strip is off, and it comes back on leaving", async () => {
  await show({ devices: devices(["a"]), paused: true });
  expect(host.textContent).toBe("");
  await show({ devices: devices(["a"]), paused: false });
  expect(strip()).not.toBeNull();
});

test("it is the same strip an access request from an MCP client uses, and both can show together", async () => {
  await act(async () =>
    render(
      h("div", {}, [
        h(WaitingDevicesBanner, { devices: devices(["a"]) }),
        h(PendingRequests, {
          requests: [{ id: "approval-a", clientName: "Fictional client", expiresAt: Date.now() + 60_000 }],
        }),
      ]),
      host,
    ),
  );
  const strips = [...host.querySelectorAll("section.access-pending")];
  expect(strips).toHaveLength(2);
  for (const item of strips) {
    expect(item.querySelector("ul.access-pending-list > li.access-pending-item")).not.toBeNull();
    expect(item.querySelector("button.btn-primary.access-pending-review")).not.toBeNull();
  }
  expect(strips[1].querySelector("h3")?.textContent).toBe("1 access request waiting");
  expect(strips[1].querySelector("button")?.textContent?.trim()).toBe("Configure & Approve");
});
