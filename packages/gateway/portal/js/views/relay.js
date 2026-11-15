// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Omnesis account: the account link and remote access through the optional cloud relay. Only
// rendered when the gateway runs with OMNESIS_CLOUD_RELAY_ENABLED=1.
//
// The page leads with one state headline and at most one primary action, then
// three short sections: the account, remote access and new devices. Anything
// wrong is said in one box with details to copy; the machine detail (tunnel,
// certificates, monitoring) is what `omnesis cloud status` prints.

import { html } from "htm/preact";
import { CopyIconButton } from "../components/copy-button.js";
import { useState } from "preact/hooks";
import { RelayProblems, relayProblems, relayDiagnostics } from "../components/relay-problems.js";
import {
  GatewayPasskeyConfirm,
  passkeyConfirmationNeeded,
} from "../components/gateway-passkey-confirm.js";
import { useRelayManagement } from "../lib/use-relay-management.js";
import {
  relayError,
  relayClock,
  relayHttpsUrl,
  relaySignupAccess,
} from "../lib/cloud-relay-api.js";

/**
 * The one state the page is in, from the gateway's status. Order matters: an
 * active connect outranks everything, then a failure, then the connection.
 */
export function relayPhase(status) {
  if (!status) return "loading";
  const connect = status.connect?.state;
  if (connect === "waiting" || connect === "registering" || connect === "linking") return connect;
  if (connect === "failed") return "failed";
  const enrolled = status.enrollment?.state === "enrolled";
  if (!enrolled && !status.enabled) {
    if (status.serviceConfigured !== true) return "unavailable";
    if (status.enrollment?.state === "failed") return "failed";
    return "not-connected";
  }
  if (!status.enabled) return "off";
  if (!enrolled) return "registering";
  if (status.tunnel?.state === "online") return "connected";
  if (status.tunnel?.state === "offline") return "disconnected";
  return "reconnecting";
}

const TONES = {
  loading: "idle",
  unavailable: "idle",
  "not-connected": "idle",
  waiting: "progress",
  registering: "progress",
  linking: "progress",
  failed: "danger",
  off: "idle",
  connected: "ok",
  reconnecting: "warning",
  disconnected: "warning",
};

function Dot({ tone }) {
  return html`<span class=${`relay-dot relay-dot-${tone}`} aria-hidden="true"></span>`;
}

