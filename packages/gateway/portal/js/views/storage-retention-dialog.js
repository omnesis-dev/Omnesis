// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { applyStorageTrim, previewStorageTrim, setStorageRetention } from "../api.js";
import { Modal } from "../components/modal.js";
import { sourceLabel } from "../lib/format.js";
import { bytesBeforeMonthCutoff, DAY_MS, MAX_RETENTION_DAYS, storageBytes } from "./storage-data.js";
import { StorageHistory } from "./storage-history.js";

function retentionCutoff(now, days) {
  return Number.isInteger(days) && days > 0 && days <= MAX_RETENTION_DAYS
    ? new Date(now - days * DAY_MS).toISOString().slice(0, 10)
    : "";
}

export function StorageRetentionDialog({ mode, source, retentionDays, onClose, onSaved }) {
  const rolling = mode === "retention";
  const [openedAt] = useState(Date.now);
  const todayMs = Date.parse(new Date(openedAt).toISOString().slice(0, 10));
  const [before, setBefore] = useState("");
  const [days, setDays] = useState(String(retentionDays ?? ""));
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const lock = useRef(false);
  const cutoff = rolling ? retentionCutoff(todayMs, Number(days)) : before;

  function resetApproval() {
    setPreview(null);
    setConfirmed(false);
    setError(null);
  }

  function selectDate(date) {
    if (lock.current) return;
    resetApproval();
    const timestamp = Date.parse(date);
    if (rolling) {
      const window = (todayMs - timestamp) / DAY_MS;
      if (!Number.isInteger(window) || window < 1 || window > MAX_RETENTION_DAYS) {
        setError("Choose a date from 1 to 36,500 days ago.");
        return;
      }
      setDays(String(window));
    } else setBefore(date);
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
        await onSaved(days === "" ? "Rolling retention disabled." : "Rolling retention saved.");
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
      const status = `${result.deleted} documents removed.${result.hasMore ? " Preview the next batch to continue." : ""}${result.cleanupPending ? " Index cleanup is pending." : ""}`;
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
          <label>${rolling ? "Cutoff date today (UTC)" : "Remove documents before (UTC)"}
            <input id="storage-before" type="date" required=${!rolling} max=${rolling ? retentionCutoff(todayMs, 1) : undefined}
              value=${cutoff} disabled=${busy} onInput=${(event) => {
                if (rolling && !event.currentTarget.value) { resetApproval(); setDays(""); }
                else selectDate(event.currentTarget.value);
              }} />
          </label>
          ${rolling && html`<label>Days to keep
            <input id="storage-retention-days" type="number" min="1" max=${MAX_RETENTION_DAYS} step="1"
              value=${days} placeholder="Keep all dates" disabled=${busy} onInput=${(event) => {
                resetApproval(); setDays(event.currentTarget.value);
              }} />
          </label>`}
        </div>
        <${StorageHistory} months=${source.months} selectedCutoff=${cutoff} onSelectCutoff=${busy ? undefined : selectDate} />
        ${cutoff && html`<p><strong>${storageBytes(bytesBeforeMonthCutoff(source.months, cutoff))}</strong> estimated usage in complete months before this date. Excludes partial months and undated data. Some documents are protected.</p>`}
        ${rolling && cutoff && html`<p>At the time you opened this dialog, a ${Number(days).toLocaleString()}-day window would keep documents from ${new Date(openedAt - Number(days) * DAY_MS).toISOString().slice(0, 16).replace("T", " ")} UTC onward. The cutoff moves continuously with time.</p>`}
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
      ${message && html`<p role="status">${message}</p>`}
    </div>
  <//>`;
}
