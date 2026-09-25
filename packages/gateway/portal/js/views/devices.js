// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Devices view — the Devices tab of the Settings page: manage everything
// connected to the gateway (collectors, CLI, portal, iOS, Android, agents).
// Pair new devices, revoke devices and their credentials.

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";
import {
  listDevices,
  pairDevice,
  revokeDevice,
  forgetDevice,
  listTokens,
  revokeTokenById,
  getNetworkIdentities,
  getPairAddresses,
  buildPairQrPayload,
  fleetUpdateTarget,
  getFleetDoctor,
  requestFleetDoctor,
  requestFleetUpdate,
  withdrawRelayPushConsent,
  whoami,
  getAccessOverview,
  setDeviceAccessLevel,
} from "../api.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { navigate } from "../lib/router.js";
import { accessLevels, accessRules, errorMessage, overviewPolicies } from "./access/shared.js";
import { answerPrivacySummary, reachSummary } from "./access/terms.js";
import { CHROME_WEB_STORE_URL } from "../lib/extension-links.js";
import { KindIcon } from "../lib/device-kind-icon.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { DoctorReportView } from "./doctor.js";
import {
  currentDeviceIdForKind,
  groupDevices,
  liveConnectionCount,
  needsPairingCount,
  relativeTime,
  revokedCount,
  statusLine,
} from "../lib/device-grouping.js";

/**
 * Pairable device kinds, in the order the picker offers them. `agent` is an
 * external harness (OpenClaw, Hermes) provisioned by `omnesis connect`;
 * `integration` is third-party code that asks questions under the access level
 * it is put on.
 */
const DEVICE_KINDS = ["collector", "cli", "portal", "ios", "android", "agent", "integration", "browser"];

export function deviceKinds() {
  return DEVICE_KINDS;
}

/** Colour class for a scope pill: read-ish blue, admin-ish purple, write green. */
function scopeColorClass(scope) {
  if (scope === "admin") return "scope-admin";
  if (scope === "read") return "scope-read";
  return "scope-write";
}

/** A single scope rendered as a coloured monospace pill. */
function ScopeChip({ scope }) {
  return html`<span class=${`devices-scope ${scopeColorClass(scope)}`}>${scope}</span>`;
}

export function agentConnectCommands(gatewayUrl, code) {
  return [
    {
      label: "OpenClaw",
      command: `omnesis connect openclaw --gateway-url ${gatewayUrl} --code ${code}`,
    },
    {
      label: "Hermes",
      command: `omnesis connect hermes --gateway-url ${gatewayUrl} --code ${code}`,
    },
  ];
}

/** Explain the exact authority a device revoke removes without exposing ids. */
export function deviceCorpusCredentialImpact(device) {
  if (device.kind !== "agent") return { credentials: [], complete: true };
  const impact = device.revocationImpact;
  const currentFingerprint = impact?.fingerprint;
  const currentCredentials = impact?.corpusCredentials;
  const complete =
    Array.isArray(currentCredentials) &&
    typeof currentFingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(currentFingerprint);
  return {
    credentials: Array.isArray(currentCredentials) ? currentCredentials : impact?.corpusAccess ?? [],
    complete,
    ...(complete ? { fingerprint: currentFingerprint } : {}),
  };
}

export function DeviceRevocationImpact({ device }) {
  const impact = deviceCorpusCredentialImpact(device);
  const corpusCredentials = impact.credentials;
  const connectionsDescription = corpusCredentials.length === 1 ? "connection" : "connections";
  return html`
    <div class="devices-revocation-impact">
      <p>
        Its device tokens are invalidated and any live connection is closed. Its sources and their
        data stay put; pairing the same device again reclaims its identity.
      </p>
      ${corpusCredentials.length > 0 && html`
        <p>${`This also stops the ${connectionsDescription} signed in from this agent installation:`}</p>
        <ul>
          ${corpusCredentials.map((credential) => html`
            <li class="devices-revocation-grant">
              <strong>${credential.principalName}</strong>
              ${credential.credentialLabel && credential.credentialLabel !== credential.principalName
                ? html`<span>${credential.credentialLabel}</span>`
                : null}
            </li>
          `)}
        </ul>
        <p>Connections signed in from other installations are not affected.</p>
      `}
      ${!impact.complete && html`
        <p role="alert">
          This gateway cannot report every connection signed in from this agent. Update it before
          relying on this confirmation.
        </p>
      `}
    </div>
  `;
}

const KIND_LABELS = {
  collector: "Collector",
  cli: "CLI",
  portal: "Portal",
  ios: "iOS app",
  android: "Android app",
  agent: "Agent integration",
  integration: "Integration",
  browser: "Browser extension",
};


/**
 * ARIA menu keyboard navigation. Wired on the `role="menu"` container —
 * arrow keys cycle focus across the visible `role="menuitem"` buttons,
 * Home/End jump to the first/last, Escape closes the popover. Matches
 * the WAI-ARIA Authoring Practices recommendation for a vertical
 * `menu`.
 */
function handleMenuKeyNav(event, onClose) {
  const items = Array.from(event.currentTarget.querySelectorAll('[role="menuitem"]'));
  if (items.length === 0) return;
  const idx = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    items[(idx + 1 + items.length) % items.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    items[(idx - 1 + items.length) % items.length]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === "Escape" && onClose) {
    event.preventDefault();
    onClose();
  }
}

/**
 * Kebab (⋯) popover for per-device actions. Mirrors `SourceActionMenu`
 * on the Sources view — fixed-positioned so the popover escapes the
 * table wrapper's overflow clipping; flips above the trigger when there
 * isn't room below; closes on outside-click / Escape / scroll. Reuses
 * the `.source-action-*` styles which are layout-only, not source-
 * specific.
 */
function DeviceActionMenu({ onRepair, repairDisabled, onRevoke, onForget, onUpdate, revoked }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  function toggle() {
    if (open) { setOpen(false); return; }
    const rect = triggerRef.current.getBoundingClientRect();
    const menuH = 48; // approximate height of the single-item menu
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipped = spaceBelow < menuH && rect.top > menuH;
    const right = window.innerWidth - rect.right;
    setStyle(flipped
      ? { bottom: (window.innerHeight - rect.top + 4) + "px", right: right + "px" }
      : { top: (rect.bottom + 4) + "px", right: right + "px" });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onDocMouse = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const run = (fn) => () => { setOpen(false); fn(); };
  const styleStr = style ? Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";") : "";

  return html`
    <div class="source-action-menu">
      <button
        ref=${triggerRef}
        class="btn-tiny source-action-trigger"
        title="Actions"
        aria-label="Device actions"
        aria-haspopup="menu"
        aria-expanded=${open}
        onClick=${toggle}
      >⋯</button>
      ${open && html`
        <div ref=${menuRef} class="source-action-popover" role="menu" style=${styleStr}
          onKeyDown=${(e) => handleMenuKeyNav(e, () => setOpen(false))}>
          ${onUpdate && html`
            <button class="source-action-item" role="menuitem" onClick=${run(onUpdate)}>
              Update device
            </button>
          `}
          ${onRepair && html`
            <button
              class="source-action-item"
              role="menuitem"
              disabled=${repairDisabled}
              title=${repairDisabled ? "Stop or revoke this device before repairing it." : undefined}
              onClick=${run(onRepair)}
            >
              Repair device
            </button>
          `}
          ${!revoked && html`
            <button class="source-action-item danger" role="menuitem" onClick=${run(onRevoke)}>
              Revoke device
            </button>
          `}
          ${revoked && html`
            <button class="source-action-item danger" role="menuitem" onClick=${run(onForget)}>
              Forget device
            </button>
          `}
        </div>
      `}
    </div>
  `;
}

/**
 * Build a gateway URL rooted at `host` (IP, .local, or Tailscale name).
 * Falls back to the current origin when we can't figure out an identity.
 */
export function swapHostForUrl(origin, host) {
  try {
    const url = new URL(origin);
    url.hostname = host;
    return url.toString().replace(/\/$/, "");
  } catch {
    return origin;
  }
}

/** Resolve the operator-selected advertised identity for agent setup commands. */
export function agentGatewayUrl(origin, identities, selectedIdx) {
  const fallbackHost = (() => {
    try {
      return new URL(origin).hostname;
    } catch {
      return "";
    }
  })();
  const hosts = identities.length > 0
    ? identities
    : [{ address: fallbackHost, label: "This portal's host", kind: "portal", offLan: false }];
  const chosen = hosts[Math.min(Math.max(selectedIdx, 0), hosts.length - 1)];
  return chosen?.address ? swapHostForUrl(origin, chosen.address) : origin;
}

