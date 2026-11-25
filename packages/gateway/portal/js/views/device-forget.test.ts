// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getDeviceForgetImpact: vi.fn(),
  forgetDevice: vi.fn(),
}));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal is plain JS without sibling declarations.
import { DeviceForgetDialog } from "./device-forget.js";

let host: HTMLElement;
const device = { id: "fictional-phone", name: "Old phone" };
const impact = {
  fingerprint: "fictional-impact",
  sources: [
    { id: "photos:local", deleteScope: "partition" },
    { id: "apple-health:local", deleteScope: "none" },
  ],
};

beforeEach(() => {
  const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  api.getDeviceForgetImpact.mockReset().mockResolvedValue(impact);
  api.forgetDevice.mockReset().mockResolvedValue(true);
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });

async function open() {
  const onClose = vi.fn();
  const onForgotten = vi.fn();
  await act(async () => { render(h(DeviceForgetDialog, { device, onClose, onForgotten }), host); });
  await vi.waitFor(() => expect(host.textContent).toContain("Keep historical data"));
  return { onClose, onForgotten };
}
const confirm = () => host.querySelector(".confirm-modal-actions .btn-primary") as HTMLButtonElement;
async function clickConfirm() { await act(async () => confirm().click()); }

test("keeps history by default and sends the reviewed fingerprint", async () => {
  const { onForgotten } = await open();
  expect(host.querySelector('input[value="keep"]')?.hasAttribute("checked")).toBe(true);
  expect(host.textContent).toContain("shared or previously kept history stays");
  await clickConfirm();
  expect(api.forgetDevice).toHaveBeenCalledExactlyOnceWith(device.id, { data: "keep", impactFingerprint: impact.fingerprint });
  expect(onForgotten).toHaveBeenCalledOnce();
});

test("deleting requires a separate explicit destructive confirmation", async () => {
  await open();
  await act(async () => { (host.querySelector('input[value="delete"]') as HTMLInputElement).dispatchEvent(new window.Event("change", { bubbles: true })); });
  expect(confirm().textContent).toBe("Continue");
  await clickConfirm();
  expect(api.forgetDevice).not.toHaveBeenCalled();
  expect(host.textContent).toContain("This cannot be undone");
  expect(confirm().textContent).toBe("Forget and delete data");
  await clickConfirm();
  expect(api.forgetDevice).toHaveBeenCalledExactlyOnceWith(device.id, { data: "delete", impactFingerprint: impact.fingerprint });
});

test("cancel never changes the device", async () => {
  const { onClose } = await open();
  await act(async () => { (host.querySelector(".btn-ghost") as HTMLButtonElement).click(); });
  expect(onClose).toHaveBeenCalled();
  expect(api.forgetDevice).not.toHaveBeenCalled();
});

test("changed sources require a fresh review and reset the choice to keep", async () => {
  await open();
  api.forgetDevice.mockRejectedValueOnce({ code: "DEVICE_FORGET_IMPACT_CHANGED" });
  api.getDeviceForgetImpact.mockResolvedValueOnce({ ...impact, fingerprint: "new-impact" });
  await clickConfirm();
  await vi.waitFor(() => expect(api.getDeviceForgetImpact).toHaveBeenCalledTimes(2));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Review them again");
  expect(api.forgetDevice).toHaveBeenCalledTimes(1);
  await clickConfirm();
  expect(api.forgetDevice).toHaveBeenLastCalledWith(device.id, { data: "keep", impactFingerprint: "new-impact" });
});

test("impact failures allow retry without changing anything", async () => {
  api.getDeviceForgetImpact.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => { render(h(DeviceForgetDialog, { device, onClose: vi.fn(), onForgotten: vi.fn() }), host); });
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(api.forgetDevice).not.toHaveBeenCalled();
  await clickConfirm();
  await vi.waitFor(() => expect(host.textContent).toContain("Keep historical data"));
  expect(api.getDeviceForgetImpact).toHaveBeenCalledTimes(2);
});
