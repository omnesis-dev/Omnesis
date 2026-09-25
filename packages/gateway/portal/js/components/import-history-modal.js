// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Modal that drives a source's one-time history import (#588) from the portal.
// The portal is just another execution engine for the generic `historyImport`
// descriptor capability — the same one the CLI's `sources import-history`
// command consumes. This component knows nothing source-specific: it renders a
// form from `spec.fields`, POSTs the collected values, and streams progress
// from the import SSE endpoint, exactly like the CLI does.
//
// Note on field types: `file`/`directory` are *server-side paths* on the
// machine running the collector (the import reads the artifact off that
// filesystem), so they render as text inputs — not a browser file upload.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { startSourceHistoryImport, cancelSourceHistoryImport } from "../api.js";

function FieldInput({ field, value, onInput }) {
  if (field.type === "select") {
    return html`
      <select value=${value} onChange=${(e) => onInput(e.target.value)}>
        <option value="" disabled selected=${!value}>Choose…</option>
        ${(field.options || []).map(
          (o) => html`<option value=${o.value} selected=${o.value === value}>${o.label}</option>`,
        )}
      </select>
    `;
  }
  const type = field.type === "secret" ? "password" : "text";
  return html`
    <input
      type=${type}
      value=${value}
      placeholder=${field.help || ""}
      autocomplete=${field.type === "secret" ? "off" : undefined}
      onInput=${(e) => onInput(e.target.value)}
    />
  `;
}

export function ImportHistoryModal({ sourceId, spec, onClose, onComplete }) {
  // phase: "form" → "running" → "done" | "error"
  const [phase, setPhase] = useState("form");
  const [values, setValues] = useState(() =>
    Object.fromEntries((spec.fields || []).map((f) => [f.key, ""])),
  );
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const esRef = useRef(null);
  const flowRef = useRef(null);
  const doneRef = useRef(false);

  // Tear down the event stream on unmount.
  useEffect(() => () => esRef.current?.close(), []);

  // Escape closes when nothing is in flight (mid-import requires explicit
  // Cancel so a stray keypress can't silently abandon a running import).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && phase !== "running") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const missingRequired = (spec.fields || []).some(
    (f) => f.required && !String(values[f.key] ?? "").trim(),
  );

  function setField(key, v) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function start() {
    setPhase("running");
    setProgress(null);
    setErrorMsg(null);
    doneRef.current = false;
    let flowId;
    try {
      const trimmed = Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, String(v ?? "").trim()]),
      );
      const res = await startSourceHistoryImport(sourceId, trimmed);
      flowId = res.flowId;
      flowRef.current = flowId;
    } catch (e) {
      setErrorMsg(String(e.message || e));
      setPhase("error");
      return;
    }
    if (!flowId) {
      setErrorMsg("Import did not start.");
      setPhase("error");
      return;
    }

    const url = `/admin/sources/${encodeURIComponent(sourceId)}/import-history/events?flowId=${encodeURIComponent(flowId)}`;
    const es = new EventSource(url);
    esRef.current = es;
    es.addEventListener("import", (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (payload.type === "progress") {
        setProgress({
          phase: payload.phase,
          processed: payload.processed,
          total: payload.total,
          detail: payload.detail,
        });
      } else if (payload.type === "complete") {
        doneRef.current = true;
        es.close();
        if (payload.ok) {
          setSummary({
            imported: payload.imported ?? 0,
            merged: payload.merged ?? 0,
            skipped: payload.skipped ?? 0,
          });
          setPhase("done");
          onComplete?.();
        } else {
          setErrorMsg(payload.error || "Import failed.");
          setPhase("error");
        }
      }
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && !doneRef.current) {
        es.close();
        setErrorMsg("Lost connection to the import stream.");
        setPhase("error");
      }
    };
  }

  async function cancel() {
    esRef.current?.close();
    const flowId = flowRef.current;
    if (flowId) {
      try {
        await cancelSourceHistoryImport(sourceId, flowId);
      } catch {
        /* collector may already be gone */
      }
    }
    setErrorMsg("Import cancelled.");
    setPhase("error");
  }

  const pct =
    progress?.total != null && progress.total > 0
      ? Math.max(0, Math.min(100, (progress.processed / progress.total) * 100))
      : null;
  const tone = pct == null ? "zero" : pct >= 100 ? "ok" : pct > 0 ? "partial" : "zero";

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
      onClick=${() => phase !== "running" && onClose?.()}
    >
      <div class="confirm-modal import-modal" onClick=${(e) => e.stopPropagation()}>
        <div id="import-modal-title" class="confirm-modal-title">${spec.label}</div>
        <div class="confirm-modal-body">${spec.description}</div>

        ${phase === "form" &&
        html`
          <div class="import-form">
            ${(spec.fields || []).map(
              (f) => html`
                <div class="form-group" key=${f.key}>
                  <label>${f.label}${f.required ? "" : html` <span class="dim">(optional)</span>`}</label>
                  <${FieldInput} field=${f} value=${values[f.key]} onInput=${(v) => setField(f.key, v)} />
                  ${f.help && html`<div class="form-hint">${f.help}</div>`}
                </div>
              `,
            )}
            <div class="form-hint import-path-note">
              File and folder paths refer to the machine running this source's collector.
            </div>
          </div>
        `}

        ${phase === "running" &&
        html`
          <div class="import-progress">
            <div class="import-progress-phase">
              ${progress?.phase ? `${progress.phase}…` : "Starting…"}
            </div>
            ${pct != null
              ? html`
                  <div class="index-pctbar ${tone}" title=${`${Math.round(pct)}%`}>
                    <div class="index-pctbar-fill" style=${`width:${pct}%`}></div>
                  </div>
                  <div class="import-progress-text">${progress.processed} / ${progress.total}</div>
                `
              : progress?.processed != null
                ? html`<div class="import-progress-text">${progress.processed} processed</div>`
                : html`<div class="import-progress-text dim">Working…</div>`}
            ${progress?.detail && html`<div class="form-hint">${progress.detail}</div>`}
          </div>
        `}

        ${phase === "done" &&
        html`
          <div class="import-result ok">
            <div class="import-result-headline">Import complete</div>
            <div class="import-result-stats">
              <span><strong>${summary.imported}</strong> imported</span>
              <span><strong>${summary.merged}</strong> already present</span>
              <span><strong>${summary.skipped}</strong> skipped</span>
            </div>
          </div>
        `}

        ${phase === "error" &&
        html`<div class="sources-banner-v2 error import-result-error">${errorMsg}</div>`}

        <div class="confirm-modal-actions">
          ${phase === "form" &&
          html`
            <button class="btn-ghost" onClick=${onClose}>Cancel</button>
            <button class="btn-primary" disabled=${missingRequired} onClick=${start}>Import</button>
          `}
          ${phase === "running" &&
          html`<button class="btn-ghost" onClick=${cancel}>Cancel import</button>`}
          ${(phase === "done" || phase === "error") &&
          html`<button class="btn-primary" onClick=${onClose}>Close</button>`}
        </div>
      </div>
    </div>
  `;
}
