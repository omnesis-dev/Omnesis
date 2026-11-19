// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — browser JS components exercised in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions } from "./message-actions.js";

let host;
afterEach(() => {
  if (host) render(null, host);
  vi.unstubAllGlobals();
});

describe("message selection context menu", () => {
  it.each(["contextmenu", "ContextMenu", "Shift+F10"])(
    "preserves native selection actions for %s and full-message actions after clearing selection",
    async (trigger) => {
      const { document, window } = parseHTML("<html><body><main></main></body></html>");
      vi.stubGlobal("document", document);
      vi.stubGlobal("window", window);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const selection = { isCollapsed: false };
      window.getSelection = () => selection;
      window.innerWidth = 1024;
      window.innerHeight = 768;
      host = document.querySelector("main");
      await act(async () =>
        render(h(MessageActions, { text: "A complete answer" }, h("p", null, "A complete answer")), host),
      );
      const root = host.querySelector(".agent-message-actions");
      root.getBoundingClientRect = () => ({ left: 10, bottom: 40 });
      const dispatch = async () => {
        const event = new window.Event(trigger === "contextmenu" ? "contextmenu" : "keydown", {
          bubbles: true,
          cancelable: true,
        });
        event.key = trigger === "Shift+F10" ? "F10" : trigger;
        event.shiftKey = trigger === "Shift+F10";
        await act(async () => root.dispatchEvent(event));
        return event;
      };

      expect((await dispatch()).defaultPrevented).toBe(false);
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(writeText).not.toHaveBeenCalled();

      selection.isCollapsed = true;
      expect((await dispatch()).defaultPrevented).toBe(true);
      await act(async () => host.querySelector('[role="menuitem"]').click());
      expect(writeText).toHaveBeenCalledExactlyOnceWith("A complete answer");
    },
  );
});
