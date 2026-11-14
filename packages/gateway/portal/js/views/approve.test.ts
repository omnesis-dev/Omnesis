// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error portal JS
import { ApproveView, approvalRequestId } from "./approve.js";
// @ts-expect-error portal JS
import { GatewayPasskeyError } from "../lib/gateway-passkey.js";

const REQUEST = "11111111-2222-4333-8444-555555555555";
const held = {
  requestId: REQUEST,
  kind: "cli",
  name: "Fictional laptop",
  verificationCode: "123 456",
  createdAt: Date.UTC(2028, 0, 1, 9, 30),
  expiresAt: Date.UTC(2028, 0, 1, 9, 40),
  signIn: "passkey",
  deviceKeyRequired: false,
};
let host: HTMLElement;
const transport = vi.fn();
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("fetch", transport);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  transport.mockReset();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = () => host.querySelector("button") as HTMLButtonElement | null;
async function show(props: Record<string, unknown>) {
  await act(async () => render(h(ApproveView, props), host));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function click() {
  await act(async () => {
    button()!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("the link names the request in its fragment, and anything else names none", () => {
  expect(approvalRequestId({ hash: `#${REQUEST}` })).toBe(REQUEST);
  for (const hash of ["", "#", "#not-a-request", `#${REQUEST}x`]) expect(approvalRequestId({ hash })).toBeNull();
  expect(approvalRequestId(undefined)).toBeNull();
});

test("the page shows the request and approves it with a passkey", async () => {
  transport.mockResolvedValue(new Response(JSON.stringify(held)));
  const approve = vi.fn().mockResolvedValue(undefined);
  await show({ requestId: REQUEST, approve });
  expect(transport.mock.calls[0]![0]).toBe(`/devices/account/approval/${REQUEST}`);
  expect(text()).toContain("Approve a new device");
  expect(text()).toContain("Fictional laptop (CLI) asked to join this gateway at");
  expect(host.querySelector(".cloud-pairing-code")?.textContent).toBe("123 456");
  expect(text()).toContain("Anyone who sent you this link could be asking for their own device.");
  await click();
  expect(approve).toHaveBeenCalledExactlyOnceWith({ requestId: REQUEST });
  expect(text()).toContain("Approved. Fictional laptop can finish joining now.");
});

test("a device the owner revoked is named as such before the code", async () => {
  transport.mockResolvedValue(new Response(JSON.stringify({ ...held, revokedDevice: true })));
  await show({ requestId: REQUEST, approve: vi.fn() });
  const note = host.querySelector(".cloud-pairing-revoked");
  expect(note?.textContent).toContain("You revoked this device earlier.");
  expect(note?.nextElementSibling?.className).toBe("cloud-pairing-code");
});

test("while the prompt is open it can't be pressed again, and a refusal is said in place", async () => {
  transport.mockResolvedValue(new Response(JSON.stringify({ ...held, kind: "unknown-kind" })));
  let refuse!: (error: Error) => void;
  const approve = vi.fn().mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
  await show({ requestId: REQUEST, approve });
  expect(text()).toContain("(unknown-kind)");
  await click();
  expect(button()!.textContent?.trim()).toBe("Waiting for your passkey…");
  expect(button()!.disabled).toBe(true);
  await act(async () => refuse(new GatewayPasskeyError("Use a passkey you confirmed here.")));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Use a passkey you confirmed here.");
  approve.mockRejectedValueOnce(new Error("network"));
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't approve. Try again.");
});

test("a browser's request is approved only with that browser's own device key", async () => {
  transport.mockImplementation(
    async () => new Response(JSON.stringify({ ...held, kind: "portal", deviceKeyRequired: true })),
  );
  const approve = vi.fn().mockResolvedValue(undefined);
  const key = { privateKey: "fictional-key" };
  await show({ requestId: REQUEST, approve, deviceKey: vi.fn().mockResolvedValue(null) });
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Open this link in the browser that asked to join.",
  );
  expect(approve).not.toHaveBeenCalled();
  render(null, host);
  await show({ requestId: REQUEST, approve, deviceKey: vi.fn().mockResolvedValue(key) });
  await click();
  expect(approve).toHaveBeenCalledExactlyOnceWith({ requestId: REQUEST, deviceKey: "fictional-key" });
});

test("no request, one that is gone, or an unreachable gateway shows that nothing is waiting", async () => {
  await show({ requestId: null });
  expect(transport).not.toHaveBeenCalled();
  expect(text()).toContain("Nothing is waiting for approval at this link.");
  for (const outcome of [
    () => transport.mockResolvedValueOnce(new Response("{}", { status: 404 })),
    () => transport.mockRejectedValueOnce(new Error("offline")),
  ]) {
    render(null, host);
    outcome();
    await show({ requestId: REQUEST });
    expect(text()).toContain("Nothing is waiting for approval at this link.");
  }
  // Leaving before the gateway answers changes nothing.
  render(null, host);
  let answer!: (value: Response) => void;
  let fail!: (error: Error) => void;
  transport.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  await act(async () => render(h(ApproveView, { requestId: REQUEST }), host));
  expect(text()).toContain("Loading the request");
  render(null, host);
  await act(async () => answer(new Response(JSON.stringify(held))));
  transport.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  await act(async () => render(h(ApproveView, { requestId: REQUEST }), host));
  render(null, host);
  await act(async () => fail(new Error("offline")));
  expect(host.textContent).toBe("");
});
