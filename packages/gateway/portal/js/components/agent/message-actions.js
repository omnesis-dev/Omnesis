// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** Context actions shared by transcript messages and the pending user bubble. */
export function MessageActions({ text, action, children }) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState("");
  const root = useRef(null);
  const menu = useRef(null);
  function close() {
    setPosition(null);
    root.current?.focus();
  }
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector("button")?.focus();
    const outside = (event) => {
      if (!menu.current?.contains(event.target)) setPosition(null);
    };
    const reflow = () => setPosition(null);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("resize", reflow);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", reflow, true);
      window.removeEventListener("resize", reflow);
    };
  }, [position]);
  function open(event) {
    if (event.target.closest?.("a, button, input, textarea, select")) return;
    event.preventDefault();
    const rect = root.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(event.clientX || rect.left, window.innerWidth - 208)),
      top: Math.max(8, Math.min(event.clientY || rect.bottom, window.innerHeight - 104)),
    });
  }
  async function copy() {
    close();
    try {
      await navigator.clipboard.writeText(text);
      setError("");
    } catch {
      setError("Could not copy. Select the message text and copy it manually.");
    }
  }
  return html`<div
    ref=${root}
    class="agent-message-actions"
    tabindex="0"
    aria-label="Message actions"
    aria-haspopup="menu"
    onContextMenu=${open}
    onKeyDown=${(event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event);
    }}
  >
    ${children}
    ${position
      ? html`<div
          ref=${menu}
          class="row-action-popover agent-message-menu"
          role="menu"
          style=${position}
          onKeyDown=${(event) => {
            const buttons = [...menu.current.querySelectorAll("button:not(:disabled)")];
            const index = buttons.indexOf(document.activeElement);
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              buttons[
                (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
              ]?.focus();
            }
            if (event.key === "Home") {
              event.preventDefault();
              buttons[0]?.focus();
            }
            if (event.key === "End") {
              event.preventDefault();
              buttons[buttons.length - 1]?.focus();
            }
            if (event.key === "Tab") setPosition(null);
          }}
        >
          <button type="button" class="row-action-item" role="menuitem" onClick=${copy}>
            Copy
          </button>
          ${action
            ? html`<button
                type="button"
                class="row-action-item"
                role="menuitem"
                disabled=${action.disabled}
                onClick=${() => {
                  close();
                  action.onSelect();
                }}
              >
                ${action.label}
              </button>`
            : null}
        </div>`
      : null}
    ${error ? html`<small role="status">${error}</small>` : null}
  </div>`;
}
