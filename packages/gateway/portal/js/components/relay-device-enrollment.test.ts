// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  deviceJoinedLabel,
  deviceSignIn,
  DeviceSignIn,
  StopTrustingSignIn,
  // @ts-expect-error — portal JavaScript has no sibling declarations.
} from "./relay-device-enrollment.js";

let host: HTMLElement;
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

test("how a device joined reads in plain words", () => {
  // Signing in is one way to join, whatever the sign-in method was.
  for (const signIn of ["google", "passkey", undefined])
    expect(deviceJoinedLabel({ method: "automatic", signIn })).toBe("Joined with Omnesis account");
  expect(deviceJoinedLabel({ method: "approved", signIn: "google" })).toBe("Approved");
  for (const value of [undefined, null, "automatic", { method: "unknown" }])
    expect(deviceJoinedLabel(value)).toBeNull();
});

test("the sign-in a device joined with is named only when it was recorded", () => {
  expect(deviceSignIn({ method: "automatic", signIn: "passkey", signInId: "pk-1" })).toEqual({
    type: "passkey",
    id: "pk-1",
    label: "passkey",
  });
  expect(deviceSignIn({ method: "approved", signIn: "google", signInId: "a".repeat(64) })).toEqual(
    { type: "google", id: "a".repeat(64), label: "Google account" },
  );
  for (const value of [
    undefined,
    null,
    "passkey",
    { method: "automatic", signIn: "passkey" },
    { method: "automatic", signIn: "passkey", signInId: "" },
    { method: "automatic", signIn: null, signInId: "pk-1" },
    { method: "automatic", signIn: "other", signInId: "pk-1" },
  ])
    expect(deviceSignIn(value)).toBeNull();
});

test("the device details show the sign-in and its id, and nothing without one", async () => {
  await act(async () => {
    render(
      h(DeviceSignIn, { enrollment: { method: "automatic", signIn: "passkey", signInId: "pk-1" } }),
      host,
    );
  });
  expect(host.textContent).toContain("Joined by signing in with a passkey");
  expect(host.querySelector("code")?.textContent).toBe("pk-1");
  await act(async () => {
    render(h(DeviceSignIn, { enrollment: { method: "automatic", signIn: "passkey" } }), host);
  });
  expect(host.textContent).toBe("");
});

test("the revoke dialog's sign-in choice starts unticked and records the owner's choice", async () => {
  const choice = { stopTrusting: false };
  await act(async () => {
    render(
      h(StopTrustingSignIn, {
        signIn: { type: "google", id: "g", label: "Google account" },
        choice,
      }),
      host,
    );
  });
  const box = host.querySelector("input") as HTMLInputElement;
  expect(Boolean(box.checked)).toBe(false);
  expect(host.textContent).toContain("Also stop trusting the Google account it signed in with");
  for (const checked of [true, false]) {
    box.checked = checked;
    box.dispatchEvent(new window.Event("change"));
    expect(choice.stopTrusting).toBe(checked);
  }
});
