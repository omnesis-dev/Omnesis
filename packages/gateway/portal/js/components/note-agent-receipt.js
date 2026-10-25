// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The compact receipt line under a Tell Omnesis note: what the note agent
// did with it. Each task change carries Undo; an undone change stays
// listed, struck through, and the gateway's receipt for the undo shows in
// a toast.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { undoTask } from "../api.js";
import { navigate } from "../lib/router.js";
import { noteAgentDisplay, noteChangeHref, noteUndoErrorMessage } from "../lib/note-agent.js";

const TOAST_MS = 6000;

export function NoteAgentReceipt({ agent }) {
  const display = noteAgentDisplay(agent);
  const [undone, setUndone] = useState(() => new Set());
  const [busySeq, setBusySeq] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!display) return null;

  async function undo(seq) {
    if (busySeq !== null) return;
    setBusySeq(seq);
    setError(null);
    try {
      const result = await undoTask(seq);
      setUndone((current) => new Set(current).add(seq));
      clearTimeout(timer.current);
      setToast(result?.receipt?.text || "Undone");
      timer.current = setTimeout(() => setToast(null), TOAST_MS);
    } catch (err) {
      setError(noteUndoErrorMessage(err));
    } finally {
      setBusySeq(null);
    }
  }

  if (display.kind !== "receipt") {
    return html`<div class=${`note-agent note-agent-${display.kind}`} role="status">
      ${display.kind === "reading" && html`<span class="note-agent-dot" aria-hidden="true"></span>`}
      <span>${display.text}</span>
    </div>`;
  }
  return html`<div class="note-agent note-agent-receipt">
    ${display.text && html`<p class="note-agent-text">${display.text}</p>`}
    ${display.changes.length > 0 && html`<ul class="note-agent-changes">
      ${display.changes.map((change, index) => {
        const href = noteChangeHref(change);
        const isUndone = change.undoSeq != null && undone.has(change.undoSeq);
        return html`<li key=${change.undoSeq ?? `${index}:${change.text}`} class=${`note-agent-change${isUndone ? " undone" : ""}`}>
          ${href
            ? html`<a
                href=${href}
                title="Open Tasks"
                onClick=${(e) => {
                  if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  navigate(href);
                }}
              >${change.text}</a>`
            : html`<span>${change.text}</span>`}
          ${isUndone
            ? html`<span class="note-agent-undone">Undone</span>`
            : change.undoSeq != null &&
              html`<button
                type="button"
                class="btn-tiny note-agent-undo"
                aria-label=${`Undo: ${change.text}`}
                disabled=${busySeq !== null}
                onClick=${() => undo(change.undoSeq)}
              >${busySeq === change.undoSeq ? "Undoing…" : "Undo"}</button>`}
        </li>`;
      })}
    </ul>`}
    ${error && html`<div class="note-agent-error" role="alert">${error}</div>`}
    ${toast && html`<div class="toast" role="status" aria-live="polite">${toast}</div>`}
  </div>`;
}
