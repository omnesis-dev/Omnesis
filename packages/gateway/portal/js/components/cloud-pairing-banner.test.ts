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
vi.mock("../lib/cloud-pairing-api.js", () => api);
vi.mock("../lib/router.js", () => router);
// @ts-expect-error — portal modules are plain JS.
import { CloudPairingBanner, cloudPairingBannerText } from "./cloud-pairing-banner.js";
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
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
async function show(props: Record<string, unknown> = {}) {
  await act(async () => render(h(CloudPairingBanner, props), host));
  await act(async () => {
    await Promise.resolve();
  });
}
/** What a tab coming back into view does: the poll reads again at once. */
async function readAgain() {
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await act(async () => {
    await Promise.resolve();
  });
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

test("one waiting device: one line and one action that opens the devices page", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show();
  expect(strip()?.getAttribute("aria-label")).toBe("Devices waiting for approval");
  expect(host.querySelector(".access-pending-client")?.textContent).toBe(
    "A device is waiting for your approval to pair to this gateway.",
  );
  const action = host.querySelector("button") as HTMLButtonElement;
  expect(action.textContent?.trim()).toBe("Review");
  await act(async () => action.click());
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/portal/settings/devices");
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
  expect(cloudPairingBannerText(3)).toBe(
    "3 devices are waiting for your approval to pair to this gateway.",
  );
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

test("on the devices page the strip is off and does not ask the gateway", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await show({ paused: true });
  expect(host.textContent).toBe("");
  expect(api.cloudPairingRequests).not.toHaveBeenCalled();
  // Leaving the devices page reads at once.
  await show({ paused: false });
  expect(strip()).not.toBeNull();
});

test("it is the same strip an access request from an MCP client uses, and both can show together", async () => {
  api.cloudPairingRequests.mockResolvedValue({ items: [request("a")] });
  await act(async () =>
    render(
      h("div", {}, [
        h(CloudPairingBanner, {}),
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
