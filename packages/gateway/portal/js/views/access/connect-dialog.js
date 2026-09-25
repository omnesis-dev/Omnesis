// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The dialog that connects an OAuth-capable MCP client: the MCP server address
// to paste into the client, then the short code the client's authorization
// window shows once it has registered. A matching code opens that pending
// request on its own page for review.
//
// The dialog is mounted only while it is open and only where OAuth is
// configured, so `oauth` is always a live address here.

import { html } from "htm/preact";
import { useState } from "preact/hooks";

import { lookupAccessAuthorization } from "../../api.js";
import { CopyIconButton } from "../../components/copy-button.js";
import { Modal } from "../../components/modal.js";
import { navigate } from "../../lib/router.js";
import { authorizationStatusNotice } from "./authorization.js";
import { errorMessage } from "./shared.js";

/**
 * Why a code the gateway does hold cannot be opened for review.
 *
 * A lapsed request keeps its pending status until the gateway sweeps it — the
 * expiry is a moment, not a state — so the clock is what tells the owner their
 * code went stale, and the status only speaks for a request somebody already
 * decided.
 */
function unusableCodeReason(request, now = Date.now()) {
  if (request.expiresAt <= now) {
    return "That code expired. The client can request a new one.";
  }
  return authorizationStatusNotice(request.status);
}

function ConnectStep({ number, title, caption, children }) {
  return html`<section class="access-connect-step">
    <span aria-hidden="true">${number}</span>
    <div>
      <h3>${title}</h3>
      <p>${caption}</p>
      ${children}
    </div>
  </section>`;
}

export function ConnectAgentDialog({ oauth, onClose }) {
  const [code, setCode] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState("");

  async function lookup(event) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    setLookingUp(true);
    setError("");
    try {
      const result = await lookupAccessAuthorization(normalized);
      const unusable = result.request.status === "pending"
        ? (result.request.expiresAt <= Date.now() ? unusableCodeReason(result.request) : null)
        : unusableCodeReason(result.request);
      if (unusable) throw new Error(unusable);
      // The request has its own page. Closing first keeps the dialog from
      // springing back over that page's decision notice when the review sends
      // the address back here.
      close();
      navigate(
        `/portal/settings/access/authorizations/${encodeURIComponent(result.request.approvalId)}`,
      );
    } catch (failure) {
      // A code the gateway does not hold is the ordinary miss on this form, so
      // it is worded here rather than by the shared helper every page reads.
      setError(
        failure?.status === 404
          ? "No pending authorization matches that code. If the client has been waiting a while, its code may have expired — ask it for a new one."
          : errorMessage(failure, failure?.message || "The authorization code could not be checked."),
      );
    } finally {
      setLookingUp(false);
    }
  }

  function close() {
    setCode("");
    setError("");
    onClose();
  }

  return html`<${Modal} open title="Connect an agent" onClose=${close}>
    <div class="access-connect-dialog">
      <p class="access-explainer">An OAuth-capable MCP client connects in two steps.</p>
      <${ConnectStep}
        number="1"
        title="Add this MCP server to the client"
        caption="Paste it into ChatGPT, Claude, Codex, or another OAuth-capable client."
      >
        <div class="access-mcp-resource">
          <code>${oauth.resource}</code>
          <${CopyIconButton}
            text=${oauth.resource}
            class="access-copy-button"
            title="Copy MCP resource"
          />
        </div>
      <//>
      <${ConnectStep}
        number="2"
        title="Enter the code the client shows"
        caption="The client's authorization window shows a short code once it has registered."
      >
        <form onSubmit=${lookup} aria-busy=${lookingUp ? "true" : "false"}>
          <label class="form-group">
            <span>Authorization code</span>
            <input
              class="access-code-input"
              autocomplete="one-time-code"
              maxlength="20"
              placeholder="ABCD-EFGH"
              value=${code}
              onInput=${(event) => setCode(event.currentTarget.value)}
              disabled=${lookingUp}
            />
          </label>
          <button type="submit" class="btn-primary" disabled=${lookingUp || !code.trim()}>${lookingUp ? "Checking…" : "Review request"}</button>
        </form>
        <p class="access-connect-status" role="status">${lookingUp ? "Checking the authorization code…" : ""}</p>
        ${error && html`<p class="access-error" role="alert">${error}</p>`}
      <//>
      <div class="access-request-actions">
        <button type="button" class="btn-secondary" onClick=${close}>Close</button>
      </div>
    </div>
  <//>`;
}
