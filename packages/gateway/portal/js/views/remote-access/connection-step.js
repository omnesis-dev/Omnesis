// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Step 2 of the Remote access setup: how devices reach the gateway away from
// home. At home they always connect directly. The gateway's own Tailscale
// device (with that feature) and the Omnesis relay (with an enrolled account)
// are switched on and off here through their own routes; "Use my own setup"
// stands for Tailscale already on the computer or the owner's own address,
// and choosing it turns the other two off. When the Tailscale device and the
// relay are both on, the owner says which devices try first.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { setTailscaleEnabled } from "../../lib/tailscale-api.js";
import { updateRemoteAccess } from "../../lib/remote-access-api.js";
import { relayEstablished, relayPhase } from "../relay.js";
import { StatusPanel, TURN_OFF_CONFIRM, tailscalePhase } from "../tailscale.js";
import { OwnSetup } from "./own-setup.js";
import { BackButton, StepFrame, nextLabel } from "./step-frame.js";

/** One way in: a checkbox card, with what it needs (`body`) underneath while there is any. */
export function WayOption({ id, title, text, checked, disabled = false, onChange, body = null }) {
  return html`<div class=${`remote-access-option${checked ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}>
    <label class="remote-access-option-head" for=${id}>
      <input id=${id} type="checkbox" checked=${checked} disabled=${disabled} onChange=${(event) => onChange(event.currentTarget.checked)} />
      <span class="remote-access-option-text">
        <strong>${title}</strong>
        <small>${text}</small>
      </span>
    </label>
    ${body && html`<div class="remote-access-option-body">${body}</div>`}
  </div>`;
}

/** The Tailscale device's state under its option: signing in, waiting, or connected. */
function TailscaleInline({ tailscale }) {
  const { state, error, busy, run } = tailscale;
  const phase = tailscalePhase(state);
  if (!state) return null;
  return html`${error &&
    html`<p class="remote-access-problem" role="alert">
      ${error.message} <button type="button" class="remote-access-link" onClick=${() => error.retry()}>Try again</button>
    </p>`}
    ${phase === "connected"
      ? html`<p class="remote-access-ok" role="status">
          <span aria-hidden="true">✓ </span>Connected as <code>${state.node?.dnsName ?? state.deviceName}</code>${state.certificate?.source === "tailscale" ? ", with a trusted certificate." : "."}
        </p>`
      : phase !== "off" &&
        html`<div class="tailscale-view remote-access-tailscale" aria-live="polite">
          <${StatusPanel} state=${state} phase=${phase} busy=${busy} run=${run} />
        </div>`}`;
}

const RELAY_TEXT =
  "Reaches this gateway from any network, with nothing to install. Your traffic stays encrypted to this gateway; the relay carries it without reading it.";

/** The relay's connection under its option, once it is on. */
function RelayInline({ status, phase }) {
  if (phase === "connected")
    return html`<p class="remote-access-ok" role="status">
      <span aria-hidden="true">✓ </span>Connected${status.hostname && html` as <code>${status.hostname}</code>`}.
    </p>`;
  if (phase === "off") return null;
  return html`<p class="remote-access-muted" role="status">
    ${phase === "disconnected" ? "Disconnected. It reconnects by itself; Settings, Omnesis account says more." : "Connecting to the relay…"}
  </p>`;
}

const FIRST_CHOICES = [
  {
    value: "tailscale",
    title: "Tailscale",
    text: "Keeps traffic on your Tailscale network; the relay steps in when Tailscale is off on the device.",
  },
  {
    value: "relay",
    title: "Omnesis relay",
    text: "Works on every device first; Tailscale is used when the relay does not answer.",
  },
];

function FirstChoice({ remote, setRemote }) {
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const choose = async (first) => {
    if (first === remote.first) return;
    setSaving(first);
    setError("");
    try {
      setRemote(await updateRemoteAccess({ first }));
    } catch (cause) {
      setError(cause?.serverMessage || "Couldn't save the order. Try again.");
    } finally {
      setSaving("");
    }
  };
  const value = saving || remote.first;
  return html`<fieldset class="remote-access-first">
    <legend>When both can answer, try first</legend>
    ${FIRST_CHOICES.map(
      (choice) => html`<label key=${choice.value} class=${`remote-access-choice${value === choice.value ? " is-on" : ""}`}>
        <input
          type="radio"
          name="remote-access-first"
          value=${choice.value}
          checked=${value === choice.value}
          disabled=${Boolean(saving)}
          onChange=${() => choose(choice.value)}
        />
        <span class="remote-access-option-text"><strong>${choice.title}</strong><small>${choice.text}</small></span>
      </label>`,
    )}
    <p class="remote-access-muted">Your home network always comes first, whatever you pick.</p>
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}
  </fieldset>`;
}

export function ConnectionStep({
  flow,
  steps,
  headingRef,
  error,
  onStep,
  onNext,
  onBack,
  last,
  remote,
  setRemote,
  relay,
  tailscale,
  tailscaleEmbed,
  onFlow,
  onGetAccount,
}) {
  // Which confirmation is open: turning the Tailscale device off, or choosing the owner's own setup.
  const [confirming, setConfirming] = useState("");
  const relayStatus = relay?.status;
  const phase = relayPhase(relayStatus);
  const relayReady = relayEstablished(phase);
  const relayOn = relayReady && relayStatus.enabled === true;
  const relayBusy = Boolean(relay?.busy) && relay.busy !== "refresh";
  const tailscaleOn = tailscale?.state?.enabled === true;
  const tailscaleBusy = Boolean(tailscale?.busy) && tailscale.busy !== "refresh";
  // A box follows the change under way, then the gateway's answer.
  const shown = (busy, on) => (busy === "enable" ? true : busy === "disable" ? false : on);

  const setTailscale = (enabled) =>
    tailscale.run(enabled ? "enable" : "disable", (signal) => setTailscaleEnabled(enabled, signal));
  const setRelay = (enabled) => relay.run(enabled ? "enable" : "disable", {});
  const chooseTailscale = (checked) => {
    if (!checked) return setConfirming("tailscale-off");
    onFlow({ self: false });
    void setTailscale(true);
  };
  const chooseRelay = (checked) => {
    if (checked) onFlow({ self: false });
    void setRelay(checked);
  };
  const chooseSelf = (checked) => {
    if (checked && (tailscaleOn || relayOn)) return setConfirming("self");
    onFlow({ self: checked });
  };
  const confirm = async () => {
    const which = confirming;
    setConfirming("");
    if (which === "tailscale-off") {
      await setTailscale(false);
      return;
    }
    // A way that would not turn off says why on its own option, and the owner's setup waits.
    if (relayOn && (await setRelay(false)) === undefined) return;
    if (tailscaleOn && (await setTailscale(false)) === undefined) return;
    onFlow({ self: true });
  };

  const relayText = relayReady
    ? RELAY_TEXT
    : html`Needs an Omnesis account.${" "}<button type="button" class="remote-access-link" onClick=${onGetAccount}>Set one up in step 1</button>; your choices here are kept.`;
  const offWays = [tailscaleOn && "the gateway's own Tailscale device", relayOn && "the Omnesis relay"].filter(Boolean);

  return html`<${StepFrame}
    flow=${flow}
    steps=${steps}
    heading="How should your devices reach this gateway when they are away from home?"
    blurb="At home they always connect directly, over your home network. Choose one or both."
    headingRef=${headingRef}
    error=${error}
    onStep=${onStep}
    actions=${html`<${BackButton} onBack=${onBack} />
      <button type="button" class="btn-primary" onClick=${onNext}>${nextLabel(flow, last)}</button>`}
  >
    <div class="remote-access-options">
      ${tailscaleEmbed &&
      html`<${WayOption}
        id="remote-access-way-tailscale"
        title="Give this gateway its own Tailscale device"
        text="Your phone and laptop reach it through your Tailscale network. Each needs the Tailscale app."
        checked=${shown(tailscale.busy, tailscaleOn)}
        disabled=${!tailscale.state || tailscaleBusy}
        onChange=${chooseTailscale}
        body=${(tailscaleOn || tailscale.error) && html`<${TailscaleInline} tailscale=${tailscale} />`}
      />`}
      ${relay &&
      html`<${WayOption}
        id="remote-access-way-relay"
        title="Use the Omnesis relay"
        text=${relayText}
        checked=${shown(relay.busy, relayOn)}
        disabled=${!relayReady || relayBusy || !(relayOn ? relayStatus.can?.disable : relayStatus.can?.enable)}
        onChange=${chooseRelay}
        body=${(relayOn || relay.error) &&
        html`${relayOn && html`<${RelayInline} status=${relayStatus} phase=${phase} />`}
          ${relay.error && html`<p class="remote-access-problem" role="alert">${relay.error}</p>`}`}
      />`}
      <${WayOption}
        id="remote-access-way-self"
        title="Use my own setup"
        text=${tailscaleEmbed
          ? "Tailscale already on this computer, or a domain you publish yourself. Omnesis checks that it works."
          : "A domain or reverse proxy you publish yourself. Omnesis checks that it works."}
        checked=${flow.self}
        onChange=${chooseSelf}
        body=${flow.self &&
        html`<${OwnSetup}
          remote=${remote}
          setRemote=${setRemote}
          tailscaleEmbed=${tailscaleEmbed}
          own=${flow.own}
          url=${flow.url}
          onFlow=${onFlow}
        />`}
      />
      ${tailscaleOn && relayOn && html`<${FirstChoice} remote=${remote} setRemote=${setRemote} />`}
    </div>
    <${ConfirmModal}
      open=${confirming === "tailscale-off"}
      ...${TURN_OFF_CONFIRM}
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
    <${ConfirmModal}
      open=${confirming === "self"}
      title="Use your own setup instead?"
      body=${`This turns off ${offWays.join(" and ")}. Devices that reach this gateway through them lose access away from home until your own setup works.`}
      confirmLabel="Turn off and continue"
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
  <//>`;
}
