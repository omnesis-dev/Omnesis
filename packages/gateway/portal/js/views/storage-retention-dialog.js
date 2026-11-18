// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { applyStorageTrim, previewStorageTrim, setStorageRetention } from "../api.js";
import { Modal } from "../components/modal.js";
import { sourceLabel } from "../lib/format.js";
import { bytesBeforeMonthCutoff, DAY_MS, MAX_RETENTION_DAYS, storageBytes } from "./storage-data.js";
import { StorageHistory } from "./storage-history.js";

function rollingCutoff(now, days) {
  return Number.isInteger(days) && days > 0 && days <= MAX_RETENTION_DAYS
    ? new Date(now - days * DAY_MS).toISOString()
    : "";
}

export function StorageRetentionDialog({ mode, source, retentionDays, onClose, onSaved }) {
  const rolling = mode === "retention";
  const [openedAt] = useState(Date.now);
  const [before, setBefore] = useState("");
  const [days, setDays] = useState(String(retentionDays ?? ""));
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const lock = useRef(false);
  const cutoffInstant = rolling ? rollingCutoff(openedAt, Number(days)) : "";
  const cutoff = rolling ? cutoffInstant.slice(0, 10) : before;

  function resetApproval() {
    setPreview(null);
    setConfirmed(false);
    setError(null);
  }

  function selectDate(date) {
    if (lock.current) return;
    resetApproval();
    setBefore(date);
  }

  function changeDays(value) {
    if (lock.current) return;
    resetApproval();
    setDays(value);
  }

  function stepDays(delta) {
    const current = Number(days);
    const start = Number.isInteger(current) ? current : 0;
    changeDays(String(Math.min(MAX_RETENTION_DAYS, Math.max(1, start + delta))));
  }

  async function run(operation) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(null); setMessage(null);
    try { await operation(); } catch (err) { setError(err.serverMessage || err.message); }
    finally { lock.current = false; setBusy(false); }
  }

  function submit(event) {
    event.preventDefault();
    if (rolling) {
      if (days !== "" && (!cutoff || !confirmed)) return;
      void run(async () => {
        await setStorageRetention(source.sourceId, days === "" ? null : Number(days));
        await onSaved(days === "" ? "Rolling retention disabled." : "Rolling retention saved. Older documents are removed in the background. Reopen the source chart or refresh measurements to see progress.");
      });
    } else if (cutoff) {
      resetApproval();
      void run(async () => {
        setPreview(await previewStorageTrim(source.sourceId, new Date(`${cutoff}T00:00:00Z`).toISOString()));
      });
    }
  }

  function trim() {
    if (!preview?.token || !preview.documents || !confirmed) return;
    void run(async () => {
      resetApproval();
      const result = await applyStorageTrim(preview.token);
      const status = `${result.deleted} ${result.deleted === 1 ? "document" : "documents"} removed from ${sourceLabel(source.sourceId)}.${result.hasMore ? " Preview the next batch to continue." : ""}${result.cleanupPending ? " Index cleanup is still running." : ""}`;
      if (result.hasMore) setMessage(status);
      await onSaved(status, result.hasMore);
    });
  }

  return html`<${Modal} open size="lg" title=${rolling ? "Set rolling retention" : "Trim stored history"}
    subtitle=${sourceLabel(source.sourceId)} onClose=${() => { if (!lock.current) onClose(); }}>
    <div class="storage-dialog">
      ${rolling && html`<p>Omnesis will automatically remove older documents now and as they age. Clear the window to turn this off.</p>`}
      <form onSubmit=${submit}>
        <div class="storage-dialog-fields">
          ${rolling ? html`
            <label for="storage-retention-days">Days to keep</label>
            <div class="storage-days-controls">
              <input id="storage-retention-days" type="number" min="1" max=${MAX_RETENTION_DAYS} step="1"
                value=${days} placeholder="Keep all dates" disabled=${busy}
                onInput=${(event) => changeDays(event.currentTarget.value)} />
              <button type="button" class="btn-secondary" aria-label="Decrease days"
                disabled=${busy || Number(days) <= 1} onClick=${() => stepDays(-1)}>−</button>
              <button type="button" class="btn-secondary" aria-label="Increase days"
                disabled=${busy || Number(days) >= MAX_RETENTION_DAYS} onClick=${() => stepDays(1)}>+</button>
            </div>
          ` : html`
            <label for="storage-before">Remove before (UTC)</label>
            <input id="storage-before" type="date" required value=${before} disabled=${busy}
              onInput=${(event) => selectDate(event.currentTarget.value)} />
          `}
        </div>
        <${StorageHistory} months=${source.months} selectedCutoff=${cutoff}
          cutoffInstant=${cutoffInstant} onSelectCutoff=${!rolling && !busy ? selectDate : undefined} />
        ${cutoff && html`<p><strong>${storageBytes(bytesBeforeMonthCutoff(source.months, cutoff))}</strong> estimated usage in complete months before this date. Excludes partial months and undated data. Some documents are protected.</p>`}
        ${rolling && cutoff && html`<p>At the time you opened this dialog, a ${Number(days).toLocaleString()}-day window would keep documents from ${cutoffInstant.slice(0, 16).replace("T", " ")} UTC onward. The cutoff moves continuously with time.</p>`}
        ${rolling ? html`
          ${days !== "" && html`<label class="storage-consent"><input id="storage-retention-confirm" type="checkbox"
            checked=${confirmed} disabled=${busy} onChange=${(event) => setConfirmed(event.currentTarget.checked)} />
            Automatically remove documents older than this window from Omnesis.
          </label>`}
          <button class="btn-primary" disabled=${busy || (days !== "" && (!cutoff || !confirmed))}>Save rolling retention</button>
        ` : html`<button class="btn-secondary" disabled=${busy || !cutoff}>Preview trim</button>`}
      </form>
      ${preview && html`<div class="storage-trim-preview">
        <h4>Confirm this batch</h4>
        <p>${preview.documents
          ? `${preview.documents} documents · ${storageBytes(preview.payloadBytes)} of document payload.`
          : "No eligible documents before this date."}</p>
        ${preview.hasMore && html`<p>More older documents remain. Each batch needs its own preview and confirmation.</p>`}
        ${preview.documents > 0 && html`
          <label class="storage-consent"><input type="checkbox" checked=${confirmed} disabled=${busy}
            onChange=${(event) => setConfirmed(event.currentTarget.checked)} />
            Remove these documents from Omnesis. Originals stay in the connected source.
          </label>
          <button type="button" class="btn-primary danger" disabled=${busy || !confirmed || !preview.token} onClick=${trim}>Delete previewed data</button>
        `}
      </div>`}
      ${error && html`<p class="storage-alert" role="alert">${error}</p>`}
      ${message && html`<p role="status">${message}${busy ? " Updating storage charts…" : ""}</p>`}
    </div>
  <//>`;
}
