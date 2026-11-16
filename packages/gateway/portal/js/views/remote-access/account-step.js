// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Step 1 of the Remote access setup, only with the cloud relay: whether the
// owner wants an Omnesis account. It runs the relay's own connect flow — the
// sign-in tab with its code, the registration, then "Finish setting up" — and
// leaves the account's own settings on Settings → Omnesis account.

import { html } from "htm/preact";
import { FinishSetup, openOnGateway } from "../../components/gateway-passkey-confirm.js";
import { relayError, relaySignupAccess } from "../../lib/cloud-relay-api.js";
import {
  RequestAccess,
  Unlink,
  Waiting,
  relayAccountSetup,
  relayPhase,
  usePasskeyHandoff,
  useSetupLater,
} from "../relay.js";
import { accountState } from "./model.js";
import { BackButton, StepFrame, nextLabel } from "./step-frame.js";

const ASSURANCE = html`<p class="remote-access-assure">
  <strong>None of your data goes to Omnesis.</strong> Your documents, searches and answers stay on
  this gateway. The account knows your sign-in and which gateways are yours, nothing else.
</p>`;

const COPY = {
  loading: { heading: "Your Omnesis account", blurb: "Loading…" },
  unavailable: {
    heading: "Omnesis accounts aren't available here",
    blurb: "This installation is not set up for Omnesis accounts. Direct connections and QR pairing keep working.",
  },
  none: {
    heading: "Do you want an Omnesis account?",
    blurb:
      "It helps your devices find this gateway: your phone signs in instead of scanning a QR code, and a new device can ask to join from anywhere. It also makes the Omnesis relay available.",
  },
  waiting: {
    heading: "Sign in to your Omnesis account",
    blurb: "Continue in the sign-in tab to finish connecting. This page updates by itself.",
  },
  registering: {
    heading: "Registering this gateway…",
    blurb: "Getting its address and certificate. This usually takes less than a minute.",
  },
  linking: { heading: "Connecting to your Omnesis account…", blurb: "Almost done." },
  failed: { heading: "Couldn't connect", blurb: "The connection could not be set up. Nothing on this gateway changed." },
  linked: {
    heading: "This gateway is linked to your Omnesis account",
    blurb: "Your apps find this gateway by signing in, and new devices can ask to join from anywhere.",
  },
  enrolled: {
    heading: "Link this gateway to your Omnesis account",
    blurb:
      "This gateway is registered with the Omnesis relay but linked to no account. Link it to find this gateway when you sign in on a new device.",
  },
};

export function AccountStep({
  flow,
  steps,
  headingRef,
  error,
  onStep,
  onNext,
  onBack,
  last,
  relay,
  open = openOnGateway,
  location = globalThis.location,
}) {
  const { status, busy, run } = relay;
  const phase = relayPhase(status);
  const state = accountState(status);
  const [later, chooseLater] = useSetupLater(status?.gatewayId);
  const { enrollment, setup, ready } = relayAccountSetup(status, phase);
  usePasskeyHandoff({ phase, enrollment, setup, ready, later, open, location });
  const disabled = Boolean(busy) && busy !== "refresh";
  // Creating an account is always the person's explicit choice, here and on the sign-in page.
  const connect = (intent) => run("connect", { termsAccepted: true, intent });
  const google = !status?.account?.linked && status?.google?.linked;
  const copy = COPY[state];
  const blurb =
    state === "unavailable" && status.serviceError
      ? relayError(status.serviceError)
      : state === "failed" && (status.connect?.error ?? status.enrollment?.error)
        ? relayError(status.connect?.error ?? status.enrollment?.error)
        : copy.blurb;
  const access = relaySignupAccess(status);
  const invite = access && (state === "none" || (state === "failed" && status.connect?.error === "not-allowed"));

  const checklist = state === "linked" && setup && !later && phase === "connected";
  // Beside the checklist's own button, moving on is the quieter choice.
  const forward = html`<button type="button" class=${checklist ? "btn-secondary" : "btn-primary"} disabled=${disabled} onClick=${onNext}>
    ${state === "linked" && flow.mode === "review" ? "Keep it" : nextLabel(flow, last)}
  </button>`;
  const skip = html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${onNext}>Skip for now</button>`;
  const actions = {
    none: html`${skip}
      <button type="button" class="btn-secondary" disabled=${disabled} onClick=${() => connect("existing")}>
        I already have one
      </button>
      <button type="button" class="btn-primary" disabled=${disabled} onClick=${() => connect("create")}>
        ${busy === "connect" ? "Connecting…" : "Create an account"}
      </button>`,
    failed: html`${skip}
      <button type="button" class="btn-primary" disabled=${disabled} onClick=${() => connect()}>
        ${busy === "connect" ? "Connecting…" : "Try again"}
      </button>`,
    enrolled: html`${status?.account?.canLink &&
      html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${() => run("account/link")}>
        Connect to your Omnesis account
      </button>`}
      ${forward}`,
  }[state] ?? (["waiting", "registering", "linking", "loading"].includes(state) ? null : forward);

  return html`<${StepFrame}
    flow=${flow}
    steps=${steps}
    heading=${state === "linked" && google ? "This gateway is linked with Google" : copy.heading}
    blurb=${blurb}
    headingRef=${headingRef}
    error=${error}
    onStep=${onStep}
    actions=${html`<${BackButton} onBack=${onBack} disabled=${disabled} />${actions}`}
  >
    <div class="relay-view remote-access-relay">
      ${relay.error && html`<p role="alert" class="relay-notice">${relay.error}</p>`}
      ${state === "loading" && !busy && html`<button type="button" class="btn-secondary" onClick=${() => run()}>Try again</button>`}
      ${state === "none" && ASSURANCE}
      ${invite && html`<${RequestAccess} access=${access} />`}
      ${state === "waiting" && html`<${Waiting} connect=${status.connect} busy=${busy} run=${run} />`}
      ${checklist &&
      html`<${FinishSetup}
        enrollment=${enrollment}
        hostname=${status.hostname}
        ready=${ready}
        serviceUrl=${status.config?.relayUrl}
        busy=${busy}
        run=${run}
        open=${open}
        location=${location}
        onDismiss=${() => chooseLater(true)}
      />`}
      ${state === "linked" &&
      flow.mode === "review" &&
      (google ? status.google.canUnlink : status.account?.canUnlink) &&
      html`<${Unlink}
        operation=${google ? "google/unlink" : "account/unlink"}
        disabled=${disabled}
        busy=${busy}
        run=${run}
      />`}
    </div>
  <//>`;
}
