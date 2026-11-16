// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Remote access: how this gateway's devices reach it when they are
// away from home. Only rendered when the gateway runs with the cloud relay
// (OMNESIS_CLOUD_RELAY_ENABLED=1), its own Tailscale device
// (OMNESIS_TAILSCALE_EMBED_ENABLED=1), or both; `/status` advertises each as
// `cloudRelay` and `tailscaleEmbed`.
//
// The first visit opens a guided setup that asks one question per screen: the
// Omnesis account (with the relay), the remote connection, then what new
// devices may do. Afterwards the page is a short summary; "Review settings"
// walks the same steps again, each asking whether it is still right. Every
// answer is applied at once through the relay's and the Tailscale device's own
// routes, with their step-ups and checks; this page keeps only where the owner
// is in the setup, in the tab's session storage, so a sign-in that leaves the
// page comes back to the same step. The full account and device pages stay
// one click away from the summary.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { useStepFocus } from "../components/step-nav.js";
import { navigate } from "../lib/router.js";
import { getRemoteAccess, updateRemoteAccess } from "../lib/remote-access-api.js";
import { useAccountRefresh, useRelayManagement } from "../lib/use-relay-management.js";
import { useTailscaleAdmin } from "../lib/use-tailscale-admin.js";
import { AccountStep } from "./remote-access/account-step.js";
import { ConnectionStep } from "./remote-access/connection-step.js";
import { DevicesStep } from "./remote-access/devices-step.js";
import { Summary } from "./remote-access/summary.js";
import { initialFlow, loadSetup, saveSetup, setupSteps, startFlow } from "./remote-access/model.js";

/** The relay's status and its one-at-a-time requests, read only when the relay is on. */
function RelayFeed({ children }) {
  const relay = useRelayManagement();
  // A sign-in added on the account page shows here within seconds, as on the account page.
  useAccountRefresh(() => void relay.run());
  return children(relay);
}

/** The Tailscale device's state and its requests, read only when the gateway can run one. */
function TailscaleFeed({ children }) {
  return children(useTailscaleAdmin());
}

/** Mounts only the readers for the features the gateway has, so the others send no request. */
function Feeds({ cloudRelay, tailscaleEmbed, children }) {
  const withTailscale = (relay) =>
    tailscaleEmbed
      ? html`<${TailscaleFeed}>${(tailscale) => children(relay, tailscale)}<//>`
      : children(relay, null);
  return cloudRelay ? html`<${RelayFeed}>${withTailscale}<//>` : withTailscale(null);
}

function Flow({ remote, setRemote, relay, tailscale, cloudRelay, tailscaleEmbed }) {
  const steps = setupSteps({ cloudRelay });
  const [flow, setFlow] = useState(() => initialFlow(remote, loadSetup(steps), steps));
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => saveSetup(flow), [flow]);
  const headingRef = useStepFocus(flow.mode === "summary" ? "summary" : flow.step);

  const update = (patch) => setFlow((current) => ({ ...current, ...patch }));
  const go = (step) => {
    setError("");
    update({ step });
  };
  const finish = async () => {
    if (flow.mode === "review") {
      setFlow({ mode: "summary" });
      return;
    }
    setFinishing(true);
    setError("");
    try {
      setRemote(await updateRemoteAccess({ setupCompleted: true }));
      setFlow({ mode: "summary" });
    } catch (cause) {
      setError(cause?.serverMessage || "Couldn't save that setup is finished. Try again.");
    } finally {
      setFinishing(false);
    }
  };
  const index = steps.indexOf(flow.step);
  const next = () => {
    if (flow.resume) {
      setError("");
      update({ step: flow.resume, resume: null });
    } else if (index === steps.length - 1) void finish();
    else go(steps[index + 1]);
  };
  const back = index > 0 ? () => go(steps[index - 1]) : null;

  if (flow.mode === "summary")
    return html`<${Summary}
      remote=${remote}
      relay=${relay}
      tailscale=${tailscale}
      headingRef=${headingRef}
      onReview=${() => setFlow(startFlow("review", steps, remote))}
      onManage=${(path) => navigate(path)}
    />`;

  const common = {
    flow,
    steps,
    headingRef,
    error,
    onStep: go,
    onNext: next,
    onBack: back,
    finishing,
    last: index === steps.length - 1 && !flow.resume,
  };
  switch (flow.step) {
    case "account":
      return html`<${AccountStep} ...${common} relay=${relay} />`;
    case "connection":
      return html`<${ConnectionStep}
        ...${common}
        remote=${remote}
        setRemote=${setRemote}
        relay=${relay}
        tailscale=${tailscale}
        tailscaleEmbed=${tailscaleEmbed}
        onFlow=${update}
        onGetAccount=${() => update({ step: "account", resume: "connection" })}
      />`;
    default:
      return html`<${DevicesStep} ...${common} relay=${relay} tailscale=${tailscale} />`;
  }
}

/** The gateway's remote-access settings, read once and replaced by every change's answer. */
function useRemoteAccess() {
  const [remote, setRemote] = useState(null);
  const [error, setError] = useState("");
  const load = async () => {
    setError("");
    try {
      setRemote(await getRemoteAccess());
    } catch (cause) {
      setError(cause?.serverMessage || "Couldn't load the remote access settings. Check the connection and try again.");
    }
  };
  useEffect(() => void load(), []);
  return { remote, setRemote, error, load };
}

export function RemoteAccessView({ cloudRelay = false, tailscaleEmbed = false }) {
  const { remote, setRemote, error, load } = useRemoteAccess();
  return html`<section class="remote-access-view" aria-label="Remote access">
    ${error &&
    html`<div class="remote-access-load-error" role="alert">
      <span>${error}</span>
      <button type="button" class="btn-secondary" onClick=${load}>Try again</button>
    </div>`}
    ${!remote && !error && html`<p class="remote-access-loading" role="status">Loading…</p>`}
    ${remote &&
    html`<${Feeds} cloudRelay=${cloudRelay} tailscaleEmbed=${tailscaleEmbed}>
      ${(relay, tailscale) => html`<${Flow}
        remote=${remote}
        setRemote=${setRemote}
        relay=${relay}
        tailscale=${tailscale}
        cloudRelay=${cloudRelay}
        tailscaleEmbed=${tailscaleEmbed}
      />`}
    <//>`}
  </section>`;
}
