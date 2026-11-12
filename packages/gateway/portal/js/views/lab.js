// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getLab, setLabFeature } from "../api.js";

export function LabView({ onChange } = {}) {
  const [features, setFeatures] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    getLab().then((result) => {
      if (active) setFeatures(result.features);
    }).catch((err) => { if (active) setError(err.serverMessage || err.message); });
    return () => { active = false; };
  }, [retry]);

  async function toggle(feature) {
    if (saving) return;
    setSaving(feature.id);
    setError(null);
    try {
      const result = await setLabFeature(feature.id, !feature.enabled);
      setFeatures(result.features);
      await onChange?.();
    } catch (err) {
      setError(err.serverMessage || err.message);
    } finally {
      setSaving(null);
    }
  }

  return html`<section class="lab-view" aria-labelledby="lab-heading">
    <header class="lab-header">
      <span class="lab-eyebrow">A little ahead of the everyday</span>
      <h2 id="lab-heading">Omnesis Lab</h2>
      <p>Explore what Omnesis is becoming. Turn on the experiments you want to try, and turn them off whenever you like.</p>
      <div class="lab-notice">Experimental features may change. Your choices are shared across your connected apps.</div>
    </header>
    ${error && html`<div class="lab-error" role="alert">${error} ${!features && html`<button class="btn-secondary" onClick=${() => setRetry((n) => n + 1)}>Try again</button>`}</div>`}
    ${!features && !error && html`<p role="status">Loading experiments…</p>`}
    <div class="lab-features">
      ${features?.map((feature) => html`<article class=${`lab-feature${feature.enabled ? " is-enabled" : ""}`} key=${feature.id}>
        <div class="lab-feature-icon" aria-hidden="true"><img src=${`data:image/svg+xml,${encodeURIComponent(feature.iconSvg)}`} alt="" width="48" height="48" /></div>
        <div class="lab-feature-copy"><h3>${feature.name}</h3><p>${feature.description}</p></div>
        <div class="lab-feature-control"><button type="button" role="switch" class="lab-switch" aria-label=${`Enable ${feature.name}`} aria-checked=${feature.enabled} disabled=${saving !== null} onClick=${() => toggle(feature)}><span></span></button><span class="lab-feature-state">${saving === feature.id ? "Saving…" : feature.enabled ? "Enabled" : "Off"}</span></div>
      </article>`)}
    </div>
    ${features && html`<p class="lab-footnote">Switching an experiment off pauses its features. Your existing data stays here for when you return.</p>`}
  </section>`;
}
