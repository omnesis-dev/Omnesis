// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// ReauthBanner — provider-level "needs reauth" surface on the Sources
// page. Replaces the per-row "run `cli -- sources reauth …`" hint with a
// single banner per affected provider+account that lists every sibling
// source and offers a button to drive the OAuth flow from the browser.
//
// Behaviour mirrors `cli reauth`:
//   1. Find sources in `needs-auth` state, group by providerId.
//   2. Show one banner per group with all affected source labels.
//   3. Clicking "Reauthenticate" opens a modal that runs the existing
//      `/admin/auth-flows` OAuth flow (same SSE-driven AuthStep
//      AddSourceModal uses).
//   4. On flow completion, verify the resolved account matches the
//      expected one, then call `/admin/sources/reauth-finalize` so the
//      collector re-instantiates every source under that provider+account
//      with the fresh credentials.

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  finalizeReauth,
  getCredentialsStatus,
  getSourceDescriptorsUnion,
  listDevices,
} from "../api.js";
import { sourceLabel } from "../lib/format.js";
import { AuthStep, useAuthFlow } from "../components/auth-flow.js";
import { CredentialsWizard } from "./credentials-wizard.js";
import {
  groupExpiringSourcesByProvider,
  groupNeedsAuthSourcesByProvider,
} from "./reauth-grouping.js";

/** Format an ISO deadline as a plain calendar date (e.g. "Jul 4, 2026"). */
function fmtConsentDate(iso) {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Whole days from now until the deadline (floored, never negative). */
function daysUntil(iso) {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((t - Date.now()) / 86_400_000));
}

/**
 * Renders one banner per (providerType, accountId, device) with at least
 * one entry in `needs-auth` state. Clicking "Reauthenticate" opens
 * `<ReauthModal>` which drives the OAuth flow on that device.
 *
 * Descriptors are fetched here (once, lazily) so both the banner title
 * and the modal can use the provider's canonical display name from
 * `defineProvider({ name })` — falling back to the capitalised
 * providerType only when descriptors haven't loaded yet. The device list
 * is fetched the same way so a lapse on one member of a multi-device
 * source can name that member: the source row only carries the owning
 * device's name, and the lapsed member may be a different device.
 */
export function ReauthBanner({ sources, onReauthed }) {
  const groups = useMemo(() => groupNeedsAuthSourcesByProvider(sources), [sources]);
  const [active, setActive] = useState(null);
  const [descriptors, setDescriptors] = useState(null);
  const [descLoadError, setDescLoadError] = useState(null);
  const [devices, setDevices] = useState(null);

  // Fetch descriptors lazily when at least one banner needs to render.
  // For the (common) zero-groups case, we skip the network call entirely.
  const hasGroups = groups.length > 0;
  useEffect(() => {
    if (!hasGroups) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await getSourceDescriptorsUnion();
        if (!cancelled) setDescriptors(res.items || []);
      } catch (e) {
        if (!cancelled) setDescLoadError(String(e?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [hasGroups]);

  // Only a member-scoped lapse names its device, and only when the source
  // row could not name it already; the device list is fetched just for that.
  const needsDeviceNames = groups.some((g) => g.memberScoped && !g.deviceName);
  useEffect(() => {
    if (!needsDeviceNames) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await listDevices();
        if (!cancelled) setDevices(res.items || []);
      } catch {
        // The banner falls back to the device id; the lapse is still surfaced.
      }
    })();
    return () => { cancelled = true; };
  }, [needsDeviceNames]);

  if (!hasGroups) return null;

  const providerNameOf = (providerType) =>
    descriptors?.find((d) => d.provider?.id === providerType)?.provider?.name ??
    capitalize(providerType);
  const deviceNameOf = (g) =>
    g.deviceName ??
    devices?.find((d) => d.id === g.deviceId)?.name ??
    (typeof g.deviceId === "string" ? g.deviceId.slice(0, 8) : "this device");

  // See #2737 — the account-id line below is opaque for a provider whose
  // account id is a platform handle rather than something the user recognises.
  return html`
    <div class="reauth-banner-stack">
      ${groups.map((g) => html`
        <div class="sources-banner-v2 needs-auth" key=${`${g.providerType}:${g.accountId}:${g.deviceId ?? ""}`}>
          <div class="reauth-banner-text">
            <strong>${providerNameOf(g.providerType)} needs to be re-authenticated</strong>
            <span class="reauth-banner-account">${g.accountId}</span>
            ${g.memberScoped && html`
              <span class="reauth-banner-account">Sign in again on ${deviceNameOf(g)}</span>
            `}
            <div class="reauth-banner-sources">
              ${g.affectedSourceIds.length} source${g.affectedSourceIds.length === 1 ? "" : "s"} affected:${" "}
              ${g.affectedSourceIds.map((id, i) => html`
                <span class="reauth-banner-src" key=${id}>
                  ${i > 0 ? ", " : ""}${sourceLabel(id)}
                </span>
              `)}
            </div>
          </div>
          <button class="btn-primary reauth-banner-btn" onClick=${() => setActive(g)}>
            Reauthenticate
          </button>
        </div>
      `)}
      ${active && html`<${ReauthModal}
        group=${active}
        descriptors=${descriptors}
        descLoadError=${descLoadError}
        providerName=${providerNameOf(active.providerType)}
        onClose=${() => setActive(null)}
        onDone=${async () => {
          setActive(null);
          await onReauthed?.();
        }}
      />`}
    </div>
  `;
}

