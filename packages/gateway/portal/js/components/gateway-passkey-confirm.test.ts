// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  GatewayPasskeyConfirm,
  passkeyConfirmationNeeded,
  // @ts-expect-error portal JS
} from "./gateway-passkey-confirm.js";
// @ts-expect-error portal JS
import { GatewayPasskeyError } from "../lib/gateway-passkey.js";

const ORIGIN = "https://g-abcdefgh.relay.example.test";
const enrollment = {
  policy: "automatic",
  trustedSignIns: [],
  confirmedSignIns: [],
  confirmOrigin: ORIGIN,
};
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const button = () => host.querySelector("button") as HTMLButtonElement | null;
async function show(props: Record<string, unknown>) {
  await act(async () =>
    render(
      h(GatewayPasskeyConfirm, {
        enrollment,
        busy: "",
        location: { origin: ORIGIN },
        supported: true,
        ...props,
      }),
      host,
    ),
  );
}
/** Clicks and lets the request, the prompt and the reply settle. */
async function click() {
  await act(async () => {
    button()!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("a passkey still needs confirming only where the gateway has an origin of its own", () => {
  expect(passkeyConfirmationNeeded(enrollment)).toBe(true);
  expect(passkeyConfirmationNeeded({ ...enrollment, confirmOrigin: undefined })).toBe(false);
  expect(passkeyConfirmationNeeded({ ...enrollment, confirmedSignIns: undefined })).toBe(true);
  expect(
    passkeyConfirmationNeeded({
      ...enrollment,
      confirmedSignIns: [{ type: "google", id: "g", at: 1, via: "native-google-approval" }],
    }),
  ).toBe(true);
  expect(
    passkeyConfirmationNeeded({
      ...enrollment,
      confirmedSignIns: [{ type: "passkey", id: "p", at: 1, via: "gateway-origin" }],
    }),
  ).toBe(false);
  expect(passkeyConfirmationNeeded(undefined)).toBe(false);
});

test("confirming asks the gateway for a challenge, prompts, then sends the assertion back", async () => {
  const ceremony = { origin: ORIGIN };
  const proof = { type: "gateway-passkey" };
  const request = vi.fn().mockResolvedValue(ceremony);
  const prove = vi.fn().mockResolvedValue(proof);
  const run = vi.fn().mockResolvedValue({ revision: 2 });
  await show({ request, prove, run });
  expect(text()).toContain("Confirm your passkey on this gateway");
  expect(button()!.textContent).toBe("Confirm with passkey");
  await click();
  expect(request).toHaveBeenCalledExactlyOnceWith("passkeys/confirm/options", {});
  expect(prove).toHaveBeenCalledExactlyOnceWith(ceremony, { location: { origin: ORIGIN } });
  expect(run).toHaveBeenCalledExactlyOnceWith("passkeys/confirm", { proof });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  // While the prompt is open the button says so and can't be pressed again.
  let answer!: (value: unknown) => void;
  prove.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  await click();
  expect(button()!.textContent).toBe("Waiting for your passkey…");
  expect(button()!.disabled).toBe(true);
  await act(async () => answer(proof));
  // A refusal is said in place.
  run.mockResolvedValueOnce(undefined);
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Use the passkey of the Omnesis account this gateway is linked to.",
  );
});

test("a prompt problem, a refused request and anything else each say what to do", async () => {
  const run = vi.fn();
  await show({
    run,
    request: vi.fn().mockResolvedValue({}),
    prove: vi.fn().mockRejectedValue(new GatewayPasskeyError("Prompt closed.")),
  });
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Prompt closed.");
  await show({
    run,
    request: vi.fn().mockRejectedValue(Object.assign(new Error(), { code: "passkey-origin-unavailable" })),
  });
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("no address of its own");
  await show({ run, request: vi.fn().mockRejectedValue(new Error("offline")) });
  await click();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't start the passkey check. Try again.",
  );
  expect(run).not.toHaveBeenCalled();
});

test("elsewhere it links to the gateway's own page, and without passkeys it says so", async () => {
  await show({ location: { origin: "https://192.0.2.1:7600" } });
  expect(button()).toBeNull();
  expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
    "/portal/settings/devices",
    `${ORIGIN}/portal/settings/account`,
  ]);
  await show({ supported: false });
  expect(button()).toBeNull();
  expect(text()).toContain("This browser can't use passkeys.");
  // Another change in progress holds the button; a refresh does not.
  await show({ busy: "enrollment" });
  expect(button()!.disabled).toBe(true);
  await show({ busy: "refresh" });
  expect(button()!.disabled).toBe(false);
});