/**
 * The public docs on setting up away-from-home access. The gateway does not
 * serve the docs, so this is the published site, not a portal-relative path.
 */
const AWAY_FROM_HOME_DOCS_URL = "https://omnesis.dev/docs/setup#away-from-home";

/** What the pairing screen calls each phone. */
const PHONE_NOUNS = { ios: "iPhone", android: "Android phone" };

/**
 * A phone pairs by scanning a QR code that carries the pairing code, so the
 * code is not shown above it for phones; the "Can't scan the code?" section
 * gives it to a phone that cannot scan.
 */
function isPhoneKind(kind) {
  return kind === "ios" || kind === "android";
}

/**
 * The pairing QR for a phone. The gateway judges every address it could put
 * in the code for the phone the code was minted for
 * (`POST /admin/devices/pair-addresses`) and encodes the chosen one
 * (`POST /admin/devices/pair-qr`), so this screen only ever shows a code that
 * phone can use. It opens on the gateway's recommendation, says where that
 * address works, and offers the other usable addresses; addresses that phone
 * refuses are named with the reason instead of being offered.
 */
function PhonePairQr({ pairingCode, kind }) {
  const canvasRef = useRef(null);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState(null);
  const [selectedUrl, setSelectedUrl] = useState(null);
  const [payload, setPayload] = useState(null);
  const [qrError, setQrError] = useState(null);
  const phone = PHONE_NOUNS[kind];

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    setSelectedUrl(null);
    getPairAddresses({ pairingCode })
      .then((res) => {
        if (cancelled) return;
        setPlan(res);
        setSelectedUrl(res.recommendedUrl);
      })
      .catch((err) => {
        if (!cancelled) setPlanError(errorMessage(err, "The gateway didn't answer. Try again."));
      });
    return () => {
      cancelled = true;
    };
  }, [pairingCode]);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setQrError(null);
    if (!selectedUrl) return undefined;
    buildPairQrPayload({ pairingCode, gatewayUrl: selectedUrl })
      .then((res) => {
        if (!cancelled) setPayload(res.qrPayload);
      })
      .catch((err) => {
        if (!cancelled) setQrError(errorMessage(err, "The gateway didn't answer. Try again."));
      });
    return () => {
      cancelled = true;
    };
  }, [pairingCode, selectedUrl]);

  useEffect(() => {
    if (!canvasRef.current || !payload) return undefined;
    // QR contrast must follow the page: dark modules on white in light mode,
    // an inverted light-on-dark code that sits on the dark page otherwise.
    // Redraw on a theme flip so an open pairing dialog stays scannable.
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const isLight = document.documentElement.dataset.theme === "light";
      // Level L — Baileys-style payloads are a couple hundred bytes; more
      // error correction forces a larger QR that doesn't fit the modal.
      QRCode.toCanvas(canvas, payload, {
        width: 240,
        margin: 2,
        errorCorrectionLevel: "L",
        color: isLight
          ? { dark: "#1a1a1a", light: "#ffffff" }
          : { dark: "#f2f2f2", light: "#1a1a1a" },
      }).then(() => setQrError(null)).catch((err) => setQrError(String(err)));
    };
    draw();
    window.addEventListener("omnesis:themechange", draw);
    return () => window.removeEventListener("omnesis:themechange", draw);
  }, [payload]);

  if (planError) {
    return html`<p class="devices-phone-error" role="alert">Couldn't prepare the QR code: ${planError}</p>`;
  }
  if (!plan) {
    return html`<p class="devices-muted" aria-live="polite">Finding the addresses this ${phone} can use…</p>`;
  }

  const usable = plan.addresses.filter((a) => a.usable);
  const refused = plan.addresses.filter((a) => !a.usable);
  const selected = usable.find((a) => a.gatewayUrl === selectedUrl) ?? null;

  if (!selected) {
    return html`
      <div class="devices-phone-qr">
        <p class="devices-phone-error" role="alert">
          None of this gateway's addresses can be used by an ${phone}, so there is no QR code to scan.
        </p>
        <${RefusedAddresses} refused=${refused} phone=${phone} />
        ${plan.awayFromHome && html`<${AwayFromHomeHint} hint=${plan.awayFromHome} platform=${plan.platform} phone=${phone} />`}
      </div>
    `;
  }

  return html`
    <div class="devices-phone-qr">
      <p class="devices-pair-label">Scan with the Omnesis app on your ${phone}</p>
      ${payload
        ? html`<canvas
            ref=${canvasRef}
            class="devices-phone-qr-canvas"
            role="img"
            aria-label=${`Pairing QR code for ${selected.host}`}
          ></canvas>`
        : !qrError && html`<p class="devices-muted" aria-live="polite">Making the QR code…</p>`}
      ${qrError && html`<p class="devices-phone-error" role="alert">Couldn't make the QR code: ${qrError}</p>`}
      <div class="devices-phone-reach" data-reach=${selected.reach}>
        <span class="devices-phone-reach-dot" aria-hidden="true"></span>
        <div>
          <p class="devices-phone-reach-summary">${selected.summary}</p>
          <p class="devices-phone-reach-address">${selected.label} · <code>${selected.host}</code></p>
        </div>
      </div>
      ${plan.awayFromHome && html`<${AwayFromHomeHint} hint=${plan.awayFromHome} platform=${plan.platform} phone=${phone} />`}
      ${(usable.length > 1 || refused.length > 0) && html`
        <details class="devices-phone-alternatives">
          <summary>${usable.length > 1 ? "Use a different address" : "Why other addresses aren't offered"}</summary>
          ${usable.length > 1 && html`
            <fieldset class="devices-phone-choices">
              <legend class="sr-only">Address the ${phone} will connect to</legend>
              ${usable.map((option) => html`
                <label class="devices-phone-choice" key=${option.gatewayUrl}>
                  <input
                    type="radio"
                    name="pair-address"
                    value=${option.gatewayUrl}
                    checked=${option.gatewayUrl === selected.gatewayUrl}
                    onChange=${() => setSelectedUrl(option.gatewayUrl)}
                  />
                  <span>
                    <span class="devices-phone-choice-name">
                      ${option.label} · <code>${option.host}</code>${option.gatewayUrl === plan.recommendedUrl ? " (recommended)" : ""}
                    </span>
                    <span class="devices-phone-choice-summary">${option.summary}</span>
                  </span>
                </label>
              `)}
            </fieldset>
          `}
          <${RefusedAddresses} refused=${refused} phone=${phone} />
        </details>
      `}
      ${payload && html`
        <details class="devices-phone-qr-raw">
          <summary>Can't scan the code?</summary>
          <p>In the Omnesis app, choose <strong>Paste JSON</strong> and paste:</p>
          <pre><code>${payload}</code></pre>
          ${selected.systemTrust && html`
            <p>Or choose <strong>Manual entry</strong> and type the gateway URL <code>${selected.gatewayUrl}</code> and the pairing code <code>${pairingCode}</code>.</p>
          `}
        </details>
      `}
    </div>
  `;
}

/** The addresses the gateway will not put in this phone's QR code, with why. */
function RefusedAddresses({ refused, phone }) {
  if (refused.length === 0) return null;
  return html`
    <div class="devices-phone-refused">
      <p class="devices-phone-refused-title">Not offered for an ${phone}</p>
      <ul>
        ${refused.map((option) => html`
          <li key=${option.gatewayUrl}>
            <span class="devices-phone-choice-name">${option.label} · <code>${option.host}</code></span>
            <span class="devices-phone-choice-summary">${option.reason}</span>
          </li>
        `)}
      </ul>
    </div>
  `;
}

/**
 * Shown when no offered address reaches beyond the gateway's own network.
 * Both phones need the gateway host and the phone on one tailnet; an iPhone
 * also needs a Tailscale certificate, which needs the host's Tailscale name.
 */
function AwayFromHomeHint({ hint, platform, phone }) {
  const needsCertificate = platform === "ios";
  return html`
    <div class="devices-phone-away">
      <p class="devices-phone-away-title">To use this ${phone} away from home</p>
      <ol>
        ${!hint.onTailnet && html`
          <li>Install Tailscale on the gateway computer and on the ${phone}, and sign both in to the same tailnet.</li>
        `}
        ${needsCertificate && hint.onTailnet && !hint.tailscaleName && html`
          <li>Turn on MagicDNS for your tailnet in the Tailscale admin console.</li>
        `}
        ${needsCertificate && html`
          <li>
            Turn on HTTPS certificates for your tailnet, then run <code>omnesis tls provision</code> on
            the gateway computer. It gets a certificate${hint.tailscaleName ? html` for <code>${hint.tailscaleName}</code>` : ""} from
            Tailscale. Any phone you paired before this step will need to pair again.
          </li>
        `}
        <li>Create a new pairing code here and scan it.</li>
      </ol>
      <a href=${AWAY_FROM_HOME_DOCS_URL} target="_blank" rel="noopener noreferrer">Set up access away from home</a>
    </div>
  `;
}

/** One credential row inside an expanded device card. */
function TokenRow({ token, onRevoke }) {
  return html`
    <div class="devices-token">
      <span class="devices-token-label">
        ${token.name ? token.name : html`<span class="devices-muted">unlabeled</span>`}
      </span>
      <span class="devices-token-scopes">
        ${token.scopes.map((s) => html`<${ScopeChip} key=${s} scope=${s} />`)}
      </span>
      <span class="devices-token-meta">
        created ${relativeTime(token.createdAt)} · used ${token.lastUsedAt ? relativeTime(token.lastUsedAt) : "never"}
      </span>
      <button class="btn-tiny danger devices-token-revoke" onClick=${() => onRevoke(token.id)}>Revoke</button>
    </div>
  `;
}

/**
 * The version chip for one device row.
 *
 * The gateway does the judging — the row carries a `versionState` it
 * computed — so the portal only decides how loudly to say it. Only
 * `unsupported` is a warning: that device is below the floor its kind
 * declares, or was last seen on a wire protocol the gateway no longer
 * speaks, and cannot sync until it is updated. `behind` renders as the plain
 * version it reported, because an app build trailing the tag while a store
 * release is in flight is the normal state, not a defect. A device that has
 * never reported a version shows no chip at all rather than an alarming
 * placeholder.
 */
export function versionChip(device) {
  const state = device.versionState ?? "unknown";
  if (state === "unknown") return null;
  // The state, not the version string, decides whether there is anything to
  // say. A device stranded on a wire protocol the gateway no longer speaks is
  // unsupported whether or not it ever reported a version, and that is exactly
  // the row an operator must not have to hunt for.
  const label =
    state === "unsupported"
      ? `${device.version ? `${device.version} · ` : ""}unsupported`
      : device.version;
  if (!label) return null;
  return html`<span
    class=${`devices-card-version ${state}`}
    title=${state === "unsupported"
      ? "Too old for this gateway — update this device before it can sync again."
      : state === "behind"
        ? "Older than the gateway. Apps can lag while a store release is in flight."
        : "Up to date with the gateway."}
    >${label}</span
  >`;
}

/**
 * Which devices the update actions are offered for.
 *
 * The gateway's own disposition decides, never the page: the refusals behind
 * it — a phone whose build comes from a store, a device that has never
 * reported its version, one below the oldest build this gateway supports —
 * are safety rules, and a button whose only outcome is a refusal would be a
 * worse answer than no button. With no target version fetched there is
 * nothing to offer either, since the prompt could not name what it moves to.
 */
export function updatableDevices(devices, targetVersion) {
  if (!targetVersion) return [];
  return devices.filter((d) => d.updateDisposition?.kind === "update");
}

/**
 * What a commanded self-update is doing on this device, or null when nothing
 * is outstanding and nothing failed.
 *
 * `pending` and `dispatched` are the two live states, and a device only ever
 * sits in one of them briefly — but "briefly" is exactly when an operator who
 * just pressed the button is looking. `failed`, `restart-pending` and
 * `unsupported` persist, because each needs something from the operator: an
 * explanation, a restart they have to perform, or an update run by hand on
 * that machine.
 *
 * An `unsupported` chip's title is the gateway's own refusal, which names the
 * commands for this device's kind; the page does not restate them.
 */
export function updateChip(device) {
  const state = device.updateState;
  if (!state || state === "installed") return null;
  // Exact source refs are a CLI-only operational feature. Keep their opaque
  // persistence key out of the release-oriented portal UI.
  const target =
    typeof device.desiredVersion === "string" && !device.desiredVersion.startsWith("commit:")
      ? ` · ${device.desiredVersion}`
      : "";
  const label =
    state === "pending"
      ? `update pending${target}`
      : state === "dispatched"
        ? `updating${target}`
        : state === "restart-pending"
          ? "restart to finish updating"
          : state === "unsupported"
            ? "update on its machine"
            : "update failed";
  const refusal =
    device.updateDisposition?.kind === "refused" &&
    device.updateDisposition.code === "command-unsupported"
      ? device.updateDisposition.reason
      : null;
  const title =
    state === "pending"
      ? device.updateDetail ?? "The update is sent when this device reconnects."
      : state === "dispatched"
        ? device.updateDetail ?? "This device is running its own update."
        : state === "restart-pending"
          ? device.updateDetail ?? "The new build is installed but needs a restart you have to perform."
          : state === "unsupported"
            ? refusal ?? "This build cannot be updated remotely. Update it on its own machine."
            : device.updateDetail ?? "This device could not update itself.";
  return html`<span class=${`devices-card-update ${state}`} title=${title}>${label}</span>`;
}

/** Plain-language notification transport for one phone card. */
export function notificationTransportLabel(device) {
  switch (device.pushTransport) {
    case "direct-apns": return "Direct APNs";
    case "direct-fcm": return "Direct FCM";
    case "relay": return "Relay";
    case "socket": return "Live device connection";
    default: return "Not configured";
  }
}

function completedHealthTime(value) {
  if (!value) return null;
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? relativeTime(timestamp) : null;
}

/** Keep fleet progress visible even when every device card is collapsed. */
function FleetHealthProgress({ healthByDevice, requesting }) {
  const states = [...healthByDevice.values()];
  const summary = [
    ["running", "running"],
    ["pending", "pending (waiting for collectors)"],
    ["complete", "completed"],
    ["failed", "failed"],
    ["not-run", "not checked"],
    ["not-applicable", "not applicable"],
  ].flatMap(([state, label]) => {
    const count = states.filter((health) => health.state === state).length;
    return count ? [`${count} ${label}`] : [];
  });
  return html`
    <div class="devices-banner devices-health-progress" role="status" aria-live="polite">
      ${requesting
        ? "Requesting health checks…"
        : summary.length
          ? `Health checks: ${summary.join(", ")}. Expand a device to see its report.`
          : "No device health checks are available."}
    </div>
  `;
}

/** Compact rendering of the authoritative health state for one device. */
export function DeviceHealth({ health, deviceName, requesting = false, onRun }) {
  const state = health?.state ?? "not-run";
  const completed = completedHealthTime(health?.completedAt);
  const action =
    state === "not-run" ? "Run" : state === "complete" ? "Run again" : "Retry";
  const canRun = state === "not-run" || state === "complete" || state === "failed";

  return html`
    <section
      class=${`devices-card-health state-${state}`}
      aria-label=${`${deviceName} health`}
      aria-live="polite"
    >
      <div class="devices-card-health-head">
        <div class="devices-card-creds-head">Health</div>
        ${canRun && html`
          <button
            class="btn-tiny"
            aria-label=${`${action} health checks for ${deviceName}`}
            disabled=${requesting}
            onClick=${onRun}
          >
            ${requesting ? "Requesting…" : action}
          </button>
        `}
      </div>
      ${state === "not-run" && html`<div class="devices-health-copy">Not checked.</div>`}
      ${state === "pending" && html`
        <div class="devices-health-copy">
          ${health?.online
            ? "Pending — waiting for the collector to begin."
            : "Pending — it will run when the collector reconnects."}
        </div>
      `}
      ${state === "running" && html`
        <div class="devices-health-copy">Running health checks…</div>
      `}
      ${state === "failed" && html`
        <div class="devices-health-copy devices-health-failed">
          ${health?.detail || "Health checks failed."}
        </div>
      `}
      ${state === "not-applicable" && html`
        <div class="devices-health-copy devices-health-na">
          <strong>N/A</strong> — ${health?.detail || "Health checks are not applicable to this device."}
        </div>
      `}
      ${state === "complete" && health?.report && html`
        ${completed && html`<div class="devices-health-time">Completed ${completed}</div>`}
        <${DoctorReportView} report=${health.report} compact=${true} />
      `}
      ${state === "complete" && !health?.report && html`
        <div class="devices-health-copy devices-health-failed">
          The completed report is unavailable.
        </div>
      `}
    </section>
  `;
}

/** The access levels an integration can be put on: those that can answer. */
function answerLevelsOf(overview) {
  return accessLevels(overview).filter((level) => accessRules(level, overview).answer);
}

const ACCESS_PATH = "/portal/settings/access";

/** A gateway refusal ("name the integration …") as a sentence for the page. */
function sentence(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return trimmed;
  const capitalized = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

const DEVICE_LEVEL_REFUSALS = {
  "invalid-selection": "That access level cannot answer questions. Give it Answer first.",
  "stale-revision": "That access level just changed. Choose it again to use its new permissions.",
  "inactive-grant": "That access level no longer exists.",
  "device-not-integration": "Only an integration is put on an access level.",
};

/**
 * What one access level lets a device's answers use, in the Access page's own
 * words: how much of the corpus, then how replies are released.
 */
function levelAnswerTerms(level, overview) {
  const answer = accessRules(level, overview).answer;
  const reach = (reachSummary({ answer }, overview) ?? "no sources").toLowerCase();
  const release = answer.release.mode === "unreviewed"
    ? "released without privacy review"
    : `reviewed under “${answerPrivacySummary(answer, overviewPolicies(overview))}”`;
  return `${reach}, ${release}`;
}

/**
 * The access level whose Answer rule applies to what an integration asks over
 * `/answer`: the sources its answers may use, and the privacy policy that
 * reviews them. Only levels with Answer are offered. An integration on no
 * level — or on one that is gone or lost Answer — has its questions refused,
 * and the card says so until the operator chooses.
 *
 * A revoked integration keeps its level so a repair brings it back there. It
 * cannot be put on another one, so its card shows the level as text with a
 * single action that takes it off.
 */
function DeviceAccessSection({ device, overview, onSave }) {
  const current = device.accessLevelId ?? "";
  const revoked = device.revokedAt != null;
  const levels = answerLevelsOf(overview);
  const chosen = levels.find((level) => level.id === current);
  const missing = current !== "" && !chosen;
  const [pending, setPending] = useState(null);
  const [saveError, setSaveError] = useState(null);

  async function save(next) {
    const level = levels.find((candidate) => candidate.id === next);
    setPending(next);
    setSaveError(null);
    try {
      await onSave(device.id, level ? level.id : null, level?.revision);
    } catch (e) {
      setSaveError(DEVICE_LEVEL_REFUSALS[e?.serverMessage] ?? errorMessage(e, "The access level could not be changed."));
    } finally {
      setPending(null);
    }
  }

  const control = revoked
    ? html`
        <span class="devices-access-level-name">${chosen ? chosen.name : "Unavailable access level"}</span>
        <button class="btn-tiny" disabled=${pending !== null} onClick=${() => save("")}>Remove</button>
      `
    : html`
        <select
          aria-label=${`Access level for ${device.name}`}
          value=${pending ?? current}
          disabled=${pending !== null}
          onChange=${(event) => save(event.currentTarget.value)}
        >
          ${missing && html`<option value=${current}>Unavailable access level — questions refused</option>`}
          <option value="">No access level — questions refused</option>
          ${levels.map((level) => html`<option key=${level.id} value=${level.id}>${level.name}</option>`)}
        </select>
      `;

  return html`
    <div class="devices-card-access">
      <div class="devices-access-row">
        <span class="devices-card-creds-head">Answer access</span>
        ${control}
        <span class="devices-muted" aria-live="polite">${pending !== null ? "Saving…" : ""}</span>
      </div>
      ${saveError && html`<div class="devices-banner error" role="alert">${saveError}</div>`}
      <div class="devices-muted">
        ${revoked
          ? "A repair brings this integration back on this level."
          : chosen
          ? `Answers use ${levelAnswerTerms(chosen, overview)}.`
          : missing
            ? "Its access level is gone or can no longer answer, so this integration's questions are refused."
            : "This integration's questions are refused until you choose an access level."}
        ${" "}<a
          href=${ACCESS_PATH}
          onClick=${(event) => { event.preventDefault(); navigate(ACCESS_PATH); }}
        >Manage access levels</a>
      </div>
    </div>
  `;
}

/**
 * One device, rendered as a card. Collapsed: kind icon, name, a single
 * plain-language status line, and a quiet kind/hostname sub-line, plus the
 * actions menu. Expanded: paired / last-seen detail, the device id, and the
 * device's credentials (tokens). Additional credentials are minted from the
 * CLI, so the card only lists and revokes them.
 */
export function DeviceCard({
  device,
  isThis,
  tokens,
  expanded,
  onToggle,
  onRevokeDevice,
  onForgetDevice,
  onRepairDevice,
  onUpdateDevice,
  health,
  healthRequesting,
  onRunHealth,
  onWithdrawRelayConsent,
  onRevokeToken,
  accessOverview,
  onSetDeviceLevel,
}) {
  const d = device;
  const hostname = d.capabilities?.hostname;
  const harness =
    d.capabilities?.agentIntegration?.harness === "openclaw"
      ? "OpenClaw"
      : d.capabilities?.agentIntegration?.harness === "hermes"
        ? "Hermes"
        : null;
  const kindLabel = KIND_LABELS[d.kind] ?? d.kind;
  const phoneTransport =
    d.kind === "ios" || d.kind === "android"
      ? `Notifications: ${notificationTransportLabel(d)}`
      : null;
  const sub = [kindLabel, hostname || harness, phoneTransport].filter(Boolean).join(" · ");
  const revoked = Boolean(d.revokedAt);
  const needsPairing = revoked && Boolean(d.needsPairing);
  const activeNow = !revoked && (isThis || d.online);
  // A managed harness can be paired, online, ingesting transcripts, and still
  // unable to read the corpus: that authority is a separate OAuth grant whose
  // ticket expires from disuse. Nothing else on this card would say so.
  const needsReauthorization =
    !revoked && d.agentAuthorization?.status === "needs-reauthorization";

  return html`
    <div id=${`device-${d.id}`} class=${`devices-card ${expanded ? "expanded" : ""} ${isThis ? "is-this" : ""} ${revoked ? "revoked" : ""} ${needsPairing ? "needs-pairing" : ""} ${activeNow ? "online" : "offline"}`}>
      <div class="devices-card-head">
        <button class="devices-card-toggle" aria-expanded=${expanded} onClick=${() => onToggle(d.id)}>
          <span class="devices-card-icon"><${KindIcon} kind=${d.kind} /></span>
          <span class="devices-card-main">
            <span class="devices-card-titlerow">
              <span class="devices-card-name">${d.name}</span>
              ${isThis && html`<span class="devices-card-badge">This device</span>`}
              ${revoked && html`<span class=${`devices-card-badge ${needsPairing ? "needs-pairing" : "revoked"}`}>${needsPairing ? "Needs re-pairing" : "Revoked"}</span>`}
              ${!revoked && versionChip(d)}
              ${!revoked && updateChip(d)}
              ${needsReauthorization && html`<span class="devices-card-badge revoked">Needs re-authorization</span>`}
            </span>
            <span class="devices-card-sub">${sub}</span>
          </span>
          <span class=${`devices-card-status ${activeNow ? "online" : "offline"}`}>
            <span class="devices-status-dot"></span>${statusLine(d, isThis)}
          </span>
          <span class="devices-card-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
        </button>
        <div class="devices-card-menu">
          <${DeviceActionMenu}
            revoked=${revoked}
            onRepair=${d.kind === "portal" ? null : () => onRepairDevice(d)}
            repairDisabled=${activeNow}
            onRevoke=${() => onRevokeDevice(d)}
            onForget=${() => onForgetDevice(d.id, d.name)}
            onUpdate=${onUpdateDevice ? () => onUpdateDevice(d) : null}
          />
        </div>
      </div>
      ${expanded && html`
        <div class="devices-card-body">
          <div class="devices-card-meta">
            <span>Paired ${relativeTime(d.pairedAt)}</span>
            <span class="devices-card-meta-sep">·</span>
            <span>Last activity ${isThis ? "now" : d.lastSeenAt ? relativeTime(d.lastSeenAt) : "not recorded"}</span>
            <code class="devices-card-id">${d.id}</code>
          </div>
          ${needsPairing && html`
            <div class="devices-card-repair">
              This device still hosts sources. Bring it back with its identity, sources and cursors intact:
              <code>omnesis devices repair ${d.name}</code>
            </div>
          `}
          <${DeviceHealth}
            health=${health}
            deviceName=${d.name}
            requesting=${healthRequesting}
            onRun=${() => onRunHealth(d.id)}
          />
          ${(d.kind === "ios" || d.kind === "android") && html`
            <div class="devices-card-notifications">
              <div class="devices-card-creds-head">Notifications</div>
              <div class="devices-notification-row">
                <span>Transport</span>
                <strong>${notificationTransportLabel(d)}</strong>
              </div>
              ${d.relayConsent && html`
                <div class="devices-relay-consent">
                  <div>
                    <strong>Relay allowed</strong>
                    <span class="devices-muted">
                      ${d.relayConsent.appId} · approved ${relativeTime(d.relayConsent.grantedAt)}
                    </span>
                  </div>
                  <button
                    class="btn-tiny danger"
                    onClick=${() => onWithdrawRelayConsent(d)}
                  >Withdraw</button>
                </div>
              `}
              ${!d.relayConsent && (d.pushPlan?.reasonCode ?? d.pushPlanReasonCode) === "relay-disabled" && html`
                <div class="devices-muted">Relay approval is waiting on this phone.</div>
              `}
            </div>
          `}
          ${accessOverview &&
          onSetDeviceLevel &&
          d.kind === "integration" &&
          (!revoked || d.accessLevelId) &&
          html`
            <${DeviceAccessSection} device=${d} overview=${accessOverview} onSave=${onSetDeviceLevel} />
          `}
          <div class="devices-card-creds">
            <div class="devices-card-creds-head">Credentials</div>
            ${tokens.length === 0
              ? html`<div class="devices-muted devices-card-creds-empty">No tokens.</div>`
              : tokens.map((t) => html`<${TokenRow} key=${t.id} token=${t} onRevoke=${onRevokeToken} />`)}
            <div class="devices-muted devices-card-creds-hint">
              Extra credentials are issued from the CLI: <code>omnesis tokens create --device ${
                // As an expression so htm renders the placeholder as text, not a tag.
                "<device>"
              } --scopes …</code>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

/**
 * Per-kind redeem instructions shown under a freshly minted pairing code.
 * Each device kind redeems differently, so the guidance is tailored rather
 * than a one-size-fits-all curl:
 *   - ios / android  → scannable QR (delegated to PhonePairQr)
 *   - browser        → enter the URL + code in the extension's Options page
 *                      (the extension redeems itself; nothing to run here)
 *   - agent          → `omnesis connect openclaw|hermes`
 *   - collector      → `install.sh --collector` on a bare machine, which
 *                      redeems the code and registers the service; on a
 *                      machine that already has the CLI, `omnesis pair` saving
 *                      the token where the collector reads it (a bare curl
 *                      that just prints a token wouldn't wire it up)
 *   - portal         → paste the code into the portal login screen on the new
 *                      device; the browser redeems it into a cookie session
 *                      (there is no command to run)
 *   - cli            → `omnesis pair <code>`, with a raw curl as a no-CLI
 *                      fallback
 */
export function PairInstructions({ pairResult, identities, selectedHostIdx, setSelectedHostIdx }) {
  const code = pairResult.pairingCode;
  const origin = location.origin;

  if (isPhoneKind(pairResult.kind)) {
    return html`<${PhonePairQr} pairingCode=${code} kind=${pairResult.kind} />`;
  }
  if (pairResult.kind === "browser") {
    return html`
      <div class="devices-pair-snippet">
        <span class="devices-pair-label">In the Omnesis browser extension, open Options and enter the gateway URL below plus the pairing code shown above:</span>
        <ul class="devices-pair-ext-steps">
          <li>Gateway URL: <code>${origin}</code></li>
        </ul>
        <p class="devices-pair-ext-note">The extension redeems the code itself and stores its credential. Don't have it yet? <a href=${CHROME_WEB_STORE_URL} target="_blank" rel="noreferrer noopener">Install it from the Chrome Web Store</a>.</p>
      </div>
    `;
  }
  if (pairResult.kind === "agent") {
    const gatewayUrl = agentGatewayUrl(origin, identities, selectedHostIdx);
    const commands = agentConnectCommands(gatewayUrl, code);
    return html`
      <div class="devices-pair-snippet">
        <span class="devices-pair-label">On the external-agent host, connect the installed harness:</span>
        ${identities.length > 1 && html`
          <div class="devices-host-pick">
            <label>Address the agent host will connect to</label>
            <select
              value=${selectedHostIdx}
              onChange=${(e) => setSelectedHostIdx(Number(e.target.value))}
            >
              ${identities.map((identity, index) => html`
                <option key=${index} value=${index}>
                  ${identity.address} — ${identity.label}${identity.offLan ? " (off-LAN)" : ""}
                </option>
              `)}
            </select>
          </div>
        `}
        <div class="devices-agent-command-list">
          ${commands.map(({ label, command }) => html`
            <div class="devices-agent-command" key=${label}>
              <span class="devices-pair-label">${label}</span>
              <pre><code>${command}</code></pre>
            </div>
          `)}
        </div>
        <p class="devices-pair-ext-note">Run one command only. The pairing code is single-use.</p>
      </div>
    `;
  }
  if (pairResult.kind === "collector") {
    return html`
      <div class="devices-pair-snippet">
        <span class="devices-pair-label">On a machine that has no Omnesis yet, one line installs the CLI, redeems this code and registers the collector service:</span>
        <pre><code>curl -fsSL https://omnesis.dev/install.sh | sh -s -- --collector --gateway-url ${origin}</code></pre>
        <p class="devices-pair-ext-note">It asks for the code above. Add <code>--trust-fingerprint</code> with this gateway's certificate fingerprint to verify it rather than trust it on sight — the gateway's own install printed the whole line.</p>
        <span class="devices-pair-label">On a machine that already has the CLI, redeem it by hand instead:</span>
        <pre><code>omnesis pair ${code} --gateway-url ${origin} --save ~/.config/omnesis/collector-token</code></pre>
      </div>
    `;
  }
  if (pairResult.kind === "integration") {
    return html`
      <div class="devices-pair-snippet">
        <span class="devices-pair-label">On the machine the integration runs on, redeem the code into a token file it reads:</span>
        <pre><code>omnesis devices redeem ${code} --gateway-url ${origin} --save ~/.config/omnesis/integration.token</code></pre>
        <p class="devices-pair-ext-note">No Omnesis CLI there? Redeem the code directly and keep the returned token:</p>
        <pre><code>curl -X POST ${origin}/devices/pair \\
  -H 'Content-Type: application/json' \\
  -d '{"pairingCode":"${code}","kind":"integration"}'</code></pre>
        <p class="devices-pair-ext-note">${pairResult.accessLevelName
          ? pairResult.repair
            ? `It comes back on the access level “${pairResult.accessLevelName}”.`
            : `Its answers use the access level “${pairResult.accessLevelName}”.`
          : "Its questions are refused until you choose its access level on its card."}</p>
      </div>
    `;
  }
  if (pairResult.kind === "portal") {
    // The portal redeems the code itself: paste it into the login screen on the
    // new device and the browser exchanges it for a cookie session. There's no
    // `omnesis pair` / curl step — those would burn the code for a raw token the
    // portal login can't use.
    return html`
      <div class="devices-pair-snippet">
        <span class="devices-pair-label">Open the Omnesis portal on the new device and paste this code into its login screen:</span>
        <ul class="devices-pair-ext-steps">
          <li>Portal URL: <code>${origin}</code></li>
          <li>Pairing code: <code>${code}</code></li>
        </ul>
        <p class="devices-pair-ext-note">The portal redeems the code itself into a browser session — nothing to run in a terminal.</p>
      </div>
    `;
  }
  return html`
    <div class="devices-pair-snippet">
      <span class="devices-pair-label">On the new device, run:</span>
      <pre><code>omnesis pair ${code} --gateway-url ${origin}</code></pre>
      <p class="devices-pair-ext-note">No Omnesis CLI on that device? Redeem the code directly:</p>
      <pre><code>curl -X POST ${origin}/devices/pair \\
  -H 'Content-Type: application/json' \\
  -d '{"pairingCode":"${code}"}'</code></pre>
    </div>
  `;
}

/**
 * Modal that hosts the pair-a-device flow: pick a kind, generate a code. The
 * gateway grants the kind's canonical scopes, so there is nothing else to
 * choose here. The generated code and its per-kind redeem instructions (see
 * PairInstructions) render inline below the form.
 */
function PairModal({
  pairKind,
  onKindChange,
  answerLevels = [],
  pairLevelId = "",
  onPairLevelChange = () => {},
  pairName = "",
  onPairNameChange = () => {},
  pairResult,
  pairError = null,
  setPairResult,
  pairing,
  onPair,
  identities,
  selectedHostIdx,
  setSelectedHostIdx,
  onClose,
  repairTarget,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return html`
    <div
      class="confirm-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pair-modal-title"
      onClick=${onClose}
    >
      <div class="confirm-modal devices-modal" onClick=${(e) => e.stopPropagation()}>
        <div id="pair-modal-title" class="confirm-modal-title">
          ${repairTarget ? `Repair ${repairTarget.name}` : "Pair a new device"}
        </div>
        ${repairTarget && html`
          <p class="devices-pair-label">
            ${repairTarget.kind === "integration"
              ? `This code is bound to ${repairTarget.name}. Re-pairing keeps its device identity and its access level.`
              : `This code is bound to ${repairTarget.name}. Re-pairing keeps its device identity, sources, memberships, cursors, and existing data.`}
          </p>
        `}
        <form class="devices-pair-form" onSubmit=${onPair}>
          ${!repairTarget && html`<div class="form-group">
            <label for="pair-kind">Kind</label>
            <select id="pair-kind" autoFocus value=${pairKind} onChange=${(e) => onKindChange(e.target.value)}>
              ${deviceKinds().map((k) => html`<option key=${k} value=${k}>${KIND_LABELS[k]}</option>`)}
            </select>
          </div>`}
          ${!repairTarget && pairKind === "integration" && html`<div class="form-group">
            <label for="pair-name">Name</label>
            <input
              id="pair-name"
              type="text"
              required
              maxlength="120"
              value=${pairName}
              onInput=${(e) => onPairNameChange(e.target.value)}
            />
          </div>`}
          ${!repairTarget && pairKind === "integration" && html`<div class="form-group">
            <label for="pair-level">Access level</label>
            <select id="pair-level" value=${pairLevelId} onChange=${(e) => onPairLevelChange(e.target.value)}>
              <option value="">Choose later — questions refused until then</option>
              ${answerLevels.map((level) => html`<option key=${level.id} value=${level.id}>${level.name}</option>`)}
            </select>
            <p class="devices-muted devices-pair-level-note">
              An integration reads your data only through its access level: the sources its answers
              may use and the privacy policy that reviews them.${" "}
              <a href=${ACCESS_PATH} onClick=${(event) => { event.preventDefault(); navigate(ACCESS_PATH); }}>Manage access levels</a>
            </p>
          </div>`}
          ${pairError && html`<div class="devices-banner error" role="alert">${pairError}</div>`}
          <div class="devices-pair-actions">
            <button type="submit" class="btn-primary" disabled=${pairing}>
              ${pairing ? "Generating…" : repairTarget ? "Generate repair code" : "Generate pairing code"}
            </button>
            <button type="button" class="btn-ghost" onClick=${onClose}>Close</button>
          </div>
        </form>

        ${pairResult && html`
          <div class="devices-pair-result">
            ${isPhoneKind(pairResult.kind)
              ? html`<p class="devices-pair-expiry">
                  This code expires in ${Math.max(0, Math.floor((pairResult.expiresAt - Date.now()) / 1000))}s.
                </p>`
              : html`<div class="devices-pair-code-row">
                  <span class="devices-pair-label">Pairing code</span>
                  <code class="devices-pair-code">${pairResult.pairingCode}</code>
                  <span class="devices-pair-expiry">expires in ${Math.max(0, Math.floor((pairResult.expiresAt - Date.now()) / 1000))}s</span>
                </div>`}
            <${PairInstructions}
              pairResult=${pairResult}
              identities=${identities}
              selectedHostIdx=${selectedHostIdx}
              setSelectedHostIdx=${setSelectedHostIdx}
            />
            <button class="btn-tiny" onClick=${() => setPairResult(null)}>dismiss</button>
          </div>
        `}
      </div>
    </div>
  `;
}

/**
 * Validate a `?pair=<kind>` deep link (e.g. from the Sources extension promo)
 * against the pairable kinds. Anything unrecognised resolves to null and the
 * page behaves as if linked plainly.
 */
export function resolvePairKindRequest(pairKindRequest) {
  return DEVICE_KINDS.includes(pairKindRequest) ? pairKindRequest : null;
}

export function DevicesView({ pairKindRequest = null, focusDeviceId = null } = {}) {
  const requestedPairKind = resolvePairKindRequest(pairKindRequest);
  const [devices, setDevices] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [doctorByDevice, setDoctorByDevice] = useState(() => new Map());
  const [doctorRequesting, setDoctorRequesting] = useState(false);
  const [showHealthProgress, setShowHealthProgress] = useState(false);
  const [doctorError, setDoctorError] = useState(null);
  const doctorRequestGeneration = useRef(0);
  const refreshSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // The kind the next pairing code is minted for. It is the only input the
  // pairing request carries: the gateway grants that kind's canonical scopes.
  const [pairKind, setPairKind] = useState(requestedPairKind ?? "cli");
  const [pairLevelId, setPairLevelId] = useState("");
  const [pairName, setPairName] = useState("");
  const [pairResult, setPairResult] = useState(null);
  // A refused pairing is shown in the modal that asked for it, where it stays
  // until the operator changes the request or asks again.
  const [pairError, setPairError] = useState(null);
  const [pairing, setPairing] = useState(false);
  const pairRequestGeneration = useRef(0);
  // Host identities the gateway is reachable at (LAN, mDNS, Tailscale).
  // Fetched once on mount for the agent-host address picker; a phone's QR
  // address comes from the gateway's per-phone judgement instead.
  const [identities, setIdentities] = useState([]);
  const [selectedHostIdx, setSelectedHostIdx] = useState(0);

  // Confirm-modal state — used for revoke-device + revoke-token, both
  // destructive.
  const [confirmState, setConfirmState] = useState(null);

  // Device id backing the current portal session (from /whoami) — pins the
  // "This device" card. Null when the session isn't bound to a device.
  const [sessionDeviceId, setSessionDeviceId] = useState(null);
  // Pairing is an occasional action, so it lives behind a button → modal
  // rather than an always-open form — unless a `?pair=` deep link asked for
  // it open on arrival.
  const [pairModalOpen, setPairModalOpen] = useState(requestedPairKind !== null);
  // The Access overview behind the per-device access-level picker: its levels,
  // sources and policies. Best effort like the other auxiliary fetches: without
  // it the picker stays hidden and the rest of the page is unaffected.
  const [accessOverview, setAccessOverview] = useState(null);

  // A `?pair=` request that arrives without a remount (Back/Forward, or a
  // second navigation while the tab is already open) still opens the modal:
  // state initializers only run on mount. Keyed on the request value, so
  // closing the modal does not refire it.
  useEffect(() => {
    if (requestedPairKind !== null) {
      setPairKind(requestedPairKind);
      setPairResult(null);
      setRepairTarget(null);
      setPairModalOpen(true);
    }
  }, [requestedPairKind]);
  const [repairTarget, setRepairTarget] = useState(null);
  // Which device cards are expanded (multiple may be open).
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  // Other paired devices are collapsed by default to keep the list compact.
  const [showOther, setShowOther] = useState(false);
  // The version every commanded device is told to reach. Fetched once — it
  // only changes when the gateway restarts on a new build. Per-device
  // dispositions ride on the device rows themselves, so the poll below costs
  // no extra request.
  const [updateTarget, setUpdateTarget] = useState(null);

  function applyDoctorResponse(response) {
    setDoctorByDevice(
      new Map((response?.devices ?? []).map((deviceHealth) => [deviceHealth.deviceId, deviceHealth])),
    );
  }

  async function refresh() {
    const sequence = ++refreshSequence.current;
    const doctorGeneration = doctorRequestGeneration.current;
    try {
      const [d, t, doctorResult] = await Promise.all([
        listDevices(),
        listTokens(),
        getFleetDoctor().then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        ),
      ]);
      if (sequence !== refreshSequence.current) return;
      setDevices(d.items || []);
      setTokens(t.items || []);
      if (doctorResult.value && doctorGeneration === doctorRequestGeneration.current) {
        applyDoctorResponse(doctorResult.value);
      }
      if (doctorGeneration === doctorRequestGeneration.current) {
        setDoctorError(
          doctorResult.error
            ? `Health status: ${String(doctorResult.error.message || doctorResult.error)}`
            : null,
        );
      }
      setError(null);
    } catch (e) {
      if (sequence === refreshSequence.current) setError(String(e.message || e));
    }
    if (sequence === refreshSequence.current) setLoading(false);
  }

  useEffect(() => {
    refresh();
    // Best effort, and deliberately not fatal: without it the update actions
    // are simply absent, which is a far better failure than a Devices page
    // that cannot list devices.
    fleetUpdateTarget()
      .then((res) => setUpdateTarget(res.targetVersion))
      .catch(() => setUpdateTarget(null));
  }, []);
  useVisiblePoll(refresh, 3000);

  useEffect(() => {
    (async () => {
      try {
        const res = await getNetworkIdentities();
        setIdentities(res.items || []);
      } catch {
        // Non-fatal: without identities the agent commands use this
        // portal's own address.
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const me = await whoami();
        setSessionDeviceId(me?.deviceId ?? null);
      } catch {
        // Non-fatal — without it we just don't pin a "This device" card.
      }
    })();
  }, []);

  async function refreshAccessOverview() {
    try {
      setAccessOverview(await getAccessOverview());
    } catch {
      // Non-fatal — without the overview the access-level picker stays hidden.
    }
  }

  useEffect(() => {
    refreshAccessOverview();
  }, []);
  // Levels change on the Access page, possibly in another tab: re-read them
  // now and then, and at once when a device names a level this page has not
  // seen, so the picker never calls a new level removed.
  useVisiblePoll(refreshAccessOverview, 30_000);
  const unknownLevelKey = accessOverview
    ? devices
        .map((d) => d.accessLevelId)
        .filter((id) => id && !(accessOverview.levels ?? []).some((level) => level.id === id))
        .sort()
        .join(",")
    : "";
  const checkedUnknownRef = useRef("");
  useEffect(() => {
    if (!unknownLevelKey || unknownLevelKey === checkedUnknownRef.current) return;
    checkedUnknownRef.current = unknownLevelKey;
    refreshAccessOverview();
  }, [unknownLevelKey]);

  // The level list is re-read whether or not the save went through: a refusal
  // for a stale revision is fixed by choosing again from the current one.
  async function handleSetDeviceLevel(deviceId, levelId, expectedLevelRevision) {
    try {
      await setDeviceAccessLevel(deviceId, levelId, expectedLevelRevision);
    } finally {
      await Promise.all([refresh(), refreshAccessOverview()]);
    }
  }

  // A link that names a device (`?device=<id>`) opens its card — and the
  // "Other devices" group it may sit in — and scrolls to it, once, as soon as
  // the device has loaded.
  const focusedRef = useRef(null);
  useEffect(() => {
    if (!focusDeviceId || focusedRef.current === focusDeviceId) return;
    if (!devices.some((d) => d.id === focusDeviceId)) return;
    focusedRef.current = focusDeviceId;
    setExpandedIds((prev) => new Set(prev).add(focusDeviceId));
    setShowOther(true);
    setTimeout(() => {
      document.getElementById(`device-${focusDeviceId}`)?.scrollIntoView?.({ block: "center" });
    }, 0);
  }, [focusDeviceId, devices]);

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handlePair(e) {
    e.preventDefault();
    const generation = ++pairRequestGeneration.current;
    const targetId = repairTarget?.id ?? null;
    setPairResult(null);
    setPairError(null);
    setPairing(true);
    try {
      // Other than an integration, the device names itself at redeem;
      // `omnesis devices rename` changes the display name afterwards.
      const kind = repairTarget?.kind ?? pairKind;
      // An integration's access level is chosen with its code, from this portal session.
      const level =
        kind === "integration" && !repairTarget && accessOverview
          ? answerLevelsOf(accessOverview).find((candidate) => candidate.id === pairLevelId)
          : undefined;
      // An integration is named for what it is; other kinds name themselves at redeem.
      const name = kind === "integration" && !repairTarget ? pairName.trim() : "";
      const res = await pairDevice({
        kind,
        ...(repairTarget ? { repairDeviceId: repairTarget.id } : {}),
        ...(name ? { name } : {}),
        ...(level ? { accessLevelId: level.id } : {}),
      });
      // Stash `kind` on the result so the UI knows whether to render the
      // iOS QR flow vs. the curl snippet.
      if (pairRequestGeneration.current === generation && (repairTarget?.id ?? null) === targetId) {
        // A repaired integration comes back on the level it kept.
        const kept =
          repairTarget && accessOverview
            ? answerLevelsOf(accessOverview).find((candidate) => candidate.id === repairTarget.accessLevelId)
            : undefined;
        setPairResult({ ...res, kind, repair: !!repairTarget, accessLevelName: (level ?? kept)?.name ?? null });
      }
    } catch (e) {
      if (pairRequestGeneration.current === generation) {
        setPairError(sentence(errorMessage(e, "The pairing code could not be generated.")));
      }
    }
    if (pairRequestGeneration.current === generation) setPairing(false);
  }

  function handleRevokeDevice(device) {
    const corpusImpact = deviceCorpusCredentialImpact(device);
    setConfirmState({
      title: `Revoke device "${device.name}"?`,
      body: html`<${DeviceRevocationImpact} device=${device} />`,
      confirmLabel: "Revoke",
      destructive: true,
      onConfirm: async () => {
        try {
          await revokeDevice(device.id, corpusImpact.fingerprint);
          await refresh();
        } catch (e) {
          setError(String(e.message || e));
        }
      },
    });
  }

  function handleForgetDevice(id, name) {
    setConfirmState({
      title: `Forget device "${name}"?`,
      body: "Deletes the device permanently. Refused while it still hosts sources — move or remove them first.",
      confirmLabel: "Forget",
      destructive: true,
      onConfirm: async () => {
        try {
          await forgetDevice(id);
          await refresh();
        } catch (e) {
          setError(String(e.message || e));
        }
      },
    });
  }

  function handleWithdrawRelayConsent(device) {
    setConfirmState({
      title: `Withdraw relay access for "${device.name}"?`,
      body: "Notifications through the relay stop immediately. The phone can ask you to allow them again later.",
      confirmLabel: "Withdraw",
      destructive: true,
      onConfirm: async () => {
        try {
          await withdrawRelayPushConsent(device.id);
          await refresh();
        } catch (e) {
          setError(String(e.message || e));
        }
      },
    });
  }

  async function handleRunHealth(deviceIds) {
    doctorRequestGeneration.current += 1;
    setShowHealthProgress(true);
    setDoctorError(null);
    setDoctorRequesting(true);
    try {
      const response = await requestFleetDoctor(deviceIds);
      // Any GET that overlapped the mutation may describe the prior run.
      doctorRequestGeneration.current += 1;
      applyDoctorResponse(response);
      setDoctorError(null);
    } catch (e) {
      // Invalidate a GET poll that began during this request before exposing
      // the failure; its older success must not erase the action error.
      doctorRequestGeneration.current += 1;
      setDoctorError(String(e.message || e));
    } finally {
      setDoctorRequesting(false);
    }
  }

  /**
   * Ask one device to update itself. The version diff is in the prompt: an
   * update replaces the build a machine is running, so the operator confirms
   * the exact transition rather than an unspecified "update".
   */
  function handleUpdateDevice(device) {
    askToUpdate([device], `Update "${device.name}" to ${updateTarget}?`, "Update");
  }

  /** Ask every device the gateway would command and that is behind. */
  function handleUpdateAll(behind) {
    askToUpdate(
      behind,
      `Update ${behind.length} device${behind.length === 1 ? "" : "s"} to ${updateTarget}?`,
      "Update all",
    );
  }

  /**
   * Confirm, then command.
   *
   * The diff shown is the polled list, which is at most a few seconds old.
   * That is safe to approve against because the gateway re-derives every id
   * it is sent against its own dispositions, so an approval given on a stale
   * row cannot command something the gateway would refuse — and the outcomes
   * it returns are shown rather than discarded, so a device that refuses says
   * so here rather than silently.
   */
  function askToUpdate(targets, title, confirmLabel) {
    setConfirmState({
      title,
      // The diff is the point of the prompt, so it is rendered as lines rather
      // than joined into a paragraph — a run-on list is not a version diff.
      body: html`
        <ul class="devices-update-list">
          ${targets.map(
            (d) =>
              html`<li key=${d.id}>
                ${d.name}: ${d.version ?? "unknown"} → ${updateTarget}${d.online
                  ? ""
                  : " (offline — sent on reconnect)"}
              </li>`,
          )}
        </ul>
        <p>
          Each runs its own <code>omnesis update</code> on its own host and restarts. Devices this
          gateway does not command are left alone.
        </p>
      `,
      confirmLabel,
      destructive: false,
      onConfirm: async () => {
        try {
          const res = await requestFleetUpdate(targets.map((d) => d.id));
          const refused = (res.devices || []).filter(
            (o) => o.state === "refused" || o.state === "failed",
          );
          setError(
            refused.length > 0
              ? refused.map((o) => `${o.name}: ${o.detail ?? o.state}`).join(" · ")
              : null,
          );
          await refresh();
        } catch (e) {
          setError(String(e.message || e));
        }
      },
    });
  }

  function handleRevokeToken(id) {
    setConfirmState({
      title: "Revoke this token?",
      body: "Any process still using this token will start getting 401s on its next request.",
      confirmLabel: "Revoke",
      destructive: true,
      onConfirm: async () => {
        try { await revokeTokenById(id); await refresh(); }
        catch (e) { setError(String(e.message || e)); }
      },
    });
  }

  // Group tokens by device id, newest first within each group. The
  // Tokens render under their device's card, grouped here by device id.
  const tokensByDevice = useMemo(() => {
    const out = new Map();
    for (const t of tokens) {
      if (!out.has(t.deviceId)) out.set(t.deviceId, []);
      out.get(t.deviceId).push(t);
    }
    for (const list of out.values()) {
      list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    }
    return out;
  }, [tokens]);

  const thisDeviceId = currentDeviceIdForKind(devices, sessionDeviceId, "portal");
  const liveCount = liveConnectionCount(devices);
  const revokedTotal = revokedCount(devices);
  const needsPairingTotal = needsPairingCount(devices);
  const { thisDevice, live, other } = useMemo(
    () => groupDevices(devices, thisDeviceId),
    [devices, thisDeviceId],
  );

  const behindDevices = useMemo(
    () => updatableDevices(devices, updateTarget),
    [devices, updateTarget],
  );
  const updatableIds = useMemo(() => new Set(behindDevices.map((d) => d.id)), [behindDevices]);

  function openPairModal() {
    pairRequestGeneration.current += 1;
    setRepairTarget(null);
    setPairResult(null);
    setPairError(null);
    setPairModalOpen(true);
  }

  function openRepairModal(device) {
    pairRequestGeneration.current += 1;
    setRepairTarget(device);
    setPairResult(null);
    setPairError(null);
    setPairModalOpen(true);
  }

  function closePairModal() {
    pairRequestGeneration.current += 1;
    setPairing(false);
    setPairModalOpen(false);
  }

  // One card, shared across the This device / Live / Other groups.
  const renderCard = (d) =>
    html`<${DeviceCard}
      key=${d.id}
      device=${d}
      isThis=${d.id === thisDeviceId}
      tokens=${tokensByDevice.get(d.id) ?? []}
      expanded=${expandedIds.has(d.id)}
      onToggle=${toggleExpand}
      onRevokeDevice=${handleRevokeDevice}
      onForgetDevice=${handleForgetDevice}
      onRepairDevice=${openRepairModal}
      onUpdateDevice=${updatableIds.has(d.id) ? handleUpdateDevice : null}
      health=${doctorByDevice.get(d.id)}
      healthRequesting=${doctorRequesting}
      onRunHealth=${(id) => handleRunHealth([id])}
      onWithdrawRelayConsent=${handleWithdrawRelayConsent}
      onRevokeToken=${handleRevokeToken}
      accessOverview=${accessOverview}
      onSetDeviceLevel=${handleSetDeviceLevel}
    />`;

  return html`
    <div class="devices-view">
      <div class="devices-header">
        <div>
          <p class="devices-subtitle">Clients authorized to use your gateway.</p>
          ${updateTarget && html`
            <p class="devices-gateway-version">Gateway version <strong>${updateTarget}</strong></p>
          `}
        </div>
        <div class="devices-header-right">
          <div class="devices-summary">
            <span class="devices-stat"><strong>${devices.length}</strong> device${devices.length === 1 ? "" : "s"}</span>
            <span class="devices-stat-sep">·</span>
            <span class="devices-stat"><span class="devices-online-dot"></span>${liveCount} live connection${liveCount === 1 ? "" : "s"}</span>
            ${revokedTotal > 0 && html`
              <span class="devices-stat-sep">·</span>
              <span class=${`devices-stat ${needsPairingTotal > 0 ? "needs-pairing" : ""}`}
                title=${needsPairingTotal > 0
                  ? "Revoked devices that still host sources need a repair code before they can sync again."
                  : "Revoked devices keep their row, their sources and their data."}>
                ${revokedTotal} revoked${needsPairingTotal > 0 ? ` (${needsPairingTotal} awaiting repair)` : ""}
              </span>
            `}
          </div>
          <button
            class="btn-secondary"
            disabled=${loading || doctorRequesting}
            onClick=${() => handleRunHealth()}
          >${doctorRequesting ? "Requesting…" : "Run health checks"}</button>
          ${behindDevices.length > 0 && html`
            <button
              class="btn-secondary"
              title=${`Tell every device this gateway commands to update itself to ${updateTarget}.`}
              onClick=${() => handleUpdateAll(behindDevices)}
            >Update all (${behindDevices.length})</button>
          `}
          <button class="btn-primary devices-pair-btn" onClick=${openPairModal}>Pair device</button>
        </div>
      </div>

      ${error && html`<div class="devices-banner error">${error}</div>`}
      ${doctorError && html`<div class="devices-banner error">${doctorError}</div>`}
      ${showHealthProgress && !doctorError && html`
        <${FleetHealthProgress} healthByDevice=${doctorByDevice} requesting=${doctorRequesting} />
      `}

      ${loading
        ? html`<div class="devices-empty">Loading…</div>`
        : devices.length === 0
          ? html`<div class="devices-empty">
              No devices paired yet.
              <button class="btn-tiny" onClick=${openPairModal}>Pair your first device</button>
            </div>`
          : html`
            <div class="devices-groups">
              ${thisDevice && html`
                <section class="devices-group">
                  <h2 class="devices-group-title">This device</h2>
                  <div class="devices-cards">${renderCard(thisDevice)}</div>
                </section>
              `}
              <section class="devices-group">
                <h2 class="devices-group-title">
                  Live connections ${live.length > 0 ? html`<span class="devices-count">${live.length}</span>` : null}
                </h2>
                ${live.length === 0
                  ? html`<div class="devices-muted devices-group-empty">No other live connections right now.</div>`
                  : html`<div class="devices-cards">${live.map(renderCard)}</div>`}
              </section>
              ${other.length > 0 && html`
                <section class="devices-group devices-group-other">
                  <button
                    class="devices-group-toggle"
                    aria-expanded=${showOther}
                    onClick=${() => setShowOther((v) => !v)}
                  >
                    <span class="devices-card-chevron" aria-hidden="true">${showOther ? "▾" : "▸"}</span>
                    Other devices <span class="devices-count">${other.length}</span>
                  </button>
                  ${showOther && html`<div class="devices-cards">${other.map(renderCard)}</div>`}
                </section>
              `}
            </div>
          `}

      ${pairModalOpen && html`<${PairModal}
        pairKind=${pairKind}
        onKindChange=${(kind) => {
          setPairKind(kind);
          setPairResult(null);
          setPairError(null);
        }}
        answerLevels=${accessOverview ? answerLevelsOf(accessOverview) : []}
        pairLevelId=${pairLevelId}
        onPairLevelChange=${(levelId) => {
          setPairLevelId(levelId);
          setPairResult(null);
          setPairError(null);
        }}
        pairName=${pairName}
        onPairNameChange=${(value) => {
          setPairName(value);
          setPairResult(null);
          setPairError(null);
        }}
        pairResult=${pairResult}
        pairError=${pairError}
        setPairResult=${setPairResult}
        pairing=${pairing}
        onPair=${handlePair}
        identities=${identities}
        selectedHostIdx=${selectedHostIdx}
        setSelectedHostIdx=${setSelectedHostIdx}
        onClose=${closePairModal}
        repairTarget=${repairTarget}
      />`}
      <${ConfirmModal}
        open=${!!confirmState}
        title=${confirmState?.title}
        body=${confirmState?.body}
        confirmLabel=${confirmState?.confirmLabel}
        destructive=${!!confirmState?.destructive}
        onCancel=${() => setConfirmState(null)}
        onConfirm=${async () => {
          const fn = confirmState?.onConfirm;
          setConfirmState(null);
          try { if (fn) await fn(); } catch (err) { console.error(err); }
        }}
      />
    </div>
  `;
}
