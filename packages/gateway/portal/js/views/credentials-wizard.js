// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useMemo, useEffect } from "preact/hooks";
import { getAdminConfig, setProviderCredentials } from "../api.js";
import {
  resolveGatewayOrigin,
  expandGatewayOriginToken,
  publicBaseUrlFromAdminConfig,
  expandSpecTokens,
} from "@omnesis/core/credentials-tokens";
import { CopyIconButton } from "../components/copy-button.js";

/**
 * Modal wizard for configuring a provider's credentials. Spec-driven
 * and provider-agnostic — the same component renders both the
 * collector-routed source-credentials flow and the gateway-local
 * model-credentials flow.
 *
 * Renders the spec the gateway returned (intro, why, sequential steps,
 * field schema), tracks the user's progress through the steps, validates
 * pasted fields against the spec's regex patterns, and submits via the
 * supplied `saveCredentials` callback (defaults to the source-credentials
 * `POST /admin/credentials/<fileKey>` for backward-compat).
 *
 * Sequential steps: each is shown alone with Continue / Cancel. The last
 * step opens the field-paste form. Mirrors the CLI flow exactly so users
 * see the same wording in both surfaces.
 *
 * Props:
 *   - entry: { fileKey, providerType, providerName, spec, configured }
 *   - deviceId: string (used by the default source-credentials save path)
 *   - saveCredentials?: ({ fileKey, fields }) => Promise — overrides the
 *     default save call. Pass this when targeting a different endpoint
 *     (e.g. gateway-local model credentials at /admin/model-credentials).
 *   - collectOnly?: boolean — collect the fields and hand them back WITHOUT
 *     saving. Used for a `perAccount` credential, which has no provider-wide
 *     slot: it is threaded through the auth flow and stored under the account
 *     the provider's probe resolves, so nothing is written until that succeeds.
 *   - onClose(updated: boolean, fields?): closes the modal — `updated=true` if
 *     the user completed it. `fields` carries the collected values in
 *     `collectOnly` mode; passing them as an argument rather than through a
 *     state setter is deliberate, since a setter would not have applied by the
 *     time the caller reads it.
 */
/**
 * Hand the collected fields wherever they belong, then close.
 *
 * Extracted so the delivery contract is testable without a DOM. The contract
 * that matters: in `collectOnly` mode the fields reach the caller as an
 * `onClose` ARGUMENT. Routing them through a state setter and reading them
 * back in the caller's `onClose` yields `undefined` — the setter has not
 * applied yet — which strands the caller's auth flow and, with an
 * always-collect pre-flight, reopens this wizard forever.
 */
export async function deliverCredentialFields({
  collectOnly,
  cleaned,
  entry,
  deviceId,
  saveCredentials,
  save,
  onClose,
}) {
  if (collectOnly) {
    onClose(true, cleaned);
    return;
  }
  if (saveCredentials) {
    await saveCredentials({ fileKey: entry.fileKey, fields: cleaned });
  } else {
    await save({ fileKey: entry.fileKey, deviceId, fields: cleaned });
  }
  onClose(true);
}