/** Strip the scheme from an already checked HTTPS address so it reads like something to type. */
function displayUrl(safe) {
  const url = new URL(safe);
  return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

const TURN_OFF_TIP =
  "Stops access from outside your home network. This gateway keeps its address and stays in your Omnesis account. You can turn it back on at any time.";
const TURN_ON_TIP =
  "Makes this gateway reachable from outside your home network again, at the same address.";

/**
 * A button with a tooltip: `title` for a pointer, and the same text as the
 * button's description, shown beside it while it has keyboard focus.
 */
function TipButton({ id, tip, children, ...button }) {
  return html`<span class="relay-tip-anchor">
    <button type="button" title=${tip} aria-describedby=${id} ...${button}>${children}</button>
    <span class="relay-tip" id=${id} role="tooltip">${tip}</span>
  </span>`;
}

/** Accounts need approval: where to ask, with the link's host in plain sight. */
function RequestAccess({ access }) {
  return html`<p class="relay-invite">
    Omnesis accounts are invite-only for now.${" "}
    <a href=${access.url} target="_blank" rel="noopener noreferrer">Request access</a>
    ${" "}<span class="relay-invite-host">(${access.host})</span> — you can create your account
    once it's approved.
  </p>`;
}

function Hero({ status, phase, busy, run }) {
  const disabled = Boolean(busy) && busy !== "refresh";
  const hostname = status?.hostname;
  const connectError = status?.connect?.error ?? status?.enrollment?.error;
  const access = relaySignupAccess(status);
  // Said before anyone tries, and again when a sign-in was refused for not being approved.
  const invite =
    access && (phase === "not-connected" || (phase === "failed" && connectError === "not-allowed"));
  // Creating an account is always the person's explicit choice, here and on the sign-in page.
  const connect = (intent) => run("connect", { termsAccepted: true, intent });
  const copy = {
    "not-connected": {
      title: "Enroll this gateway in your Omnesis Account",
      lede: "An Omnesis account lets you reach your gateway from your phone and laptop outside your home network and pair new devices by signing in. Traffic is encrypted end to end, and the keys never leave this gateway. Connecting gives this gateway a public address and a certificate.",
      action: html`<button
          type="button"
          class="btn-primary"
          disabled=${disabled}
          onClick=${() => connect("create")}
        >
          ${busy === "connect" ? "Connecting…" : "Create an Omnesis account"}
        </button>
        <button
          type="button"
          class="relay-quiet"
          disabled=${disabled}
          onClick=${() => connect("existing")}
        >
          I already have one
        </button>`,
    },
    waiting: {
      title: "Sign in to your Omnesis account",
      lede: "Continue in the sign-in tab to finish connecting. This page updates by itself.",
    },
    registering: {
      title: "Registering this gateway…",
      lede: "Getting its address and certificate. This usually takes less than a minute.",
    },
    linking: { title: "Connecting to your Omnesis account…", lede: "Almost done." },
    failed: {
      title: "Couldn't connect",
      lede: connectError
        ? relayError(connectError)
        : "The connection could not be set up. Nothing on this gateway changed.",
      action: html`<button
        type="button"
        class="btn-primary"
        disabled=${disabled}
        onClick=${() => connect()}
      >
        ${busy === "connect" ? "Connecting…" : "Try again"}
      </button>`,
    },
    connected: {
      title: html`Connected as <span class="relay-hostname">${hostname ?? "your gateway"}</span>`,
      lede: "Your devices can reach this gateway from anywhere. Traffic is encrypted end to end, and the keys never leave this gateway.",
    },
    reconnecting: {
      title: "Reconnecting…",
      lede: "Devices on your home network keep working. Devices away from home reconnect when the connection returns.",
    },
    disconnected: {
      title: "Disconnected",
      lede: status?.tunnel?.lastError
        ? relayError(status.tunnel.lastError)
        : "Remote access dropped. Devices on your home network keep working.",
      action: html`<button
        type="button"
        class="btn-primary"
        disabled=${disabled || !status?.can?.reconnect}
        onClick=${() => run("reconnect")}
      >
        ${busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
      </button>`,
    },
    off: {
      title: "Remote access is off",
      lede: "This gateway keeps its address. Turn remote access back on to reach it from anywhere.",
      action: html`<${TipButton}
        id="relay-turn-on-tip"
        tip=${TURN_ON_TIP}
        class="btn-primary"
        disabled=${disabled || !status?.can?.enable}
        onClick=${() => run("enable", {})}
      >
        ${busy === "enable" ? "Turning on…" : "Turn on"}
      <//>`,
    },
    unavailable: {
      title: "Remote access isn't available",
      lede: status?.serviceError
        ? relayError(status.serviceError)
        : "This installation is not set up for Omnesis accounts. Direct connections and QR pairing keep working.",
    },
  }[phase];
  const tone = TONES[phase];
  const dot = phase !== "not-connected";
  return html`<section class=${`relay-hero ${dot ? "" : "relay-hero-plain"}`} aria-live="polite">
    ${dot && html`<${Dot} tone=${tone} />`}
    <div class="relay-hero-text">
      <h2 class="relay-headline">${copy.title}</h2>
      <p class="relay-lede">${copy.lede}</p>
      ${invite && html`<${RequestAccess} access=${access} />`}
      ${copy.action && html`<div class="relay-actions relay-hero-action">${copy.action}</div>`}
      ${phase === "waiting" && html`<${Waiting} connect=${status.connect} busy=${busy} run=${run} />`}
    </div>
  </section>`;
}

function Waiting({ connect, busy, run }) {
  const authorizeUrl = relayHttpsUrl(connect.authorizeUrl);
  const connectUrl = relayHttpsUrl(connect.connectUrl);
  // The relay's short address is only shown; the link itself stays on the relay's own page.
  const shownUrl = relayHttpsUrl(connect.connectShortUrl) ?? connectUrl;
  const code =
    typeof connect.code === "string" && /^[A-Z0-9-]{4,16}$/.test(connect.code)
      ? connect.code
      : null;
  const expires = relayClock(connect.expiresAt);
  const disabled = Boolean(busy) && busy !== "refresh";
  return html`<div class="relay-waiting">
    <div class="relay-actions relay-hero-action">
      ${
        authorizeUrl &&
        html`<a
          class="btn-primary relay-button-link"
          href=${authorizeUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open sign-in
        </a>`
      }
      <button
        type="button"
        class="relay-quiet"
        disabled=${disabled}
        onClick=${() => run("connect/cancel", {})}
      >
        ${busy === "connect/cancel" ? "Cancelling…" : "Cancel"}
      </button>
    </div>
    ${
      connectUrl &&
      code &&
      html`<div class="relay-elsewhere">
        <p>
          Or on another device, visit${" "}
          <a href=${connectUrl} target="_blank" rel="noopener noreferrer"
            >${displayUrl(shownUrl)}</a
          >${" and enter"}
        </p>
        <p class="relay-code-line">
          <code class="relay-code">${code}</code>
          <${CopyIconButton} text=${code} class="relay-copy" title="Copy code" />
        </p>
        ${expires && html`<p class="relay-hint">The code works until ${expires}.</p>`}
      </div>`
    }
  </div>`;
}

function Row({ label, children, action }) {
  return html`<div class="relay-row">
    <div class="relay-row-label">${label}</div>
    <div class="relay-row-body">${children}</div>
    <div class="relay-row-action">${action}</div>
  </div>`;
}

/** The relay's own account page, where sign-in methods are added and removed. */
function ManageAccountLink({ serviceUrl }) {
  const service = relayHttpsUrl(serviceUrl);
  if (!service) return null;
  return html`<a
    class="btn-secondary relay-secondary-link"
    href=${new URL("/_relay/account", service).href}
    target="_blank"
    rel="noopener noreferrer"
  >
    Manage your account
  </a>`;
}

/**
 * Leaving the account is asked twice, in the page. The text follows what the
 * gateway does: it drops the account link and its trusted sign-ins, and leaves
 * remote access and paired devices alone.
 */
function Unlink({ operation, disabled, busy, run }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return html`<button
      type="button"
      class="relay-quiet"
      disabled=${disabled}
      onClick=${() => setAsking(true)}
    >
      Unlink this gateway
    </button>`;
  return html`<div class="relay-confirm" role="group" aria-labelledby="relay-unlink-title">
    <p class="relay-row-value" id="relay-unlink-title">
      Unlink this gateway from your Omnesis account?
    </p>
    <p class="relay-hint">
      This gateway leaves your Omnesis account. It can no longer be reached from outside your home
      network, and devices can no longer join by signing in. Devices already paired keep working on
      your home network.
    </p>
    <div class="relay-actions">
      <button
        type="button"
        class="btn-secondary relay-danger"
        disabled=${disabled}
        onClick=${async () => {
          await run(operation);
          setAsking(false);
        }}
      >
        ${busy === operation ? "Unlinking…" : "Unlink"}
      </button>
      <button type="button" class="relay-quiet" disabled=${disabled} onClick=${() => setAsking(false)}>
        Cancel
      </button>
    </div>
  </div>`;
}

function AccountRow({ status, busy, run }) {
  const account = status.account;
  const disabled = Boolean(busy) && busy !== "refresh";
  if (account?.activated || account?.configured || account?.linked || account?.pendingUnlink) {
    return html`<${Row} label="This gateway">
      <p class="relay-row-value">
        ${
          account.linked
            ? "This gateway is linked to your Omnesis account."
            : "This gateway is not linked to an Omnesis account."
        }
      </p>
      ${
        !account.linked &&
        html`<p class="relay-hint">
          ${
            account.pendingUnlink
              ? "Unlinked here. Your Omnesis account updates when the connection returns."
              : "Link it to find this gateway when you sign in on a new device. QR pairing works without an account."
          }
        </p>`
      }
      <div class="relay-actions relay-row-actions">
        ${account.linked && html`<${ManageAccountLink} serviceUrl=${status.config?.relayUrl} />`}
        ${
          !account.linked &&
          account.canLink &&
          html`<button
            type="button"
            class="btn-secondary"
            disabled=${disabled}
            onClick=${() => run("account/link")}
          >
            Connect to your Omnesis account
          </button>`
        }
        ${
          account.linked &&
          account.canUnlink &&
          html`<${Unlink}
            operation="account/unlink"
            disabled=${disabled}
            busy=${busy}
            run=${run}
          />`
        }
      </div>
    <//>`;
  }
  // `accountShown` already established that Google is configured or linked here.
  const google = status.google;
  const linkOrigin = relayHttpsUrl(google.linkOrigin);
  const linkHere = !linkOrigin || new URL(linkOrigin).origin === window.location?.origin;
  return html`<${Row} label="This gateway">
    <p class="relay-row-value">
      ${google.linked ? "This gateway is linked with Google." : "This gateway is not linked with Google."}
    </p>
    ${
      !google.linked &&
      html`<p class="relay-hint">
        Connect with Google to find this gateway on your other devices. QR pairing works without it.
      </p>`
    }
    <div class="relay-actions relay-row-actions">
      ${google.linked && html`<${ManageAccountLink} serviceUrl=${status.config?.relayUrl} />`}
      ${
        !google.linked &&
        google.canLink &&
        (linkHere
          ? html`<button
              type="button"
              class="btn-secondary google-sign-in-button"
              disabled=${disabled}
              onClick=${() => run("google/link")}
            >
              <img
                src="/portal/img/google-sign-in-mark.png"
                width="20"
                height="20"
                alt=""
                aria-hidden="true"
              />Connect with Google
            </button>`
          : html`<a class="relay-link" href=${new URL("/portal/settings/account", linkOrigin).href}
              >Connect with Google on the gateway's address</a
            >`)
      }
      ${
        google.linked &&
        google.canUnlink &&
        html`<${Unlink}
          operation="google/unlink"
          disabled=${disabled}
          busy=${busy}
          run=${run}
        />`
      }
    </div>
  <//>`;
}

/** Whether this gateway has an account row to show: an Omnesis account, or the older Google-only link. */
function accountShown(status) {
  const { account, google } = status;
  return Boolean(
    account?.activated ||
      account?.configured ||
      account?.linked ||
      account?.pendingUnlink ||
      google?.configured ||
      google?.linked,
  );
}

function AccountSection({ status, busy, run }) {
  if (!accountShown(status)) return null;
  return html`<section class="relay-section" aria-labelledby="relay-account-title">
    <h3 class="relay-section-title" id="relay-account-title">Account</h3>
    <div class="relay-rows">
      <${AccountRow} status=${status} busy=${busy} run=${run} />
    </div>
  </section>`;
}

/** One line on why the address cannot be used right now, or null once it is ready. */
function addressState(status) {
  if (!status.enabled) return "Not reachable while remote access is off.";
  if (status.publicMcp.ready) return null;
  if (status.tunnel?.state !== "online")
    return "Not reachable while this gateway is disconnected from the relay.";
  if (status.publicMcp.lastError) return "This address does not answer right now.";
  return "Checking that this address answers. This takes up to a minute after the gateway connects.";
}

const PORTAL_HINT =
  "Your portal is now reachable at this link from anywhere, not only at home. A new browser asks you to sign in with your Omnesis account.";

/** This gateway's portal at its public address, which works away from home too. */
function portalUrl(status) {
  const origin = relayHttpsUrl(status.publicOrigin);
  return origin ? new URL("/portal/", origin).href : null;
}

function RemoteAccess({ status, busy, run }) {
  const address = status.publicMcp?.url;
  const addressHint = addressState(status);
  // Shown alongside the address, once the gateway has one to offer.
  const portal = address ? portalUrl(status) : null;
  const disabled = Boolean(busy) && busy !== "refresh";
  return html`<section class="relay-section" aria-labelledby="relay-remote-access-title">
    <h3 class="relay-section-title" id="relay-remote-access-title">Remote access</h3>
    <div class="relay-rows">
      ${
        portal &&
        html`<${Row}
          label="Portal"
          action=${html`<${CopyIconButton} text=${portal} class="relay-copy" title="Copy portal link" />`}
        >
          <p class="relay-row-value relay-portal">
            <a href=${portal} target="_blank" rel="noopener noreferrer">${displayUrl(portal)}</a>
          </p>
          ${
            // Until the address answers, the line under the address says why.
            !addressHint &&
            html`<p class="relay-hint">${PORTAL_HINT}</p>`
          }
        <//>`
      }
      ${
        address &&
        html`<${Row}
          label="Address"
          action=${html`<${CopyIconButton} text=${address} class="relay-copy" title="Copy address" />`}
        >
          <p class="relay-row-value relay-mono relay-address">${address}</p>
          ${addressHint && html`<p class="relay-hint">${addressHint}</p>`}
        <//>`
      }
      <${Row}
        label="Status"
        action=${
          // While it is off, the headline's own button turns it on.
          status.enabled &&
          html`<${TipButton}
            id="relay-turn-off-tip"
            tip=${TURN_OFF_TIP}
            class="relay-quiet"
            disabled=${disabled || !status.can?.disable}
            onClick=${() => run("disable")}
          >
            ${busy === "disable" ? "Turning off…" : "Turn off"}
          <//>`
        }
      >
        <p class="relay-row-value">${status.enabled ? "On" : "Off"}</p>
      <//>
    </div>
  </section>`;
}

const POLICY_CHOICES = [
  {
    value: "automatic",
    title: "Join automatically",
    text: "A device joins once you sign in with a passkey or Google account you confirmed on this gateway, on its own page or in an Omnesis app. Other sign-ins wait for your approval. You're notified and can remove a device any time.",
  },
  {
    value: "ask",
    title: "Ask me first",
    text: "A device waits until you approve it on a device you already use, and the codes match. Someone with your Google password still can't get in.",
  },
];

function PolicyChoices({ name, value, disabled, onChange }) {
  return html`<div class="relay-options" role="radiogroup" aria-label="When a new device signs in">
    ${POLICY_CHOICES.map(
      (choice) =>
        html`<label
          class=${`relay-option ${value === choice.value ? "relay-option-selected" : ""}`}
        >
          <input
            type="radio"
            name=${name}
            value=${choice.value}
            checked=${value === choice.value}
            disabled=${disabled}
            onChange=${() => onChange(choice.value)}
          />
          <span>
            <span class="relay-option-title">${choice.title}</span>
            <span class="relay-option-text">${choice.text}</span>
          </span>
        </label>`,
    )}
  </div>`;
}

/** Where a trusted sign-in came from, in the words `omnesis cloud trusted-sign-ins` uses. */
const SIGN_IN_SOURCES = {
  "link-page": "Used to connect this gateway",
  approval: "Trusted when you approved a device",
  "native-app": "Trusted when you approved a device that signed in in the app",
  endorsed: "Added to your account later, vouched for by a sign-in trusted here",
  countersigned: "Already on your account, vouched for by a passkey added later",
};
const CONFIRMED_VIA = {
  "gateway-origin": "Confirmed on this gateway",
  "android-app": "Confirmed in the Android app",
  "native-google-approval": "Confirmed when you approved a device",
  "admin-app-google": "Confirmed from an Omnesis app",
};

/** The sign-ins this gateway trusts: what each is, where it came from, and whether it's confirmed. */
function TrustedSignIns({ enrollment }) {
  const pinned = enrollment.trustedSignIns ?? [];
  const confirmed = enrollment.confirmedSignIns ?? [];
  const rows = [
    ...pinned.map((signIn) => ({
      ...signIn,
      via: confirmed.find((value) => value.type === signIn.type && value.id === signIn.id)?.via,
    })),
    ...confirmed
      .filter((value) => !pinned.some((signIn) => signIn.type === value.type && signIn.id === value.id))
      .map((value) => ({ ...value, confirmed: true })),
  ];
  if (rows.length === 0) return null;
  return html`<div class="relay-sign-ins">
    <p class="relay-row-value relay-strong">Sign-ins</p>
    <ul class="relay-sign-in-list">
      ${rows.map((signIn) => {
        const source = signIn.source
          ? (SIGN_IN_SOURCES[signIn.source] ?? "Source not recorded")
          : undefined;
        const confirmation = signIn.via
          ? (CONFIRMED_VIA[signIn.via] ?? "Confirmed")
          : "Not confirmed on this gateway: devices using it wait for your approval";
        return html`<li class="relay-sign-in" key=${`${signIn.type}:${signIn.id}`}>
          <span class="relay-row-value">
            ${`${signIn.type === "passkey" ? "Passkey" : "Google account"} `}
            <span class="relay-mono">${String(signIn.id).slice(0, 12)}</span>
          </span>
          <span class="relay-hint">${[source, confirmation].filter(Boolean).join(" · ")}</span>
        </li>`;
      })}
    </ul>
  </div>`;
}

function NewDevices({ enrollment, held, busy, run }) {
  // While a certificate incident holds the gateway, the choice can't take effect, so it waits.
  const disabled = held || (Boolean(busy) && busy !== "refresh");
  return html`<section class="relay-section" aria-labelledby="relay-new-devices-title">
    <h3 class="relay-section-title" id="relay-new-devices-title">New devices</h3>
    ${
      !held &&
      (passkeyConfirmationNeeded(enrollment)
        ? html`<${GatewayPasskeyConfirm} enrollment=${enrollment} busy=${busy} run=${run} />`
        : enrollment.confirmationNeeded &&
          html`<p class="relay-notice" role="status">
            Every new device waits for your approval: no sign-in is confirmed on this gateway.
            Approve a device that signed in with Google in an Omnesis app, and choose to trust
            that Google account.
          </p>`)
    }
    <p class="relay-hint">What happens when a new device signs in to your Omnesis account.</p>
    ${
      held &&
      html`<p class="relay-hint">
        Every new device waits for your approval until the certificate problem above is dealt with.
      </p>`
    }
    <${PolicyChoices}
      name="relay-policy"
      value=${enrollment.policy}
      disabled=${disabled}
      onChange=${(policy) => policy !== enrollment.policy && run("enrollment", { policy }, "PUT")}
    />
    <${TrustedSignIns} enrollment=${enrollment} />
  </section>`;
}

function Skeleton() {
  return html`<section
    class="relay-hero relay-hero-plain relay-skeleton"
    aria-busy="true"
    aria-label="Loading your Omnesis account"
  >
    <div class="relay-hero-text">
      <span class="relay-skeleton-line relay-skeleton-title"></span>
      <span class="relay-skeleton-line"></span>
      <span class="relay-skeleton-line relay-skeleton-short"></span>
    </div>
  </section>`;
}

export function RelayView() {
  const { status, error, busy, run, version } = useRelayManagement();
  if (!status) {
    if (busy) return html`<div class="relay-view"><${Skeleton} /></div>`;
    return html`<div class="relay-view">
      <section class="relay-hero">
        <${Dot} tone="danger" />
        <div class="relay-hero-text">
          <h2 class="relay-headline">Couldn't load your Omnesis account</h2>
          <p class="relay-lede" role="alert">${error || "Check the connection and try again."}</p>
          <div class="relay-actions relay-hero-action">
            <button type="button" class="btn-secondary" onClick=${() => run()}>Try again</button>
          </div>
        </div>
      </section>
    </div>`;
  }
  const phase = relayPhase(status);
  const established = ["connected", "reconnecting", "disconnected", "off"].includes(phase);
  const linked = Boolean(status.account?.linked);
  const enrollment = linked && established ? status.deviceEnrollment : undefined;
  const problems = relayProblems(status, phase);
  // A failed connect or a dropped connection is said in the headline; the details still help.
  const troubled = problems.length > 0 || phase === "failed" || phase === "disconnected";
  return html`<div class="relay-view">
    <${Hero} status=${status} phase=${phase} busy=${busy} run=${run} />
    ${error && html`<p role="alert" class="relay-notice">${error}</p>`}
    ${
      status.notice === "account-deleted" &&
      html`<p role="status" class="relay-notice">
        Your Omnesis account was deleted, so this gateway is no longer linked to it and has no
        address outside your home network. Devices already paired keep working at home. You can
        link this gateway to another account.
      </p>`
    }
    ${
      troubled &&
      html`<${RelayProblems}
        messages=${problems}
        details=${relayDiagnostics(status, { phase, version })}
      />`
    }
    ${established && html`<${AccountSection} status=${status} busy=${busy} run=${run} />`}
    ${established && html`<${RemoteAccess} status=${status} busy=${busy} run=${run} />`}
    ${
      enrollment &&
      html`<${NewDevices}
        enrollment=${enrollment}
        held=${Boolean(status.incidentHold)}
        busy=${busy}
        run=${run}
      />`
    }
  </div>`;
}
