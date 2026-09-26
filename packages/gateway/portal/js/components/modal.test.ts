// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { Modal } from "./modal.js";

// linkedom has no focus model: `focus()` is a no-op and `activeElement` is
// undefined. Record which element focus reached and serve it back where the
// component looks for it.
function trackFocus(window: Window, document: Document): () => void {
  const proto = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
    .HTMLElement.prototype;
  const original = proto.focus;
  let active: Element | null = null;
  proto.focus = function focus(this: Element) { active = this; };
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  return () => { proto.focus = original; };
}

describe("Modal", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let restoreFocus: () => void;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML(
      "<html><body><main id='root'></main><button id='opener'>Open</button></body></html>",
    );
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    restoreFocus = trackFocus(parsed.window as unknown as Window, parsed.document as unknown as Document);
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    restoreFocus();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  function body() {
    return [
      h("input", { class: "first-field" }),
      h("button", { class: "second-control" }, "Save"),
    ];
  }

  test("leaves Escape and Tab to a confirmation above the panel", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(h(Modal, { open: true, title: "Add backend", onClose }, body()), host);
    });
    const confirmation = document.createElement("div");
    confirmation.className = "confirm-modal-backdrop";
    document.body.appendChild(confirmation);
    try {
      const escape = new window.Event("keydown", { bubbles: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      window.dispatchEvent(escape);
      const tab = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.defineProperty(tab, "key", { value: "Tab" });
      window.dispatchEvent(tab);
      expect(onClose).not.toHaveBeenCalled();
      expect(tab.defaultPrevented).toBe(false);
    } finally { confirmation.remove(); }
  });

  test("opens on the first control in the body, not on the ✕ that closes it", async () => {
    await act(async () => {
      render(h(Modal, { open: true, title: "Connect an agent", onClose: () => {} }, body()), host);
    });

    expect(document.activeElement).toBe(host.querySelector(".first-field"));
    expect(document.activeElement).not.toBe(host.querySelector(".modal-close"));
  });

  test("falls back to the panel when the body has nothing to focus", async () => {
    await act(async () => {
      render(h(Modal, { open: true, title: "Notice", onClose: () => {} }, h("p", null, "Nothing to do")), host);
    });

    expect(document.activeElement).toBe(host.querySelector(".modal-panel"));
  });

  test("hands focus back to whatever opened it", async () => {
    const opener = document.querySelector("#opener") as HTMLElement;
    opener.focus();

    await act(async () => {
      render(h(Modal, { open: true, title: "Connect an agent", onClose: () => {} }, body()), host);
    });
    expect(document.activeElement).toBe(host.querySelector(".first-field"));

    await act(async () => {
      render(h(Modal, { open: false, title: "Connect an agent", onClose: () => {} }, body()), host);
    });
    expect(document.activeElement).toBe(opener);
  });

  test("leaves focus alone when the element that opened it is gone", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    await act(async () => {
      render(h(Modal, { open: true, title: "Connect an agent", onClose: () => {} }, body()), host);
    });
    const inside = host.querySelector(".first-field");
    opener.remove();

    await act(async () => { render(null, host); });

    expect(document.activeElement).toBe(inside);
  });

  test("closes on Escape and keeps Tab inside the panel", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(h(Modal, { open: true, title: "Connect an agent", onClose }, body()), host);
    });

    const key = (init: Record<string, unknown>) => {
      const event = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, init);
      window.dispatchEvent(event);
      return event;
    };

    // Tab off the last control wraps to the first rather than escaping to the
    // page behind the overlay.
    const controls = [...host.querySelectorAll(".modal-panel button, .modal-panel input")];
    const last = controls[controls.length - 1] as HTMLElement;
    last.focus();
    await act(async () => { key({ key: "Tab", shiftKey: false }); });
    expect(document.activeElement).toBe(controls[0]);

    await act(async () => { key({ key: "Escape" }); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