export function CredentialsWizard({ entry, deviceId, saveCredentials, collectOnly, onClose }) {
  const { spec, providerName } = entry;
  const totalSteps = spec.wizard.steps.length;
  // Phases: -1 = intro, 0..totalSteps-1 = steps, totalSteps = paste form.
  const [phase, setPhase] = useState(-1);
  const [fields, setFields] = useState(() => {
    const init = {};
    for (const f of spec.fields) init[f.name] = "";
    return init;
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [gatewayOrigin, setGatewayOrigin] = useState("");

  // Resolve the gateway's externally-reachable origin on mount (prefer the
  // configured publicBaseUrl, else the portal's own origin), then seed any
  // token-bearing field defaults with the resolved value so the user does not
  // have to type them. Only untouched fields are seeded.
  useEffect(() => {
    (async () => {
      let publicBaseUrl;
      try {
        publicBaseUrl = publicBaseUrlFromAdminConfig(await getAdminConfig());
      } catch {
        /* config unreachable — fall back to the browser origin */
      }
      const origin = resolveGatewayOrigin(publicBaseUrl);
      setGatewayOrigin(origin);
      setFields((prev) => {
        const next = { ...prev };
        for (const f of spec.fields) {
          if (!prev[f.name] && f.default) next[f.name] = expandGatewayOriginToken(f.default, origin);
        }
        return next;
      });
    })();
  }, [spec]);

  // Expand tokens in the spec with the resolved origin
  const expandedSpec = useMemo(() => {
    return expandSpecTokens(spec, gatewayOrigin);
  }, [spec, gatewayOrigin]);

  const advance = () => setPhase((p) => Math.min(p + 1, totalSteps));
  const back = () => setPhase((p) => Math.max(p - 1, -1));

  const validate = () => {
    const next = {};
    let ok = true;
    for (const f of expandedSpec.fields) {
      const v = (fields[f.name] ?? "").trim();
      if (!v) {
        next[f.name] = `${f.label} is required`;
        ok = false;
        continue;
      }
      if (f.pattern) {
        try {
          const re = new RegExp(f.pattern);
          if (!re.test(v)) {
            next[f.name] = f.patternHint ?? `${f.label} has invalid format`;
            ok = false;
          }
        } catch {
          /* malformed regex — skip client-side validation, server will catch it */
        }
      }
    }
    setErrors(next);
    return ok;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const cleaned = {};
      for (const f of expandedSpec.fields) cleaned[f.name] = fields[f.name].trim();
      await deliverCredentialFields({
        collectOnly,
        cleaned,
        entry,
        deviceId,
        saveCredentials,
        save: setProviderCredentials,
        onClose,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
    setSubmitting(false);
  };

  const renderIntro = () => html`
    <div class="creds-wizard-section">
      <p class="creds-wizard-intro">${expandedSpec.wizard.intro}</p>
      <div class="creds-wizard-why">
        <strong>Why?</strong> ${expandedSpec.wizard.why}
      </div>
      <p class="creds-wizard-est">Estimated time: ~${expandedSpec.wizard.estMinutes} minute${expandedSpec.wizard.estMinutes === 1 ? "" : "s"}.</p>
    </div>
  `;

  // Render a step body: one <p> per line, with `backtick` spans surfaced as
  // inline <code>. A code span that carries the resolved gateway origin is an
  // exact paste-and-match value (e.g. the redirect URL the user whitelists in
  // this very step) — attach a one-click copy button. Generic: keys on the
  // substituted origin, not on any source-specific URL shape.
  const renderStepBody = (body) =>
    body.split("\n").map((line, i) => {
      const parts = line.split(/`([^`]+)`/g).map((seg, j) => {
        if (j % 2 === 0) return seg;
        return gatewayOrigin && seg.includes(gatewayOrigin)
          ? html`<span class="creds-wizard-code-copy" key=${j}><code>${seg}</code><${CopyIconButton} text=${seg} class="creds-wizard-copy-btn" /></span>`
          : html`<code key=${j}>${seg}</code>`;
      });
      return html`<p key=${i}>${parts}</p>`;
    });

  const renderStep = (step, idx) => html`
    <div class="creds-wizard-section">
      <div class="creds-wizard-step-num">Step ${idx + 1} of ${totalSteps}</div>
      <h3 class="creds-wizard-step-title">${step.title}</h3>
      <div class="creds-wizard-step-body">${renderStepBody(step.body)}</div>
      ${step.kind === "open-url" && step.url
        ? html`
          <a class="creds-wizard-link" href=${step.url} target="_blank" rel="noopener noreferrer">
            Open ${step.url} ↗
          </a>
        `
        : null
      }
    </div>
  `;

  // The redirect URL field is pre-filled from the resolved origin (see the
  // mount effect) so the user doesn't retype it; the copyable exact value
  // lives in the step body where the whitelisting happens.
  const renderForm = () => html`
    <form class="creds-wizard-form" onSubmit=${handleSubmit}>
      <div class="creds-wizard-section">
        <h3 class="creds-wizard-step-title">Paste the credentials</h3>
        <p class="creds-wizard-step-body">
          ${collectOnly
            ? html`Stored under the account they turn out to belong to, once verified — nothing is written until then.`
            : html`Saved as <code>~/.config/omnesis/${entry.fileKey}-credentials.json</code> on the ${saveCredentials ? "gateway" : "collector"} host with mode 0600.`}
        </p>
      </div>
      ${expandedSpec.fields.map((field) => html`
        <div class="creds-wizard-field" key=${field.name}>
          <label class="creds-wizard-field-label" for=${`creds-${entry.fileKey}-${field.name}`}>${field.label}</label>
          <input
            id=${`creds-${entry.fileKey}-${field.name}`}
            class=${errors[field.name] ? "creds-wizard-field-input error" : "creds-wizard-field-input"}
            type=${field.secret ? "password" : "text"}
            placeholder=${field.placeholder ?? ""}
            value=${fields[field.name] ?? ""}
            onInput=${(e) => setFields((f) => ({ ...f, [field.name]: e.target.value }))}
            disabled=${submitting}
            autocomplete="off"
            spellcheck="false"
          />
          ${errors[field.name]
            ? html`<div class="creds-wizard-field-error">${errors[field.name]}</div>`
            : null}
        </div>
      `)}
      ${submitError
        ? html`<div class="creds-wizard-submit-error">${submitError}</div>`
        : null}
    </form>
  `;

  const phaseContent =
    phase === -1
      ? renderIntro()
      : phase < totalSteps
        ? renderStep(expandedSpec.wizard.steps[phase], phase)
        : renderForm();

  const isFinalPhase = phase === totalSteps;
  const primaryLabel = phase === -1 ? "Start" : phase < totalSteps - 1 ? "Continue" : phase === totalSteps - 1 ? "I have my credentials" : submitting ? "Saving..." : "Save credentials";

  return html`
    <div class="creds-wizard-overlay" role="dialog" aria-modal="true" onClick=${(e) => {
      // Stop propagation: the wizard is mounted inside the Add Source modal's
      // backdrop, whose click handler closes that modal. Without this, every
      // click in the wizard bubbles up and tears the whole stack down.
      e.stopPropagation();
      if (e.target === e.currentTarget && !submitting) onClose(false);
    }}>
      <div class="creds-wizard-modal" onClick=${(e) => e.stopPropagation()}>
        <header class="creds-wizard-header">
          <h2 class="creds-wizard-title">${providerName} credentials</h2>
          <button class="creds-wizard-close" onClick=${() => onClose(false)} disabled=${submitting} aria-label="Close">×</button>
        </header>

        <div class="creds-wizard-body">
          ${phaseContent}
        </div>

        <footer class="creds-wizard-footer">
          ${phase > -1
            ? html`<button class="creds-wizard-btn-secondary" onClick=${back} disabled=${submitting}>Back</button>`
            : html`<span></span>`}
          ${isFinalPhase
            ? html`
              <button
                type="button"
                class="creds-wizard-btn-primary"
                onClick=${handleSubmit}
                disabled=${submitting}
              >${submitting ? "Saving..." : "Save credentials"}</button>
            `
            : html`
              <button
                type="button"
                class="creds-wizard-btn-primary"
                onClick=${advance}
                disabled=${submitting}
              >${primaryLabel}</button>
            `}
        </footer>
      </div>
    </div>
  `;
}