/**
 * ExpiringBanner — forward-looking consent-expiry surface (#927). Renders one
 * non-blocking yellow banner per (providerType, accountId) with a source in the
 * derived `auth-expiring` state: the source is still syncing fine, but its
 * authorization expires soon and the operator should reconnect ahead of the
 * deadline to avoid a future `needs-auth`. Distinct from the red needs-auth
 * banner. "Reauthenticate" routes through the SAME auth flow as needs-auth —
 * `accountId` set so the provider re-enters its existing connection (e.g. Plaid
 * Link update mode) rather than adding a new one.
 */
export function ExpiringBanner({ sources, onReauthed }) {
  const groups = useMemo(() => groupExpiringSourcesByProvider(sources), [sources]);
  const [active, setActive] = useState(null);
  const [descriptors, setDescriptors] = useState(null);
  const [descLoadError, setDescLoadError] = useState(null);

  const hasGroups = groups.length > 0;
  useEffect(() => {
    if (!hasGroups) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await getSourceDescriptorsUnion();
        if (!cancelled) setDescriptors(res.items || []);
      } catch (e) {
        if (!cancelled) setDescLoadError(String(e?.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [hasGroups]);

  if (!hasGroups) return null;

  const providerNameOf = (providerType) =>
    descriptors?.find((d) => d.provider?.id === providerType)?.provider?.name ??
    capitalize(providerType);

  return html`
    <div class="reauth-banner-stack">
      ${groups.map((g) => {
        const days = daysUntil(g.consentExpiresAt);
        const when = fmtConsentDate(g.consentExpiresAt);
        return html`
          <div class="sources-banner-v2 auth-expiring" key=${`${g.providerType}:${g.accountId}:${g.deviceId ?? ""}`}>
            <div class="reauth-banner-text">
              <strong>
                ${providerNameOf(g.providerType)} ${days != null
                  ? `expires in ${days} day${days === 1 ? "" : "s"} — reconnect to keep syncing`
                  : "connection expires soon — reconnect to keep syncing"}
              </strong>
              <span class="reauth-banner-account">${g.accountId}</span>
              ${when && html`<span class="reauth-banner-expiry">Expires on ${when}</span>`}
            </div>
            <button class="btn-primary reauth-banner-btn" onClick=${() => setActive(g)}>
              Reauthenticate
            </button>
          </div>
        `;
      })}
      ${active && html`<${ReauthModal}
        group=${active}
        descriptors=${descriptors}
        descLoadError=${descLoadError}
        providerName=${providerNameOf(active.providerType)}
        onClose=${() => setActive(null)}
        onDone=${async () => {
          setActive(null);
          await onReauthed?.();
        }}
      />`}
    </div>
  `;
}

/**
 * Modal that runs the OAuth flow for a single provider+account group and
 * finalises the reauth on success. Uses the same AuthStep + useAuthFlow
 * pair as AddSourceModal so the OAuth/QR/device-code rendering stays
 * consistent.
 */
function ReauthModal({ group, descriptors, descLoadError, providerName, onClose, onDone }) {
  const [phase, setPhase] = useState("auth"); // auth | finalizing | done | error | mismatched | wizard
  const [errorMessage, setErrorMessage] = useState(null);
  const [resolvedAccountId, setResolvedAccountId] = useState(null);
  const [credsEntry, setCredsEntry] = useState(null);
  /**
   * Credential threaded into the next auth attempt. Held on a ref rather than
   * state: it is written and read within one event, and a state setter would
   * not have applied by the time the effect below starts the flow.
   */
  const pendingCredentialsRef = useRef(undefined);

  const descriptor = useMemo(() => {
    if (!descriptors) return null;
    return descriptors.find((d) => d.id === group.driverSourceType) ?? null;
  }, [descriptors, group.driverSourceType]);

  const { authState, start, cancel, reset } = useAuthFlow({
    deviceId: group.deviceId,
    onAccount: async (accountId) => {
      // The user might have signed in to a DIFFERENT account in the
      // browser (e.g. another Google account on the same machine). We
      // wrote fresh tokens to *that* account's directory, leaving the
      // original (still-broken) account untouched. Surface it so the
      // user can retry rather than silently doing the wrong thing.
      if (accountId !== group.accountId) {
        setResolvedAccountId(accountId);
        setPhase("mismatched");
        return;
      }
      setPhase("finalizing");
      try {
        await finalizeReauth({
          deviceId: group.deviceId,
          providerType: group.providerType,
          accountId: group.accountId,
        });
        setPhase("done");
      } catch (e) {
        setErrorMessage(String(e?.message || e));
        setPhase("error");
      }
    },
    onError: (msg) => {
      setErrorMessage(msg);
      setPhase("error");
    },
    onMissingCredentials: async ({ fileKey }) => {
      try {
        const status = await getCredentialsStatus(group.deviceId);
        const entry = (status.items || []).find((e) => e.fileKey === fileKey);
        if (entry) {
          setCredsEntry(entry);
          setPhase("wizard");
        } else {
          setErrorMessage(`Missing credentials for ${fileKey}.`);
          setPhase("error");
        }
      } catch (e) {
        setErrorMessage(String(e?.message || e));
        setPhase("error");
      }
    },
  });

  // Kick off the auth flow once we have a descriptor. `start` is a new
  // closure on every render; intentionally excluded from the dep array
  // so we don't re-fire after each setAuthState (the `!authState` guard
  // catches re-fires, but gating on inputs is cleaner).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!descriptor || phase !== "auth" || authState) return;
    // `accountId` tells the provider which existing account is being
    // re-authed (it can reuse stored per-account parameters).
    const credentials = pendingCredentialsRef.current;
    // Consumed once: a later retry re-collects rather than replaying a key
    // that may already have been rejected.
    pendingCredentialsRef.current = undefined;
    start({
      sourceType: group.driverSourceType,
      params: undefined,
      accountId: group.accountId,
      credentials,
    });
  }, [descriptor, phase, authState, group.driverSourceType]);

  async function handleClose() {
    await cancel();
    onClose?.();
  }

  function retry(credentials) {
    setErrorMessage(null);
    setResolvedAccountId(null);
    pendingCredentialsRef.current = credentials;
    reset();
    setPhase("auth");
  }

  // Escape closes the modal — matches AddSourceModal's behaviour so
  // users get one consistent dismiss key across both flows.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return html`
    <div class="add-source-backdrop" onClick=${handleClose}>
      <div class="add-source-modal" onClick=${(e) => e.stopPropagation()}>
        <div class="add-source-header">
          <div>
            <h3>Re-authenticate ${providerName}</h3>
            <div class="add-source-breadcrumb">${group.accountId}</div>
          </div>
          <button class="btn-tiny" onClick=${handleClose}>close</button>
        </div>

        <div class="add-source-body">
          ${descLoadError
            ? html`<div class="sources-banner-v2 error">${descLoadError}</div>`
            : descriptors && !descriptor
              ? html`<div class="sources-banner-v2 error">
                  The collector hosting this source is offline, so it cannot be re-authenticated right now.
                </div>`
              : !descriptor
                ? html`<div class="add-source-loading">Loading…</div>`
              : phase === "auth"
                ? html`<${AuthStep} descriptor=${descriptor} state=${authState} onCancel=${handleClose} />`
                : phase === "finalizing"
                  ? html`<div class="add-source-loading">Refreshing sources…</div>`
                  : phase === "done"
                    ? html`
                      <div class="add-source-form">
                        <div class="sources-banner-v2 info">
                          <strong>${providerName} re-authenticated.</strong>${" "}
                          ${group.affectedSourceIds.length} source${group.affectedSourceIds.length === 1 ? "" : "s"} will resume on the next sync.
                        </div>
                        <div class="add-source-actions">
                          <button class="btn-primary" onClick=${onDone}>Done</button>
                        </div>
                      </div>
                    `
                    : phase === "mismatched"
                      ? html`
                        <div class="add-source-form">
                          <div class="sources-banner-v2 error">
                            <strong>Wrong account.</strong>
                            You signed in as <code>${resolvedAccountId}</code> but this banner is for <code>${group.accountId}</code>. Fresh tokens were written for the new account; the original still needs re-auth.
                          </div>
                          <div class="add-source-actions">
                            <button class="btn-tiny" onClick=${() => retry()}>Try again</button>
                            <button class="btn-tiny" onClick=${handleClose}>Close</button>
                          </div>
                        </div>
                      `
                      : phase === "error"
                        ? html`
                          <div class="add-source-form">
                            <div class="sources-banner-v2 error">${errorMessage || "Something went wrong."}</div>
                            <div class="add-source-actions">
                              <button class="btn-tiny" onClick=${() => retry()}>Try again</button>
                              <button class="btn-tiny" onClick=${handleClose}>Close</button>
                            </div>
                          </div>
                        `
                        : null}
        </div>
      </div>
      ${phase === "wizard" && credsEntry && html`<${CredentialsWizard}
        entry=${credsEntry}
        deviceId=${group.deviceId}
        collectOnly=${!!credsEntry.spec?.perAccount}
        onClose=${(updated, fields) => {
          setCredsEntry(null);
          if (updated) {
            // Resume the auth flow. A per-account credential was not saved —
            // it rides along so the provider can store it under the account
            // its probe resolves.
            retry(fields);
          } else {
            onClose?.();
          }
        }}
      />`}
    </div>
  `;
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
