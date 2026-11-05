// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ cloudPairingConfig: vi.fn(), cloudPairingRequests: vi.fn(), decideCloudPairing: vi.fn() }));
vi.mock("../lib/cloud-pairing-api.js", () => api);
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { CloudPairingRequest, CloudPairingRequests } from "./cloud-pairing-requests.js";
let host: HTMLElement;
const request = { requestId: "00000000-0000-4000-8000-000000000001", name: "Fictional phone", kind: "ios",
  status: "pending", verificationCode: "AAAA-BBBB-CCCC-DDDD-EEEE", expiresAt: Date.now() + 600_000 };
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document); vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.cloudPairingConfig.mockReset(); api.cloudPairingRequests.mockReset(); api.decideCloudPairing.mockReset();
  api.decideCloudPairing.mockResolvedValue({ ok: true });
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });
async function show(value = request, onDecision = vi.fn()) {
  await act(async () => { render(h(CloudPairingRequest, { request: value, onDecision }), host); });
  return onDecision;
}
function button(label: string) { return [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label)) as HTMLButtonElement; }
async function compare() {
  await act(async () => {
    const input = host.querySelector("input") as HTMLInputElement;
    input.checked = true; input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function showRequests() {
  await act(async () => render(h(CloudPairingRequests, {}), host));
  await act(async () => { await Promise.resolve(); });
}
test("requires an explicit trusted-device code comparison before approval", async () => {
  const refreshed = await show();
  expect(host.textContent).toContain(request.verificationCode);
  expect(host.textContent).toContain("Google sign-in alone does not grant access");
  expect(button("Approve").disabled).toBe(true);
  await act(async () => button("Approve").click());
  expect(api.decideCloudPairing).not.toHaveBeenCalled();
  await compare(); expect(button("Approve").disabled).toBe(false);
  await act(async () => button("Approve").click());
  expect(api.decideCloudPairing).toHaveBeenCalledExactlyOnceWith(request.requestId, true);
  expect(refreshed).toHaveBeenCalledOnce();
});
test("owner approval explains administrative access and distinguishes collector read/upload permissions", async () => {
  await show();
  expect(host.textContent).toContain("read your data and manage gateway settings");
  await show({ ...request, kind: "collector" });
  expect(host.textContent).toContain("read your data and upload documents");
  expect(host.textContent).not.toContain("manage gateway settings");
  expect(button("Approve").disabled).toBe(true);
});
test("can deny without comparison and shows refused or expired decisions without silently approving", async () => {
  await show();
  api.decideCloudPairing.mockRejectedValueOnce(new Error("Request expired"));
  await act(async () => button("Deny").click());
  expect(api.decideCloudPairing).toHaveBeenCalledWith(request.requestId, false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Request expired");
  await show({ ...request, expiresAt: Date.now() - 1 });
  expect(host.textContent).toContain("Expired"); expect(host.querySelector("button")).toBeNull();
  await show({ ...request, status: "denied" });
  expect(host.textContent).toContain("denied"); expect(host.querySelector("input")).toBeNull();
});
test("optional configuration hides the surface, while configured requests show safely escaped names and codes", async () => {
  api.cloudPairingConfig.mockResolvedValue(null);
  await showRequests();
  expect(host.textContent).toBe("");
  render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client", webSignIn: false });
  api.cloudPairingRequests.mockResolvedValue({ items: [{ ...request, name: "<script>fictional</script>" }] });
  await showRequests();
  expect(host.textContent).toContain("<script>fictional</script>");
  expect(host.querySelector("script")).toBeNull();
  expect(host.textContent).toContain(request.verificationCode);
});
test("empty, unavailable, and failed polling states stay actionable", async () => {
  api.cloudPairingConfig.mockRejectedValue(new Error("unavailable"));
  await showRequests();
  expect(host.textContent).toBe(""); render(null, host);
  api.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  api.cloudPairingRequests.mockRejectedValueOnce(new Error("Couldn't load requests"));
  await showRequests();
  expect(host.textContent).toContain("Couldn't load requests"); render(null, host);
  api.cloudPairingRequests.mockResolvedValue({ items: [] });
  await showRequests();
  expect(host.textContent).toContain("No device pairing requests");
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
  expect(api.cloudPairingRequests.mock.calls.length).toBeGreaterThan(1);
});
