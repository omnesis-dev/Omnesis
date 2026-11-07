// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useRelayManagement } from "../lib/use-relay-management.js";
import { relayError, relayTime, relayCertificateKind, relayHttpsUrl, relayRecoveryLabel, relayMonitorLabel } from "../lib/cloud-relay-api.js";

function StatusSection({ title, state, error, children }) {
  return html`<section class="relay-detail-section"><h3>${title}</h3><p class="relay-state">${state}</p>${children}${error && html`<p class="relay-warning">${relayError(error)}</p>`}</section>`;
}

export function RelayView() {
  const { status, error, busy, run } = useRelayManagement();
  const [copyResult, setCopyResult] = useState("");
  const [publicOrigin, setPublicOrigin] = useState("");
  const [directory, setDirectory] = useState("");
  const [terms, setTerms] = useState(false);
  const [invitation, setInvitation] = useState("");
  const populated = useRef(false);
  const setup = useRef(null);
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
  const copyMcp = async () => {
    try {
      await navigator.clipboard.writeText(status.publicMcp.url);
      setCopyResult("Copied");
    } catch {
      setCopyResult("Select and copy the address above.");
    }
  };
  return html`<div class="relay-view">
    <header class="relay-intro"><div><span class="relay-eyebrow">EXPERIMENTAL · OPTIONAL</span><h2>Cloud relay</h2><p>Connect securely from anywhere. Your gateway keeps the encryption keys. Direct connections and QR pairing remain available.</p></div><button type="button" class="btn-secondary" disabled=${Boolean(busy)} onClick=${() => run()}>Refresh status</button></header>
    ${error && html`<p role="alert" class="relay-warning">${error}</p>`}
    ${busy && busy !== "refresh" && html`<p role="status" class="relay-progress">Updating relay status…</p>`}
    ${!status ? html`<p>${busy ? "Loading relay settings…" : "Relay settings are unavailable. Refresh status to retry."}</p>` : html`
      ${[status.enrollment.error, status.tunnel.lastError, status.certificate.lastError, status.publicMcp.lastError, status.certificateMonitor?.lastError].filter(Boolean).map(code => html`<p role="alert" class="relay-warning">${relayError(code)}</p>`)}
      ${status.certificate.state === "expiring" && html`<p role="status" class="relay-warning">Your public certificate expires soon. Review security and connection details below.</p>`}
      ${status.certificateMonitor?.incidents?.length > 0 && html`<p role="alert" class="relay-warning">An unexpected certificate key was observed. Review security and connection details below.</p>`}
      <div class="relay-settings-list">
        <section class="relay-setting-row"><h3>Remote access</h3><div class="relay-setting-body"><p class=${`relay-connection ${status.tunnel.state === "online" ? "relay-connection-online" : ""}`}>${status.enabled ? (status.tunnel.state === "online" ? "Connected" : status.tunnel.state) : "Disabled"}</p><p>${status.enabled ? (status.tunnel.state === "online" ? "Your gateway is available through an encrypted connection." : "Waiting for an encrypted connection.") : (enrolled ? "This gateway is already enrolled. Enable relay to reconnect using its existing identity." : "Set up remote access to connect away from home.")}</p></div><div class="relay-setting-action">${status.enabled && html`<button type="button" class="btn-secondary relay-action-quiet" disabled=${Boolean(busy) || !status.can.disable} onClick=${() => run("disable")}>Disable relay</button>`}${!status.enabled && (enrolled ? html`<button type="button" class="btn-secondary" disabled=${Boolean(busy) || !status.can.enable} onClick=${() => run("enable", {})}>Enable relay</button>` : html`<button type="button" class="btn-secondary" disabled=${Boolean(busy)} onClick=${() => { setup.current.open = true; setup.current.querySelector("summary").focus(); }}>Set up remote access</button>`)}</div></section>
        <section class="relay-setting-row"><h3>Google account<span class="relay-optional">Optional</span></h3><div class="relay-setting-body"><p class="relay-setting-value">${status.google.linked ? "Google account linked" : (status.google.configured ? "Not linked" : "Not configured")}</p><p>${status.google.linked ? "Your devices can find this gateway after Google sign-in." : "Link an account to find this gateway on your other devices. QR pairing works without Google."}</p>
          ${status.google.lastError && html`<p class="relay-warning">${relayError(status.google.lastError)}</p>`}
          ${!status.google.configured && html`<p>Google sign-in is unavailable for this installation. Relay connections and QR/manual pairing still work.</p>`}
          ${status.google.configured && !status.google.canLink && !status.google.canUnlink && html`<p>Account linking is currently unavailable. Relay access does not require a Google account.</p>`}

        </div><div class="relay-setting-action">
          ${!status.google.linked && status.google.canLink && (linkHere ? html`<button type="button" class="btn-secondary google-sign-in-button" disabled=${Boolean(busy)} onClick=${() => run("google/link")}><img src="/portal/img/google-sign-in-mark.png" width="20" height="20" alt="" aria-hidden="true" />Link Google account</button>` : html`<a href=${new URL("/portal/settings/relay", linkOrigin).href}>Open gateway portal for Google linking</a>`)}
          ${status.google.linked && status.google.canUnlink && html`<button type="button" class="btn-secondary relay-action-quiet" disabled=${Boolean(busy)} onClick=${() => run("google/unlink")}>Unlink Google account</button>`}
        </div></section>
        <section class="relay-setting-row relay-public"><h3>Connect an external app</h3><div class="relay-setting-body"><p class="relay-setting-value">${status.publicMcp.ready ? "Ready" : "Not ready"}</p><p>Use this address in ChatGPT or another MCP client.</p><p>${status.publicMcp.ready ? "Public certificate and endpoint verified." : "Public access is not ready. Enrollment, a connected tunnel, and a valid public certificate are required."}</p>${status.publicMcp.url && html`<code class="relay-mono relay-endpoint">${status.publicMcp.url}</code>`}<p aria-live="polite" class="relay-copy-result">${copyResult}</p></div><div class="relay-setting-action">${status.publicMcp.url && html`<button type="button" class="btn-secondary" disabled=${Boolean(busy)} onClick=${() => { void copyMcp(); }}>Copy MCP address</button>`}</div></section>
      </div>
      <details class="relay-disclosure"><summary>Security and connection details</summary>
      <div class="relay-details-list">
        <${StatusSection} title="Gateway identity" state=${status.hostname ?? "Hostname not assigned"}>
          <dl><dt>Gateway ID</dt><dd class="relay-mono">${status.gatewayId ?? "Generated when you save settings"}</dd><dt>Public gateway</dt><dd class="relay-mono">${status.publicOrigin ?? "Not assigned"}</dd></dl>
        <//>
        <${StatusSection} title="Enrollment" state=${status.enrollment.state} error=${status.enrollment.error}><p>${enrolled ? "This gateway is enrolled with its stable gateway identity. Reconnecting preserves existing device grants." : "Save settings to create a stable gateway identity. If the relay requires an invitation, request one for the gateway ID shown here."}</p><//>
        <${StatusSection} title="Relay connection" state=${status.tunnel.state} error=${status.tunnel.lastError}><dl><dt>Last connected</dt><dd>${relayTime(status.tunnel.lastConnectedAt)}</dd></dl><button class="btn-secondary" disabled=${Boolean(busy) || !status.can.reconnect} onClick=${() => run("reconnect")}>Reconnect</button><//>

        <${StatusSection} title="Direct/default certificate" state=${directIdentity?.state ?? status.directCertificate?.state ?? "unavailable"}>
          <dl><dt>Certificate type</dt><dd>${directIdentity?.label ?? relayCertificateKind(directIdentity?.kind)}</dd><dt>Certificate names</dt><dd class="relay-mono">${directIdentity?.names.join(", ") ?? "Existing direct gateway identity"}</dd><dt>Expires</dt><dd>${relayTime(directIdentity?.expiresAt ?? status.directCertificate?.expiresAt)}</dd></dl><p>Existing direct device trust stays in place. This certificate is managed independently from the relay/public certificate.</p>
        <//>
        <${StatusSection} title="Relay/public certificate" state=${status.certificate.state} error=${status.certificate.lastError}><dl><dt>Expires</dt><dd>${relayTime(status.certificate.expiresAt)}</dd><dt>Last renewed</dt><dd>${relayTime(status.certificate.lastRenewedAt)}</dd></dl>${status.certificate.lastError === "certificate-renewal-failed" && ["valid", "expiring"].includes(status.certificate.state) && html`<p>The current certificate remains valid until its expiry. Use Renew certificate to retry before it expires.</p>`}<button class="btn-secondary" disabled=${Boolean(busy) || !status.can.renew} onClick=${() => run("renew")}>Renew certificate</button><//>
      </div>

      ${status.recovery && html`<section class="relay-detail-section"><h3>Gateway recovery receipt</h3><p class="relay-state">${relayRecoveryLabel(status.recovery.receipt)}</p>${status.recovery.expiresAt && html`<p>Artifact expires: ${relayTime(status.recovery.expiresAt)}</p>`}<p>This describes a local recovery artifact. It does not verify the authority signature or the relay’s current revocation policy. The relay checks those independently before recovery.</p></section>`}
      ${status.certificateMonitor && html`<section class="relay-detail-section"><h3>Certificate issuance monitoring</h3><p class="relay-state">${relayMonitorLabel(status.certificateMonitor.state)}</p>${status.certificateMonitor.lastError && html`<p role="alert" class="relay-warning">${relayError(status.certificateMonitor.lastError)}</p>`}<p>Monitoring uses independent public Certificate Transparency observations. A completed check covers the provider’s returned observations; it does not prove that every certificate is safe or that all issuance has been observed.</p>${status.certificateMonitor.state === "disabled" && html`<p>Monitoring is off. An installation administrator can opt in to the independent provider.</p>`}<dl><dt>Last completed observations</dt><dd>${relayTime(status.certificateMonitor.lastCompletedAt)}</dd></dl>${(status.certificateMonitor.incidents ?? []).map(incident => html`<article class="relay-warning"><h4>Unexpected certificate key</h4><dl><dt>Gateway hostname</dt><dd class="relay-mono">${incident.hostname}</dd><dt>Observed public key</dt><dd class="relay-mono">${incident.spkiFingerprint}</dd><dt>Certificate fingerprint</dt><dd class="relay-mono">${incident.certificateFingerprint}</dd><dt>Issuer</dt><dd class="relay-mono">${incident.issuer}</dd><dt>Serial number</dt><dd class="relay-mono">${incident.serial}</dd><dt>Certificate valid from</dt><dd>${relayTime(incident.validFrom)}</dd><dt>Certificate expires</dt><dd>${relayTime(incident.validTo)}</dd><dt>First observed locally</dt><dd>${relayTime(incident.observedAt)}</dd><dt>Provider record</dt><dd class="relay-mono">${incident.providerEntryId}</dd></dl></article>`)}<p>Incidents are advisory evidence. Monitoring never changes encryption trust, device permissions, or credentials automatically.</p></section>`}

      </details>
      <details class="relay-disclosure relay-setup" ref=${setup} open=${!enrolled || !status.enabled}><summary>${enrolled && status.enabled ? "Advanced settings" : "Remote access setup"}</summary>
      <div class="relay-forms">
        <form class="relay-detail-section" onSubmit=${configure}><h3>Domain and certificate configuration</h3><p>The relay service is provided by your installation. Save settings to prepare your gateway’s public identity.</p>${!status.serviceConfigured && html`<p role="status">${status.serviceError ? relayError(status.serviceError) : "Relay setup is unavailable. Ask the installation administrator to configure the service."}</p>`}
          <details><summary>Custom domain and certificate settings</summary><label>Public gateway origin (optional)<input type="url" maxLength="2048" placeholder="https://gateway.example.com" value=${publicOrigin} disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)} onInput=${e => setPublicOrigin(e.target.value)} /></label><label>ACME directory URL (optional)<input type="url" maxLength="2048" value=${directory} disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)} onInput=${e => setDirectory(e.target.value)} /></label><p>Leave the public origin empty to use a hostname assigned by the relay. Custom domains must point to the relay with TLS passthrough. Choose a hostname not already covered by your direct/default certificate.</p></details>
          ${termsUrl && html`<p><a href=${termsUrl} target="_blank" rel="noopener noreferrer">Read certificate authority terms</a></p>`}<label class="relay-check"><input type="checkbox" checked=${terms} disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)} onChange=${e => setTerms(e.target.checked)} /><span>I accept the configured certificate authority’s terms for automatic public certificates.</span></label><button class="btn-primary" disabled=${Boolean(busy) || (!status.serviceConfigured || !status.can.configure)}>Save settings</button>
        </form>
        ${!enrolled && html`<form class="relay-detail-section" onSubmit=${enable}><h3>Remote access setup</h3><p>${showInvitation ? "This relay requires an invitation bound to this gateway ID." : "Enable relay to enroll this gateway. Google sign-in is optional."}</p>${showInvitation && html`<label>Relay invitation<input type="password" autoComplete="off" maxLength="8192" required value=${invitation} disabled=${Boolean(busy) || !status.can.enable} onInput=${e => setInvitation(e.target.value)} /></label><p>The invitation is sent once to this gateway and cleared from this form.</p>`}<div class="relay-actions"><button class="btn-primary" disabled=${Boolean(busy) || !status.can.enable}>Enable relay</button></div><p>Disabling stops relay forwarding and public certificate renewal. Gateway keys, device grants, and the public certificate remain available for already paired LAN devices. Direct TLS continues.</p></form>`}
      </div>
        ${status.google.linked && html`<section class="relay-detail-section"><h3>Google discovery recovery</h3><p>A Google discovery association is saved on this gateway. After a relay rebuild, linking Google again may be needed to restore discovery. Existing paired devices continue working.</p><p>Unlinking removes Google discovery. Existing device grants, relay access, and direct connections remain available.</p>${status.google.canLink && linkHere && html`<button type="button" class="btn-secondary google-sign-in-button" disabled=${Boolean(busy)} onClick=${() => run("google/link")}><img src="/portal/img/google-sign-in-mark.png" width="20" height="20" alt="" aria-hidden="true" />Refresh Google discovery</button>`}</section>`}
      </details>
    `}
  </div>`;
}
