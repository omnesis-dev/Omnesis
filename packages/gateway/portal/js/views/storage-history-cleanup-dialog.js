// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { startStorageCleanup } from "../api.js";
import { Modal } from "../components/modal.js";
import { storageCleanupCutoff, storageCleanupTarget } from "./storage-cleanup-data.js";

export function StorageHistoryCleanupDialog(props) {
  // A different cleanup category always starts with fresh scope and consent.
  return html`<${CleanupDialog} key=${props.target} ...${props} />`;
}

function CleanupDialog({ target, onClose, onSaved }) {
  const [before, setBefore] = useState("");
  const [keepNewest, setKeepNewest] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState(null);
  const lock = useRef(false);
  const accepted = useRef(false);
  const details = storageCleanupTarget(target);
  const cutoff = storageCleanupCutoff(before);
  if (!details) return null;

  function changeDate(value) {
    if (lock.current || accepted.current) return;
    setBefore(value); setConfirmed(false); setError(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (lock.current || accepted.current || !cutoff || !confirmed) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const { job } = await startStorageCleanup({ target, before: cutoff, ...(target === "backups" ? { keepNewest } : {}) });
      // A successful schedule must never be repeated because a page update failed.
      accepted.current = true; setStarted(true);
      await onSaved("Cleanup scheduled. All eligible items before this date will be removed in the background.", job);
    } catch (err) {
      setError(err.serverMessage || err.message);
    } finally {
      lock.current = false; setBusy(false);
    }
  }

  return html`<${Modal} open title=${details.action} subtitle=${details.label} onClose=${() => { if (!lock.current) onClose(); }}>
    <div class="storage-dialog">
      <p>${details.explanation}</p>
      <p>This is a one-off cleanup. Existing retention settings stay the same.</p>
      <form onSubmit=${submit}>
        <div class="storage-dialog-fields">
          <label for="storage-cleanup-before">Remove before (UTC)</label>
          <input id="storage-cleanup-before" type="date" required value=${before} disabled=${busy || started}
            onInput=${(event) => changeDate(event.currentTarget.value)} />
        </div>
        ${target === "backups" && html`<label class="storage-consent"><input id="storage-cleanup-keep-newest" type="checkbox" checked=${keepNewest} disabled=${busy || started}
          onChange=${(event) => { if (lock.current || accepted.current) return; setKeepNewest(event.currentTarget.checked); setConfirmed(false); setError(null); }} />
          Keep the newest completed backup.
        </label>`}
        ${target === "backups" && !keepNewest && html`<p class="storage-alert">This can remove every completed backup before the cutoff, including your newest backup. You may have no backup left to restore.</p>`}
        ${cutoff && html`<p>All eligible ${details.label.toLowerCase()} before ${before} at 00:00 UTC will be removed. Removed and protected counts appear as cleanup runs.</p>`}
        <p>Deletion is permanent. Removed file bytes do not guarantee an immediate increase in free disk space.</p>
        <label class="storage-consent"><input id="storage-cleanup-confirm" type="checkbox" checked=${confirmed} disabled=${busy || started}
          onChange=${(event) => setConfirmed(event.currentTarget.checked)} />
          Permanently remove all eligible ${details.label.toLowerCase()} before this date.
        </label>
        <button class="btn-primary danger" disabled=${busy || started || !cutoff || !confirmed}>${busy ? "Scheduling…" : details.action}</button>
      </form>
      ${started && html`<p role="status">Cleanup is scheduled. Close this dialog to follow its progress.</p>`}
      ${error && html`<p class="storage-alert" role="alert">${error}</p>`}
    </div>
  <//>`;
}
