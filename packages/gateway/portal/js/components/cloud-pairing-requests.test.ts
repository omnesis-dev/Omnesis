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
vi.mock("../lib/cloud-pairing-api.js", () => api);
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { CloudPairingRequest, CloudPairingRequests } from "./cloud-pairing-requests.js";
/** Rendered text with HTML whitespace collapsed, as a browser shows it. */
const norm = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ");
let host: HTMLElement;
const request = {
  requestId: "00000000-0000-4000-8000-000000000001",
  name: "Fictional phone",
  kind: "ios",
  status: "pending",
  verificationCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
  expiresAt: Date.now() + 600_000,
};
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.cloudPairingConfig.mockReset();
  api.cloudPairingRequests.mockReset();
  api.decideCloudPairing.mockReset();
  api.decideCloudPairing.mockResolvedValue({ ok: true });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
async function show(
  value: typeof request & { signIn?: string; canTrustSignIn?: boolean } = request,
  onDecision = vi.fn(),
) {
  await act(async () => {
    render(h(CloudPairingRequest, { request: value, onDecision }), host);
  });
  return onDecision;
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  ) as HTMLButtonElement;
}
async function showRequests() {
  await act(async () => render(h(CloudPairingRequests, {}), host));
  await act(async () => {
    await Promise.resolve();
  });
}
const CARD_TEXT =
  "A device signed in to your Omnesis account and is waiting for your approval to pair to this gateway. Approve if the code below matches the code shown on the device.";
test("the card says one thing, shows the gateway's code as sent, and approves in one action", async () => {
  const refreshed = await show();
  // Name, kind, the one sentence, the code and the two actions. Nothing else.
  expect(
    [...(host.querySelector("article")?.children ?? [])].map((item) =>
      norm(item.textContent).trim(),
    ),
  ).toEqual(["Fictional phone", "iOS app", CARD_TEXT, request.verificationCode, "ApproveDeny"]);
  expect(host.querySelector(".cloud-pairing-code")?.textContent).toBe(request.verificationCode);
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect([...host.querySelectorAll("button")].map((item) => norm(item.textContent).trim())).toEqual([
    "Approve",
    "Deny",
  ]);
  await act(async () => button("Approve").click());
  expect(api.decideCloudPairing).toHaveBeenCalledExactlyOnceWith(
    request.requestId,
    true,
    undefined,
  );
  expect(refreshed).toHaveBeenCalledOnce();
});
test("the code is shown as the gateway sends it, whatever its length or grouping", async () => {
  for (const verificationCode of ["000 111", "ZZ", request.verificationCode]) {
    await show({ ...request, verificationCode });
    expect(host.querySelector(".cloud-pairing-code")?.textContent).toBe(verificationCode);
  }
});
test("the card reads the same for a collector", async () => {
  await show({ ...request, kind: "collector" });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe("Collector");
  expect(norm(host.textContent)).toContain(CARD_TEXT);
  expect(norm(host.textContent)).not.toContain("Approval lets");
});
test("can deny without comparison and shows refused or expired decisions without silently approving", async () => {
  await show();
  api.decideCloudPairing.mockRejectedValueOnce(new Error("Request expired"));
  await act(async () => button("Deny").click());
  expect(api.decideCloudPairing).toHaveBeenCalledWith(request.requestId, false, undefined);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Request expired");
  // A card left on screen past its time, or already answered, offers nothing.
  for (const gone of [
    { ...request, expiresAt: Date.now() - 1 },
    { ...request, status: "denied" },
    { ...request, status: "approved" },
  ]) {
    await show(gone);
    expect(host.querySelector("button, input, .cloud-pairing-code")).toBeNull();
  }
  // An approval still being written keeps its card, with nothing to press twice.
  await show({ ...request, status: "approving" });
  expect(button("Updating").disabled).toBe(true);
  expect(button("Deny").disabled).toBe(true);
});
test("a request leaves the section once it is approved, denied or out of time", async () => {
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  const row = (requestId: string, name: string, more: Record<string, unknown> = {}) => ({
    ...request,
    requestId,
    name,
    ...more,
  });
  api.cloudPairingRequests.mockResolvedValue({
    items: [
      row("00000000-0000-4000-8000-00000000000a", "Fictional tablet"),
      row("00000000-0000-4000-8000-00000000000b", "Fictional laptop", { status: "approved" }),
      row("00000000-0000-4000-8000-00000000000c", "Fictional desktop", { status: "denied" }),
      row("00000000-0000-4000-8000-00000000000d", "Fictional watch", { expiresAt: Date.now() - 1 }),
    ],
  });
  await showRequests();
  expect(
    [...host.querySelectorAll(".cloud-pairing-request h3")].map((item) => item.textContent),
  ).toEqual(["Fictional tablet"]);
  render(null, host);
  // Only answered requests left: the whole section goes.
  api.cloudPairingRequests.mockResolvedValue({
    items: [row("00000000-0000-4000-8000-00000000000b", "Fictional laptop", { status: "approved" })],
  });
  await showRequests();
  expect(host.textContent).toBe("");
});
test("optional configuration hides the surface, while configured requests show safely escaped names and codes", async () => {
  api.cloudPairingConfig.mockResolvedValue(null);
  await showRequests();
  expect(host.textContent).toBe("");
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client", webSignIn: false });
  api.cloudPairingRequests.mockResolvedValue({
    items: [{ ...request, name: "<script>fictional</script>" }],
  });
  await showRequests();
  expect(norm(host.textContent)).toContain("<script>fictional</script>");
  expect(host.querySelector("script")).toBeNull();
  expect(norm(host.textContent)).toContain(request.verificationCode);
});
test("empty, unavailable, and failed polling states stay actionable", async () => {
  api.cloudPairingConfig.mockRejectedValue(new Error("unavailable"));
  await showRequests();
  expect(host.textContent).toBe("");
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockRejectedValueOnce(new Error("Couldn't load requests"));
  await showRequests();
  expect(norm(host.textContent)).toContain("Couldn't load requests");
  render(null, host);
  api.cloudPairingRequests.mockResolvedValue({ items: [] });
  await showRequests();
  // Nothing waiting is the normal case: the section stays out of the way.
  expect(host.textContent).toBe("");
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  expect(api.cloudPairingRequests.mock.calls.length).toBeGreaterThan(1);
});

