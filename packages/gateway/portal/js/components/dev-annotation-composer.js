// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The single developer-annotation composer, mounted once in the app shell
// (developer mode only). It opens when any trigger dispatches an open request
// via `openDevAnnotation(target)` (the floating ⚑ FAB, or a per-item ⚑ on the
// cognition page). The target is snapshotted when the composer opens, so it
// can't shift under the operator while they type. Notes are read back with
// `omnesis dev-annotations`, not by the Omnesis agent.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createDevAnnotation } from "../api.js";
import { devAnnotationContext, onDevAnnotateRequest } from "../lib/dev-annotate.js";

export function DevAnnotationComposer() {
  const [target, setTarget] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    return onDevAnnotateRequest((requested) => {
      if (!requested) return;
      setTarget(requested);
      setNote("");
      setError(null);
      setBusy(false);
    });
  }, []);

  useEffect(() => {
    if (!target) return undefined;
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  function close() {
    setTarget(null);
    setBusy(false);
  }

  async function submit(e) {
    if (e) e.preventDefault();
    const trimmed = note.trim();
    if (!trimmed || !target) return;
    setBusy(true);
    setError(null);
    try {
      await createDevAnnotation({
        targetType: target.targetType,
        targetId: target.targetId ?? null,
        note: trimmed,
        deepLink: target.deepLink ?? null,
        context: devAnnotationContext(target.label),
        client: "portal",
      });
      close();
    } catch (err) {
      setError(err?.message || "Failed to file annotation.");
      setBusy(false);
    }
  }

  if (!target) return null;

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dev-annotation-title"
      onClick=${close}
    >
      <div class="confirm-modal" onClick=${(ev) => ev.stopPropagation()}>
        <div id="dev-annotation-title" class="confirm-modal-title">Developer annotation</div>
        <div class="confirm-modal-body">
          <span class="dev-annotation-target">${target.label}</span>
        </div>
        <form onSubmit=${submit}>
          <textarea
            ref=${inputRef}
            class="dev-annotation-textarea"
            placeholder="What's wrong or inconsistent here?"
            value=${note}
            onInput=${(ev) => setNote(ev.target.value)}
            rows="4"
          ></textarea>
          ${error ? html`<div class="dev-annotation-error">${error}</div>` : null}
          <div class="confirm-modal-actions">
            <button type="button" class="btn-ghost" onClick=${close}>Cancel</button>
            <button type="submit" class="btn-primary" disabled=${busy || !note.trim()}>
              ${busy ? "Filing…" : "File note"}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}
