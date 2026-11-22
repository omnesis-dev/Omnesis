// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Step 1 of the Connectivity setup, only with the cloud relay: whether the
// owner wants an Omnesis account. It runs the relay's own connect flow — the
// sign-in tab with its code, the registration, then "Finish setting up". A
// linked gateway can be unlinked here, and "Manage account" opens the Omnesis
// account page behind Settings → Connectivity for everything else about it.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { FinishSetup, openOnGateway } from "../../components/gateway-passkey-confirm.js";
import {
  acknowledgeExistingAccount,
  relayError,
  relayHttpsUrl,
  relayInvite,
  relayInviteOnly,
} from "../../lib/cloud-relay-api.js";
import {
  UNLINK_CONFIRM,
  Waiting,
  relayAccountSetup,
  relayPhase,
  usePasskeyHandoff,
  useSetupLater,
} from "../relay.js";
import { useConnectWindow } from "../../lib/connect-window.js";
import { ACCOUNT_PAGE, ManageButton } from "./manage.js";
import { accountState } from "./model.js";
import { BackButton, StepFrame, nextLabel } from "./step-frame.js";

const COPY = {
  loading: { heading: "Your Omnesis account", blurb: "Loading…" },
  unavailable: {
    heading: "Omnesis accounts aren't available here",
    blurb: "This installation is not set up for Omnesis accounts. Direct connections and QR pairing keep working.",
  },
  none: {
    heading: "Do you want an Omnesis account?",
    blurb:
      "It helps your devices find this gateway: your phone signs in instead of scanning a QR code, and a new device can ask to join from anywhere. None of your data goes to Omnesis: your documents, searches and answers stay on this gateway, and the account knows only your sign-in and which gateways are yours.",
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
  unfinished: { heading: "Connecting didn't finish", blurb: "" },
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

/**
 * The invite the person is typing, whether they edited it since they last pressed to connect,
 * and whether they chose to try an unfinished connection again, kept by whichever view shows
 * the account choice.
 */
export function useInvite() {
  const [invite, setInviteValue] = useState("");
  const [edited, setEdited] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const setInvite = (value) => {
    setInviteValue(value);
    setEdited(true);
  };
  return { invite, setInvite, edited, setEdited, retrying, setRetrying };
}

/** Why connecting didn't finish, in one sentence. */
export function unfinishedReason(status) {
  const error = status?.unfinished?.error;
  return error
    ? relayError(error)
    : "It stopped before the sign-in or the security check was completed.";
}

/** Why connecting didn't finish, and what each way on does. */
function unfinishedBlurb(status) {
  return `${unfinishedReason(status)} This gateway has reserved an address but can't be reached at it yet. Try again to continue with that address, or start over to discard it and begin from scratch.`;
}

/** What connecting agrees to, said once beside the buttons that connect. */
function TermsLine({ status }) {
  const url = relayHttpsUrl(status?.config?.acmeTermsUrl);
  if (!url) return null;
  return html`<p class="relay-hint relay-terms">
    By connecting, you agree to${" "}
    <a href=${url} target="_blank" rel="noopener noreferrer">Let's Encrypt's Subscriber Agreement</a>.
  </p>`;
}

/** How long the existing-account notice is in view before it counts as seen. */
export const NOTICE_SEEN_MS = 5000;

/**
 * Said once the owner chose to create an account but signed in with one that already existed:
 * the gateway is linked to that account, and the invite is still unused. It is said once:
 * after it has been in view for `NOTICE_SEEN_MS`, the gateway is told it was seen and its status
 * stops saying it, while this page keeps it until connecting is no longer what it shows. Seen
 * only briefly, as when the page hands over to the gateway's own address straight away, it is
 * said again there.
 */
export function ExistingAccountNotice({ status, acknowledge = acknowledgeExistingAccount }) {
  const done = status?.connect?.state === "done";
  const said = done && status.connect.existingAccount === true;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (said) setShown(true);
    else if (!done) setShown(false);
  }, [said, done]);
  useEffect(() => {
    if (!said) return undefined;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") timer = setTimeout(() => void acknowledge(), NOTICE_SEEN_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [said]);
  if (!said && !(shown && done)) return null;
  return html`<p role="status" class="relay-notice">
    You already had an Omnesis account, so this gateway is now linked to it. Your invite wasn't used.
  </p>`;
}

/**
 * Where the invite link goes. Only creating an account needs it. What is wrong with it is said
 * right under it: a link cut short as it is typed, or `refusal`, why the relay refused it.
 */
function InviteField({ value, onInput, disabled, refusal = "" }) {
  const incomplete = value.trim() !== "" && !relayInvite(value);
  const problem = refusal || (incomplete ? "That isn't a whole invite link. Copy all of it, including the part after #." : "");
  return html`<div class="relay-invite-field">
    <label for="relay-invite-input">Invite link</label>
    <input
      id="relay-invite-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="Paste the invite link you were sent"
      value=${value}
      disabled=${disabled}
      aria-invalid=${problem ? "true" : "false"}
      aria-describedby=${problem ? "relay-invite-problem" : undefined}
      onInput=${(event) => onInput(event.currentTarget.value)}
    />
    ${problem && html`<p id="relay-invite-problem" class="relay-invite-problem" role="alert">${problem}</p>`}
  </div>`;
}

/**
 * Connecting an Omnesis account, by the relay's status: the heading, the words
 * under it, what shows beneath (the assurance, the invite, waiting for the
 * sign-in) and the buttons that connect. Step 1 places them in its frame, with
 * its own way on; the account page shows them as its header until an account
 * is linked, so both offer exactly the same choice.
 */
export function accountConnect(
  relay,
  {
    invite = "",
    setInvite = () => {},
    edited = false,
    setEdited = () => {},
    retrying = false,
    setRetrying = () => {},
  } = {},
) {
  const { status, busy, run } = relay;
  const state = accountState(status);
  const disabled = Boolean(busy) && busy !== "refresh";
  const inviteOnly = relayInviteOnly(status);
  const token = relayInvite(invite);
  // Creating an account is always the person's explicit choice, here and on the sign-in page.
  const connect = (intent) => {
    setRetrying(false);
    setEdited(false);
    return run("connect", {
      termsAccepted: true,
      intent,
      ...(intent === "create" && token ? { invite: token } : {}),
    });
  };
  // Editing the invite answers what it was refused for, so the refusal goes only then.
  const editInvite = (value) => {
    setInvite(value);
    if (/^invite-/.test(relay.errorCode ?? "")) relay.clearError?.();
  };
  // A refused invite brings back the choice, with the invite field to fix it.
  const inviteRefused =
    state === "failed" && /^invite-/.test(status.connect?.error ?? "");
  // Why the invite was refused is said under it until the person edits it: refused as they
  // pressed to connect, or once the relay had checked it.
  const refusedNow = /^invite-/.test(relay.errorCode ?? "");
  const refusal = refusedNow
    ? relay.error
    : inviteRefused && !edited
      ? relayError(status.connect.error)
      : "";
  // Trying an unfinished connection again is the same choice: the sign-in decides the account.
  const choosing = state === "none" || inviteRefused || (state === "unfinished" && retrying);
  // The refusal is said under the invite field where there is one; elsewhere where it always was.
  const fieldShown = choosing && inviteOnly;
  const underField = inviteRefused && fieldShown;
  const copy = underField ? COPY.none : state === "waiting" && status.connect?.verification ? {
    heading: "Verify this gateway's setup",
    blurb: "Open the security check to get this gateway's public address. Cloudflare usually checks automatically; it may ask you to confirm you're human. No approval from Omnesis is needed.",
  } : state === "waiting" && status.connect?.intent === "create" ? {
    heading: "Create your Omnesis account",
    blurb: "Continue in the new tab to create your account and finish connecting. This page updates by itself.",
  } : COPY[state];
  const blurb =
    state === "unavailable" && status.serviceError
      ? relayError(status.serviceError)
      : state === "failed" && !underField && (status.connect?.error ?? status.enrollment?.error)
        ? relayError(status.connect?.error ?? status.enrollment?.error)
        : state === "unfinished"
          ? unfinishedBlurb(status)
          : copy.blurb;
  // Before any account, everything to know is one paragraph: what it does, what it never
  // sees, that new accounts need an invite, and that it can wait.
  const fullBlurb =
    state === "none" || underField
      ? html`${blurb}${inviteOnly &&
          " Omnesis accounts are private and invite-only for now: creating one needs an invite link. "}
        It's optional: skip it and set it up any time from Settings, Connectivity.`
      : blurb;
  const choice = html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${() => connect("existing")}>
      I already have one
    </button>
    <button
      type="button"
      class="btn-primary"
      disabled=${disabled || (inviteOnly && !token)}
      title=${inviteOnly && !token ? "Paste your invite link first" : undefined}
      onClick=${() => connect("create")}
    >
      ${busy === "connect" ? "Connecting…" : "Create an account"}
    </button>`;
  const startOver = html`<button
    type="button"
    class="btn-secondary"
    disabled=${disabled || !status?.can?.startOver}
    title="Discard the address this gateway reserved and connect from the beginning"
    onClick=${() => run("start-over", {})}
  >
    ${busy === "start-over" ? "Starting over…" : "Start over"}
  </button>`;
  const buttons = {
    none: choice,
    unfinished: retrying
      ? choice
      : html`${startOver}
          <button type="button" class="btn-primary" disabled=${disabled} onClick=${() => setRetrying(true)}>
            Try again
          </button>`,
    failed: inviteRefused
      ? choice
      : html`<button type="button" class="btn-primary" disabled=${disabled} onClick=${() => connect()}>
          ${busy === "connect" ? "Connecting…" : "Try again"}
        </button>`,
    enrolled:
      status?.account?.canLink &&
      html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${() => run("account/link")}>
        Connect to your Omnesis account
      </button>`,
  }[state] ?? null;
  const body = html`${relay.error && !(refusedNow && fieldShown) && html`<p role="alert" class="relay-notice">${relay.error}</p>`}
    ${state === "loading" && !busy && html`<button type="button" class="btn-secondary" onClick=${() => run()}>Try again</button>`}
    ${fieldShown &&
    html`<p class="relay-private-badge">Private · invite only</p>
      <${InviteField} value=${invite} onInput=${editInvite} disabled=${disabled} refusal=${refusal} />`}
    ${(choosing || state === "failed") && html`<${TermsLine} status=${status} />`}
    ${state === "waiting" && html`<${Waiting} connect=${status.connect} busy=${busy} run=${run} />`}`;
  return { state, heading: copy.heading, blurb: fullBlurb, body, buttons, disabled };
}

/** The account page's header until an account is linked: the same choice as step 1. */
export function AccountConnect({ relay }) {
  const { heading, blurb, body, buttons } = accountConnect(relay, useInvite());
  return html`<section class="relay-hero relay-hero-plain" aria-live="polite">
    <div class="relay-hero-text">
      <h2 class="relay-headline">${heading}</h2>
      <p class="relay-lede">${blurb}</p>
      <div class="relay-view remote-access-relay">${body}</div>
      ${buttons && html`<div class="relay-actions relay-hero-action">${buttons}</div>`}
    </div>
  </section>`;
}

export function AccountStep({
  flow,
  steps,
  headingRef,
  error,
  onStep,
  onNext,
  onCancel,
  onBack,
  last,
  relay,
  open = openOnGateway,
  location = globalThis.location,
}) {
  const { status, busy, run } = relay;
  const phase = relayPhase(status);
  const { state, heading, blurb, body, buttons, disabled } = accountConnect(relay, useInvite());
  const [later, chooseLater] = useSetupLater(status?.gatewayId);
  const { enrollment, setup, ready } = relayAccountSetup(status, phase);
  usePasskeyHandoff({ phase, enrollment, setup, ready, later, open, location });
  useConnectWindow(status?.connect);
  const [unlinking, setUnlinking] = useState(false);
  const google = !status?.account?.linked && status?.google?.linked;

  const checklist = state === "linked" && setup && !later && phase === "connected";
  // Beside the checklist's own button, moving on is the quieter choice.
  const forward = html`<button type="button" class=${checklist ? "btn-secondary" : "btn-primary"} disabled=${disabled} onClick=${onNext}>
    ${nextLabel(last)}
  </button>`;
  const unlinkOperation = google ? "google/unlink" : "account/unlink";
  const canUnlink = state === "linked" && (google ? status.google.canUnlink : status.account?.canUnlink);
  const unlink =
    canUnlink &&
    html`<button type="button" class="btn-secondary relay-danger" disabled=${disabled} onClick=${() => setUnlinking(true)}>
      ${busy === unlinkOperation ? "Unlinking…" : "Unlink this gateway"}
    </button>`;
  const manage = html`<${ManageButton} href=${ACCOUNT_PAGE} label="Manage account" disabled=${disabled} />`;
  const skip = html`<button type="button" class="btn-secondary" disabled=${disabled} onClick=${onNext}>Skip for now</button>`;
  const actions = {
    none: html`${skip} ${buttons}`,
    failed: html`${skip} ${buttons}`,
    unfinished: html`${skip} ${buttons}`,
    enrolled: html`${buttons} ${manage} ${forward}`,
    linked: html`${unlink} ${manage} ${forward}`,
  }[state] ?? (["waiting", "registering", "linking", "loading"].includes(state) ? null : forward);

  return html`<${StepFrame}
    flow=${flow}
    steps=${steps}
    heading=${state === "linked" && google ? "This gateway is linked with Google" : heading}
    blurb=${blurb}
    headingRef=${headingRef}
    error=${error}
    onStep=${onStep}
    onCancel=${onCancel}
    actions=${html`<${BackButton} onBack=${onBack} disabled=${disabled} />${actions}`}
  >
    <div class="relay-view remote-access-relay">
      ${body}
      <${ExistingAccountNotice} status=${status} />
      ${checklist &&
      html`<${FinishSetup}
        enrollment=${enrollment}
        ready=${ready}
        serviceUrl=${status.config?.relayUrl}
        busy=${busy}
        run=${run}
        open=${open}
        location=${location}
        onDismiss=${() => chooseLater(true)}
      />`}
    </div>
    <${ConfirmModal}
      open=${unlinking}
      ...${UNLINK_CONFIRM}
      confirmLabel="Unlink"
      destructive
      onConfirm=${() => {
        setUnlinking(false);
        void run(unlinkOperation);
      }}
      onCancel=${() => setUnlinking(false)}
    />
  <//>`;
}
