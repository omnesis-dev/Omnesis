// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getBrowserNotesAuthorization, approveBrowserNotesAuthorization } from "../api.js";

export function BrowserNotesApprovalView({ requestId }) {
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    let active = true;
    setRequest(null);
    setError(null);
    setApproved(false);
    if (!requestId) {
      setError("Open this page from Enable Tell Omnesis in your browser extension.");
      return;
    }
    getBrowserNotesAuthorization(requestId)
      .then((value) => {
        if (active) {
          setRequest(value);
          setApproved(value.status === "approved");
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [requestId]);
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await approveBrowserNotesAuthorization(requestId);
      setApproved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="capture-view">
    <header class="privacy-page-header">
      <div><h1>Enable Tell Omnesis in your browser</h1></div>
    </header>
    <section class="capture-column capture-composer">
      ${error ? html`<p role="alert">${error}</p>` : null}
      ${approved
        ? html`<h2>Tell Omnesis is enabled</h2>
            <p>Return to your extension to write a note. You can close this tab.</p>`
        : request
          ? html`<h2>${request.deviceName}</h2>
              <p>
                Allow this browser to create notes with the page URL and any text you explicitly
                select.
              </p>
              <p>
                This permission cannot read your notes, edit or delete them, or read your indexed
                data. Automatic page capture keeps its existing permission.
              </p>
              <p>
                Approve only if you just requested this in your extension. You can revoke the
                Browser Tell Omnesis token from Settings → Devices.
              </p>
              <button class="btn-primary" onClick=${approve} disabled=${busy}>
                ${busy ? "Enabling…" : "Enable Tell Omnesis"}
              </button>`
          : !error
            ? html`<p role="status">Loading browser request…</p>`
            : null}
    </section>
  </div>`;
}
