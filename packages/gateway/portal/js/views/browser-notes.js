// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getBrowserNotesAuthorization, approveBrowserNotesAuthorization, getBrowserFindAuthorization, approveBrowserFindAuthorization } from "../api.js";

export function BrowserNotesApprovalView({ requestId, feature = "notes" }) {
  const find = feature === "find";
  const label = find ? "Find" : "Tell Omnesis";
  const loadRequest = find ? getBrowserFindAuthorization : getBrowserNotesAuthorization;
  const approveRequest = find ? approveBrowserFindAuthorization : approveBrowserNotesAuthorization;
  const generation = useRef(0);
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setBusy(false);
    setRequest(null);
    setError(null);
    setApproved(false);
    if (!requestId) {
      setError(`Open this page from Enable ${label} in your browser extension.`);
      return;
    }
    loadRequest(requestId)
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
      generation.current += 1;
    };
  }, [requestId, feature]);
  const approve = async () => {
    const ownGeneration = generation.current;
    setBusy(true);
    setError(null);
    try {
      await approveRequest(requestId);
      if (generation.current === ownGeneration) setApproved(true);
    } catch (err) {
      if (generation.current === ownGeneration) setError(err.message);
    } finally {
      if (generation.current === ownGeneration) setBusy(false);
    }
  };
  return html`<div class="capture-view">
    <header class="privacy-page-header">
      <div><h1>Enable ${label} in your browser</h1></div>
    </header>
    <section class="capture-column capture-composer">
      ${error ? html`<p role="alert">${error}</p>` : null}
      ${approved
        ? html`<h2>${label} is enabled</h2>
            <p>Return to your extension ${find ? "to search your data" : "to write a note"}. You can close this tab.</p>`
        : request
          ? html`<h2>${request.deviceName}</h2>
              ${find ? html`<p>Allow this browser to search and read your Omnesis data across all sources.</p>
                <p>This grants the standard read permission for your whole index. Find shows results with web links, but this credential can also read other indexed data. It cannot write, edit or delete data.</p>` : html`<p>Allow this browser to create notes with the page URL and any text you explicitly select.</p>
                <p>This permission cannot read your notes, edit or delete them, or read your indexed data. Automatic page capture keeps its existing permission.</p>`}
              <p>Approve only if you just requested this in your extension. You can revoke the
                ${find ? "Search your Omnesis data" : "Browser Tell Omnesis"} token from Settings → Devices.</p>
              <button class="btn-primary" onClick=${approve} disabled=${busy}>
                ${busy ? "Enabling…" : `Enable ${label}`}
              </button>`
          : !error
            ? html`<p role="status">Loading browser request…</p>`
            : null}
    </section>
  </div>`;
}
