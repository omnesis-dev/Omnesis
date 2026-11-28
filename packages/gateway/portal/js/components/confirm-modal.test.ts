// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { ConfirmModal } from "./confirm-modal.js";
let host: HTMLElement;
let active: HTMLElement | null;
beforeEach(() => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("Event", window.Event);
  host = window.document.querySelector("main") as unknown as HTMLElement;
  active = null;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  vi.spyOn(window.HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
    active = this;
  });
});
afterEach(() => {
  render(null, host);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function key(value: string, shiftKey = false) {
  await act(async () => {
    const event = new window.Event("keydown", { cancelable: true });
    Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey } });
    window.dispatchEvent(event);
  });
}

test("model repair anchor participates in both ends of modal Tab trap while Cancel remains default", async () => {
  const body = h("div", {}, [
    h("a", { href: "/portal/settings/models/transcriber" }, "Choose transcription model"),
    h("a", { hidden: true, href: "/portal/settings/config" }, "Hidden repair"),
    h("button", { type: "button" }, "Check choices again"),
  ]);
  await act(async () =>
    render(
      h(ConfirmModal, {
        open: true,
        title: "Review existing work",
        body,
        confirmLabel: "Resume",
        onCancel: vi.fn(),
      }),
      host,
    ),
  );
  const anchor = host.querySelector<HTMLAnchorElement>("a:not([hidden])")!;
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  const cancel = buttons.find((b) => b.textContent?.trim() === "Cancel")!;
  const resume = buttons.find((b) => b.textContent?.trim() === "Resume")!;
  expect(active).toBe(cancel);
  // The browser traverses internal controls; the shared trap owns only its wrap boundaries.
  resume.focus();
  await key("Tab");
  expect(active).toBe(anchor);
  anchor.focus();
  await key("Tab", true);
  expect(active).toBe(resume);
});

test("Escape still cancels once without activating the destructive action", async () => {
  const cancel = vi.fn();
  const confirm = vi.fn();
  await act(async () =>
    render(
      h(ConfirmModal, {
        open: true,
        title: "Review",
        body: h("a", { href: "/portal/settings/models/transcriber" }, "Review model"),
        onCancel: cancel,
        onConfirm: confirm,
      }),
      host,
    ),
  );
  await key("Escape");
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});
