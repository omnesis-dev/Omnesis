// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useRelayManagement } from "../lib/use-relay-management.js";
import { relayError, relayTime, relayCertificateKind, relayHttpsUrl, relayRecoveryLabel, relayMonitorLabel } from "../lib/cloud-relay-api.js";

function StatusCard({ title, state, error, children }) {
  return html`<section class="relay-card"><h3>${title}</h3><p class="relay-state">${state}</p>${children}${error && html`<p class="relay-warning">${relayError(error)}</p>`}</section>`;
}

export function RelayView() {
  const { status, error, busy, run } = useRelayManagement();
  const [publicOrigin, setPublicOrigin] = useState("");
  const [directory, setDirectory] = useState("");
  const [terms, setTerms] = useState(false);
  const [invitation, setInvitation] = useState("");
  const populated = useRef(false);
  useEffect(() => {
    if (!status || populated.current) return;
    populated.current = true;
    setPublicOrigin(status.config.publicOrigin ?? "");
    setDirectory(status.config.acmeDirectoryUrl ?? "");
    setTerms(status.config.termsAccepted);
  }, [status]);
  const directIdentity = status?.identities?.find(identity => identity.id === "direct");
  const termsUrl = relayHttpsUrl(status?.config.acmeTermsUrl);
  const linkOrigin = relayHttpsUrl(status?.google.linkOrigin);
  const linkHere = !linkOrigin || new URL(linkOrigin).origin === window.location?.origin;
  const enrolled = status?.enrollment.state === "enrolled";
  const showInvitation = status?.config.invitationRequired && !enrolled;
  const configure = event => {
    event.preventDefault();
    void run("configure", { ...(publicOrigin.trim() ? { publicOrigin: publicOrigin.trim() } : {}), ...(directory.trim() ? { acmeDirectoryUrl: directory.trim() } : {}), termsAccepted: terms });
  };
  const enable = event => {
    event.preventDefault();
    const value = invitation.trim();
    setInvitation("");
    void run("enable", value ? { invitation: value } : {});
  };
  return html`<div class="relay-view">
    <header class="relay-intro"><div><span class="relay-eyebrow">EXPERIMENTAL · OPTIONAL</span><h2>Cloud relay</h2><p>Reach this gateway away from home. The gateway keeps the encryption keys; the relay forwards encrypted traffic. Direct connections and QR pairing remain available.</p></div><button type="button" class="btn-secondary" disabled=${Boolean(busy)} onClick=${() => run()}>Refresh status</button></header>
    ${error && html`<p role="alert" class="relay-warning">${error}</p>`}
    <div aria-live="polite" class="relay-progress">${busy && busy !== "refresh" ? "Updating relay status…" : ""}</div>
    ${!status ? html`<p>${busy ? "Loading relay settings…" : "Relay settings are unavailable. Refresh status to retry."}</p>` : html`
      <div class="relay-summary"><span class=${`relay-pill ${status.enabled ? "relay-pill-enabled" : ""}`}>${status.enabled ? "Enabled" : "Disabled"}</span><span>Google sign-in: ${status.google.configured ? "available (optional)" : "not configured (optional)"}</span></div>
      <div class="relay-cards">
        <${StatusCard} title="Gateway identity" state=${status.hostname ?? "Hostname not assigned"}>
          <dl><dt>Gateway ID</dt><dd class="relay-mono">${status.gatewayId ?? "Generated when you save settings"}</dd><dt>Public gateway</dt><dd class="relay-mono">${status.publicOrigin ?? "Not assigned"}</dd></dl>
        <//>
        <${StatusCard} title="Enrollment" state=${status.enrollment.state} error=${status.enrollment.error}><p>${enrolled ? "This gateway is enrolled with its stable gateway identity. Reconnecting preserves existing device grants." : "Save settings to create a stable gateway identity. If the relay requires an invitation, request one for the gateway ID shown here."}</p><//>
        <${StatusCard} title="Relay connection" state=${status.tunnel.state} error=${status.tunnel.lastError}><dl><dt>Last connected</dt><dd>${relayTime(status.tunnel.lastConnectedAt)}</dd></dl><button class="btn-secondary" disabled=${Boolean(busy) || !status.can.reconnect} onClick=${() => run("reconnect")}>Reconnect</button><//>
      <section class="relay-card relay-public"><h3>External MCP clients</h3><p>${status.publicMcp.ready ? "Public certificate and endpoint verified." : "Public access is not ready. Enrollment, a connected tunnel, and a valid public certificate are required."}</p>${status.publicMcp.lastError && html`<p class="relay-warning">${relayError(status.publicMcp.lastError)}</p>`}${status.publicMcp.url && html`<code class="relay-mono">${status.publicMcp.url}</code>`}<p>Google sign-in can help devices find the gateway; it never replaces pairing and your approval.</p></section>
        <${StatusCard} title="Direct/default certificate" state=${directIdentity?.state ?? status.directCertificate?.state ?? "unavailable"}>
          <dl><dt>Certificate type</dt><dd>${directIdentity?.label ?? relayCertificateKind(directIdentity?.kind)}</dd><dt>Certificate names</dt><dd class="relay-mono">${directIdentity?.names.join(", ") ?? "Existing direct gateway identity"}</dd><dt>Expires</dt><dd>${relayTime(directIdentity?.expiresAt ?? status.directCertificate?.expiresAt)}</dd></dl><p>Existing direct device trust stays in place. This certificate is managed independently from the relay/public certificate.</p>
        <//>
        <${StatusCard} title="Relay/public certificate" state=${status.certificate.state} error=${status.certificate.lastError}><dl><dt>Expires</dt><dd>${relayTime(status.certificate.expiresAt)}</dd><dt>Last renewed</dt><dd>${relayTime(status.certificate.lastRenewedAt)}</dd></dl>${status.certificate.lastError === "certificate-renewal-failed" && ["valid", "expiring"].includes(status.certificate.state) && html`<p>The current certificate remains valid until its expiry. Use Renew certificate to retry before it expires.</p>`}<button class="btn-secondary" disabled=${Boolean(busy) || !status.can.renew} onClick=${() => run("renew")}>Renew certificate</button><//>
      </div>

      ${status.recovery && html`<section class="relay-card"><h3>Gateway recovery receipt</h3><p class="relay-state">${relayRecoveryLabel(status.recovery.receipt)}</p>${status.recovery.expiresAt && html`<p>Artifact expires: ${relayTime(status.recovery.expiresAt)}</p>`}<p>This describes a local recovery artifact. It does not verify the authority signature or the relay’s current revocation policy. The relay checks those independently before recovery.</p></section>`}
      ${status.certificateMonitor && html`<section class="relay-card"><h3>Certificate issuance monitoring</h3><p class="relay-state">${relayMonitorLabel(status.certificateMonitor.state)}</p>${status.certificateMonitor.lastError && html`<p role="alert" class="relay-warning">${relayError(status.certificateMonitor.lastError)}</p>`}<p>Monitoring uses independent public Certificate Transparency observations. A completed check covers the provider’s returned observations; it does not prove that every certificate is safe or that all issuance has been observed.</p>${status.certificateMonitor.state === "disabled" && html`<p>Monitoring is off. An installation administrator can opt in to the independent provider.</p>`}<dl><dt>Last completed observations</dt><dd>${relayTime(status.certificateMonitor.lastCompletedAt)}</dd></dl>${(status.certificateMonitor.incidents ?? []).map(incident => html`<article class="relay-warning"><h4>Unexpected certificate key</h4><dl><dt>Gateway hostname</dt><dd class="relay-mono">${incident.hostname}</dd><dt>Observed public key</dt><dd class="relay-mono">${incident.spkiFingerprint}</dd><dt>Certificate fingerprint</dt><dd class="relay-mono">${incident.certificateFingerprint}</dd><dt>Issuer</dt><dd class="relay-mono">${incident.issuer}</dd><dt>Serial number</dt><dd class="relay-mono">${incident.serial}</dd><dt>Certificate valid from</dt><dd>${relayTime(incident.validFrom)}</dd><dt>Certificate expires</dt><dd>${relayTime(incident.validTo)}</dd><dt>First observed locally</dt><dd>${relayTime(incident.observedAt)}</dd><dt>Provider record</dt><dd class="relay-mono">${incident.providerEntryId}</dd></dl></article>`)}<p>Incidents are advisory evidence. Monitoring never changes encryption trust, device permissions, or credentials automatically.</p></section>`}

      <section class="relay-card"><h3>Optional Google discovery</h3>
        <p>${status.google.linked ? "A Google discovery association is saved on this gateway. After a relay restart or rebuild, linking Google again may be needed to restore discovery. Existing paired devices continue working. Google sign-in still requires pairing and your approval before a device gains access." : "Link a Google account so your devices can find this gateway after signing in. Relay access and QR pairing work without Google."}</p>
        ${status.google.lastError && html`<p class="relay-warning">${relayError(status.google.lastError)}</p>`}
        ${!status.google.configured && html`<p>Google sign-in is unavailable for this installation. Relay connections and QR/manual pairing still work.</p>`}
        ${status.google.configured && !status.google.canLink && !status.google.canUnlink && html`<p>Account linking is currently unavailable. Relay access does not require a Google account.</p>`}
        ${status.google.canLink && (linkHere ? html`<button type="button" class="btn-secondary google-sign-in-button" disabled=${Boolean(busy)} onClick=${() => run("google/link")}><img src="/portal/img/google-sign-in-mark.png" width="20" height="20" alt="" aria-hidden="true" />Link Google account</button>` : html`<p>For secure browser pairing, open the gateway portal at the configured Google callback origin and sign in there.</p><a href=${new URL("/portal/settings/relay", linkOrigin).href}>Open gateway portal for Google linking</a>`)}
        ${status.google.canUnlink && html`<button type="button" class="btn-secondary" disabled=${Boolean(busy)} onClick=${() => run("google/unlink")}>Unlink Google account</button><p>Unlinking removes Google discovery. Existing device grants, relay access, and direct connections remain available.</p>`}
      </section>
      <div class="relay-forms">
        <form class="relay-card" onSubmit=${configure}><h3>1. Configure relay</h3><p>The relay service is provided by your installation. Save settings to prepare your gateway’s public identity.</p>${!status.serviceConfigured && html`<p role="status">${status.serviceError ? relayError(status.serviceError) : "Relay setup is unavailable. Ask the installation administrator to configure the service."}</p>`}
          <details><summary>Custom domain and certificate settings</summary><label>Public gateway origin (optional)<input type="url" maxLength="2048" placeholder="https://gateway.example.com" value=${publicOrigin} disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)} onInput=${e => setPublicOrigin(e.target.value)} /></label><label>ACME directory URL (optional)<input type="url" maxLength="2048" value=${directory} disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)} onInput=${e => setDirectory(e.target.value)} /></label><p>Leave the public origin empty to use a hostname assigned by the relay. Custom domains must point to the relay with TLS passthrough. Choose a hostname not already covered by your direct/default certificate.</p></details>
          ${termsUrl && html`<p><a href=${termsUrl} target="_blank" rel="noopener noreferrer">Read certificate authority terms</a></p>`}<label class="relay-check"><input type="checkbox" checked=${terms} disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)} onChange=${e => setTerms(e.target.checked)} /><span>I accept the configured certificate authority’s terms for automatic public certificates.</span></label><button class="btn-primary" disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)}>Save settings</button>
        </form>
        <form class="relay-card" onSubmit=${enable}><h3>2. Enable remote access</h3><p>${enrolled ? (status.enabled ? "This gateway is enrolled and remote access is enabled." : "This gateway is already enrolled. Enable relay to reconnect using its existing identity.") : (showInvitation ? "This relay requires an invitation bound to this gateway ID." : "Enable relay to enroll this gateway. Google sign-in is optional.")}</p>${showInvitation && html`<label>Relay invitation<input type="password" autoComplete="off" maxLength="8192" required value=${invitation} disabled=${Boolean(busy) || !status.can.enable} onInput=${e => setInvitation(e.target.value)} /></label><p>The invitation is sent once to this gateway and cleared from this form.</p>`}<div class="relay-actions"><button class="btn-primary" disabled=${Boolean(busy) || !status.can.enable}>Enable relay</button><button type="button" class="btn-secondary" disabled=${Boolean(busy) || !status.can.disable} onClick=${() => run("disable")}>Disable relay</button></div><p>Disabling stops relay forwarding and public certificate renewal. Gateway keys, device grants, and the public certificate remain available for already paired LAN devices. Direct TLS continues.</p></form>
      </div>
    `}
  </div>`;
}
