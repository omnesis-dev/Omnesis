// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getTelemetryStatus, patchAdminConfig } from "../api.js";

const TELEMETRY_DOCS = "https://github.com/omnesis-dev/Omnesis/blob/main/TELEMETRY.md";
const TELEMETRY_PREFERENCE_CHANGE = "omnesis:telemetry-preference-change";

/** Refresh from gateway state, including choices made in another browser. */
function useTelemetryStatus() {
  const [status, setStatus] = useState(null);
  const sequence = useRef(0);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const current = ++sequence.current;
      try {
        const next = await getTelemetryStatus();
        if (!disposed && current === sequence.current) setStatus(next);
      } catch { /* A missing status never blocks the portal. */ }
    };
    void refresh();
    const onVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(TELEMETRY_PREFERENCE_CHANGE, refresh);
    let events;
    try {
      if (typeof EventSource !== "undefined") {
        events = new EventSource("/admin/config/events", { withCredentials: true });
        events.onmessage = refresh;
      }
    } catch { /* Live refresh is optional; initial and visibility refresh still work. */ }
    return () => {
      disposed = true;
      sequence.current++;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(TELEMETRY_PREFERENCE_CHANGE, refresh);
      events?.close?.();
    };
  }, []);
  const update = (next) => {
    sequence.current++;
    setStatus(next);
    window.dispatchEvent(new window.Event(TELEMETRY_PREFERENCE_CHANGE));
  };
  return [status, update];
}

export function TelemetryNotice() {
  const [status, update] = useTelemetryStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const noticeRecorded = useRef(false);
  useEffect(() => {
    if (!status?.enabled || status.acknowledged || status.noticeShown || noticeRecorded.current || document.visibilityState === "hidden") return;
    noticeRecorded.current = true;
    // Disclosure starts the grace period; the two actions are not an opt-in gate.
    // This patch changes neither preference nor acknowledgement, including when
    // another browser disables reporting while the notice is being displayed.
    void patchAdminConfig({ telemetry: { noticeShown: true } }).catch(() => {});
  }, [status]);
  if (!status?.enabled || status.acknowledged) return null;

  const acknowledge = async (disable) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await patchAdminConfig({
        telemetry: { acknowledged: true, ...(disable ? { enabled: false } : {}) },
      });
      if (!result.ok) throw new Error("Your preference could not be saved. Please try again.");
      // Agree only acknowledges: it never re-enables a preference disabled elsewhere.
      update({ ...status, acknowledged: true, enabled: disable ? false : status.enabled });
    } catch {
      setError("Your preference could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return html`
    <aside class="telemetry-notice" role="region" aria-labelledby="telemetry-notice-title">
      <span class="telemetry-eyebrow">Installation statistics</span>
      <h2 id="telemetry-notice-title">Help us improve Omnesis</h2>
      <p>Omnesis collects minimal installation statistics to help us understand adoption and improve platform support.</p>
      <p>Once a day, your gateway shares its version, Git commit, operating system, CPU architecture and a randomly derived identifier that changes every month.</p>
      <p>Your personal data, connected accounts, indexed content and conversations are never included. IP addresses are not retained for analytics.</p>
      <p class="telemetry-notice-settings">You can change this preference at any time in <a href="/portal/settings/config">Settings</a>. <a href=${TELEMETRY_DOCS} target="_blank" rel="noopener noreferrer">Read about telemetry ↗</a></p>
      ${error && html`<p class="telemetry-error" role="alert">${error}</p>`}
      <div class="telemetry-notice-actions">
        <button type="button" class="btn-secondary" disabled=${busy} onClick=${() => acknowledge(true)}>Disable telemetry</button>
        <button type="button" class="btn-primary" disabled=${busy} onClick=${() => acknowledge(false)}>Agree</button>
      </div>
    </aside>
  `;
}

/** A compact preference action after acknowledgement; the explanation is shown only beforehand. */
export function TelemetrySettings({ draftPending = false } = {}) {
  const [status, update] = useTelemetryStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toggle = async () => {
    if (!status || busy || status.forcedDisabled || draftPending) return;
    const enabled = !status.configuredEnabled;
    setBusy(true);
    setError(null);
    try {
      const result = await patchAdminConfig({ telemetry: { enabled, acknowledged: true } });
      if (!result.ok) throw new Error("Preference not saved");
      update({ ...status, configuredEnabled: enabled, enabled: enabled && status.runtimeAllowed, acknowledged: true });
    } catch {
      setError("Your preference could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  if (!status) return null;
  const actions = html`
    <div class="telemetry-settings-actions">
      <button type="button" class="btn-secondary" disabled=${busy || status.forcedDisabled || draftPending} onClick=${toggle}>${busy ? "Saving…" : status.configuredEnabled ? "Disable telemetry" : "Enable telemetry"}</button>
      <a href=${TELEMETRY_DOCS} target="_blank" rel="noopener noreferrer">Telemetry documentation ↗</a>
    </div>
  `;
  if (status.acknowledged) return html`
    <section class="telemetry-preference" aria-label="Installation telemetry">
      ${status.forcedDisabled && html`<p>Reporting is disabled by <code>OMNESIS_TELEMETRY</code>.</p>`}
      ${error && html`<p class="telemetry-error" role="alert">${error}</p>`}
      ${draftPending && html`<p>Save or discard your configuration draft before changing this preference.</p>`}
      ${actions}
    </section>
  `;
  return html`
    <section class="telemetry-settings" aria-label="Installation telemetry">
      <div>
        <h2>Installation telemetry</h2>
        <p>Minimal installation statistics, once a day, with an identifier that changes monthly. Personal content is never included.</p>
        ${status?.forcedDisabled
          ? html`<p>Reporting is disabled by <code>OMNESIS_TELEMETRY</code>. The environment setting takes precedence over configuration.</p>`
          : status && !status.runtimeAllowed
          ? html`<p>Reporting is unavailable in this development or test gateway.</p>`
          : status && html`<p>Reporting is <strong>${status.enabled ? "enabled" : "disabled"}</strong>.</p>`}
        ${error && html`<p class="telemetry-error" role="alert">${error}</p>`}
        ${draftPending && html`<p>Save or discard your configuration draft before changing this preference.</p>`}
      </div>
      ${actions}
    </section>
  `;
}
