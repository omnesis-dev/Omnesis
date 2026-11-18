// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Step 2 of the Connectivity setup: how devices reach the gateway away from
// home. At home they always connect directly. The gateway's own Tailscale
// device (with that feature) and the Omnesis relay (with an enrolled account)
// are switched on and off here through their own routes; Tailscale already on
// the computer (with that feature) and the owner's own domain are set up in
// their panels. All four are independent and can all be on at once. When the Tailscale
// device and the relay are both on, the owner says which devices try first.
// Each option links to the full page that manages it.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { setTailscaleEnabled } from "../../lib/tailscale-api.js";
import { updateRemoteAccess } from "../../lib/remote-access-api.js";
import { relayEstablished, relayPhase } from "../relay.js";
import { StatusPanel, tailscalePhase, turnOffConfirm } from "../tailscale.js";
import { HostTailscale, InstallTailscale, OwnAddress, useHostTailscale } from "./own-setup.js";
import { ManageButton, RELAY_PAGE, TAILSCALE_PAGE } from "./manage.js";
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
    ${phase === "disconnected" ? "Disconnected. It reconnects by itself; Manage relay says more." : "Connecting to the relay…"}
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

/** Which way devices try first when both the Tailscale device and the relay can answer; step 2 and the summary show it. */
export function FirstChoice({ remote, setRemote }) {
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
  const picked = FIRST_CHOICES.find((choice) => choice.value === value);
  return html`<fieldset class="remote-access-choices is-compact remote-access-first">
    <legend>When both can answer, try first</legend>
    ${FIRST_CHOICES.map(
      (choice) => html`<label key=${choice.value} class=${`remote-access-choice${value === choice.value ? " is-on" : ""}`} title=${choice.text}>
        <input
          type="radio"
          name="remote-access-first"
          value=${choice.value}
          checked=${value === choice.value}
          disabled=${Boolean(saving)}
          onChange=${() => choose(choice.value)}
        />
        <span class="remote-access-option-text"><strong>${choice.title}</strong></span>
      </label>`,
    )}
    <p class="remote-access-choice-detail">${picked ? `${picked.text} ` : ""}Your home network always comes first.</p>
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
  onCancel,
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
  const firstHost = useHostTailscale();
  // What Tailscale on this computer does, as its panel last read it, and whether that
  // still differs from the owner's choice.
  const [hostNow, setHostNow] = useState(null);
  const host = hostNow?.host ?? firstHost;
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
  // The three ways in are independent: any of them can be on beside the others.
  const chooseTailscale = (checked) => {
    if (!checked) return setConfirming("tailscale-off");
    void setTailscale(true);
  };
  const chooseRelay = (checked) => void setRelay(checked);
  const chooseHost = (checked) => onFlow({ host: checked });
  // Ticked when the owner ticked it, or, until they choose, when this computer already serves the gateway.
  const hostChosen = (flow.host ?? host?.servesGateway === true) && host?.state !== "missing";
  // Unticked while it still serves the gateway, its panel stays to stop that.
  const hostShown = hostChosen || (host?.state === "available" && host.servesGateway);
  const hostPending = hostShown && hostNow?.pending === true;
  const chooseDomain = (checked) => onFlow({ domain: checked });
  const confirm = async () => {
    setConfirming("");
    await setTailscale(false);
  };

  const relayText = relayReady
    ? RELAY_TEXT
    : html`Needs an Omnesis account.${" "}<button type="button" class="remote-access-link" onClick=${onGetAccount}>Set one up in step 1</button>; your choices here are kept.`;

  return html`<${StepFrame}
    flow=${flow}
    steps=${steps}
    heading="How should your devices reach this gateway when they are away from home?"
    blurb="At home they always connect directly, over your home network. Choose any of these; they work side by side."
    headingRef=${headingRef}
    error=${error}
    onStep=${onStep}
    onCancel=${onCancel}
    actions=${html`<${BackButton} onBack=${onBack} />
      <button type="button" class="btn-primary" disabled=${hostPending} onClick=${onNext}>${nextLabel(last)}</button>`}
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
        body=${(tailscaleOn || tailscale.error) &&
        html`<${TailscaleInline} tailscale=${tailscale} />
          ${tailscaleOn &&
          html`<p class="remote-access-more">
            <${ManageButton} href=${TAILSCALE_PAGE} label="Manage Tailscale device" />
          </p>`}`}
      />`}
      ${host?.state !== "unsupported" &&
      html`<${WayOption}
        id="remote-access-way-host"
        title="Tailscale on this computer"
        text=${host?.state === "missing"
          ? html`Install Tailscale on this computer to use this.${" "}<${InstallTailscale} />`
          : "Serve this gateway from the Tailscale app already on this computer."}
        checked=${hostChosen}
        disabled=${host?.state === "missing"}
        onChange=${chooseHost}
        body=${hostShown &&
        html`<${HostTailscale} remote=${remote} setRemote=${setRemote} wanted=${hostChosen} onState=${setHostNow} />`}
      />`}
      ${relay &&
      html`<${WayOption}
        id="remote-access-way-relay"
        title="Use the Omnesis relay"
        text=${relayText}
        checked=${shown(relay.busy, relayOn)}
        disabled=${!relayReady || relayBusy || !(relayOn ? relayStatus.can?.disable : relayStatus.can?.enable)}
        onChange=${chooseRelay}
        body=${(relayReady || relay.error) &&
        html`${relayOn && html`<${RelayInline} status=${relayStatus} phase=${phase} />`}
          ${relay.error && html`<p class="remote-access-problem" role="alert">${relay.error}</p>`}
          ${relayReady &&
          html`<p class="remote-access-more">
            <${ManageButton} href=${RELAY_PAGE} label="Manage relay" />
          </p>`}`}
      />`}
      <${WayOption}
        id="remote-access-way-domain"
        title="My own domain or reverse proxy"
        text="An https address you run in front of this gateway. Omnesis checks that it works."
        checked=${flow.domain}
        onChange=${chooseDomain}
        body=${flow.domain &&
        html`<${OwnAddress} remote=${remote} setRemote=${setRemote} url=${flow.url} onUrl=${(value) => onFlow({ url: value })} />`}
      />
      ${tailscaleOn && relayOn && html`<${FirstChoice} remote=${remote} setRemote=${setRemote} />`}
    </div>
    ${hostPending &&
    html`<p class="remote-access-muted" role="status">
      ${hostChosen
        ? "Set up Tailscale on this computer, or untick it, to continue."
        : "Stop serving this gateway from Tailscale on this computer, or tick it again, to continue."}
    </p>`}
    <${ConfirmModal}
      open=${confirming === "tailscale-off"}
      ...${turnOffConfirm(tailscale?.state)}
      destructive
      onConfirm=${confirm}
      onCancel=${() => setConfirming("")}
    />
  <//>`;
}