test("a request that expires after render cannot be approved from a stale button", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const row = { ...request, expiresAt: Date.now() + 1000 };
    await show(row);
    const approve = button("Approve");
    vi.setSystemTime(row.expiresAt + 1);
    await act(async () => approve.click());
    expect(api.decideCloudPairing).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a verified, untrusted sign-in can be trusted from now on, only when approving", async () => {
  const row = { ...request, signIn: "google", canTrustSignIn: true };
  await show(row);
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe("iOS app · Google");
  const trust = host.querySelector(".cloud-pairing-trust input") as HTMLInputElement;
  expect(norm(host.textContent)).toContain("Trust this sign-in from now on");
  expect(norm(host.textContent)).toContain(
    "Devices that sign in with this Google account can join without waiting",
  );
  await act(async () => {
    trust.checked = true;
    trust.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => button("Approve").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(request.requestId, true, true);
  api.decideCloudPairing.mockClear();
  render(null, host);
  await show({ ...row, requestId: "00000000-0000-4000-8000-000000000002" });
  await act(async () => button("Approve").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000002",
    true,
    false,
  );
  await show({ ...row, requestId: "00000000-0000-4000-8000-000000000003" });
  await act(async () => button("Deny").click());
  expect(api.decideCloudPairing).toHaveBeenLastCalledWith(
    "00000000-0000-4000-8000-000000000003",
    false,
    undefined,
  );
});
test("no trust choice for an unverified or already trusted sign-in, and passkeys are named", async () => {
  await show({ ...request, kind: "android", signIn: "passkey", canTrustSignIn: false });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe("Android app · Passkey");
  expect(host.querySelector(".cloud-pairing-trust")).toBeNull();
  await show({ ...request, kind: "portal", canTrustSignIn: true, signIn: "passkey" });
  expect(norm(host.textContent)).toContain("Portal · Passkey");
  expect(norm(host.textContent)).toContain("Devices that sign in with this passkey");
  // An unknown kind is shown as sent; an unknown status is not something to approve.
  await show({ ...request, kind: "watch", status: "mystery" });
  expect(host.querySelector(".devices-muted")?.textContent?.trim()).toBe("watch");
  expect(host.querySelector("button")).toBeNull();
});
