// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { ConfirmModal } from "./confirm-modal.js";

export function cloudInferenceConsentBody({ modelName, providerLabel } = {}) {
  return html`
    <p>${modelName ? `Using ${modelName}` : "Cloud inference"} sends messages, conversation context, and relevant Omnesis data and tool results ${providerLabel ? `to ${providerLabel}` : "to the configured remote providers"}. Depending on the capabilities you configure, this can also include search queries, document chunks, audio, and images.</p>
    <p>This permission applies to this gateway's configured remote inference backends, not only ${modelName ?? "one model"}. You can turn it off in Settings → Models.</p>
  `;
}

export function CloudInferenceConsentModal({ open, modelName, providerLabel, busy = false, error, onConfirm, onCancel }) {
  return html`<${ConfirmModal}
    open=${open}
    title="Enable cloud inference?"
    body=${html`${cloudInferenceConsentBody({ modelName, providerLabel })}${error ? html`<p role="alert">${error}</p>` : null}`}
    confirmLabel=${busy ? "Enabling…" : "Enable cloud inference"}
    confirmDisabled=${busy}
    cancelDisabled=${busy}
    onConfirm=${onConfirm}
    onCancel=${onCancel}
  />`;
}
