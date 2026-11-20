// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings → Connectivity: how this gateway's devices reach it when they are
// away from home. Every gateway has it: the home network, Tailscale already on
// the computer, the owner's own domain, the Omnesis account and the relay. With
// its own Tailscale device (an installation with its helper program) it adds
// that device, which `/status` advertises as `tailscaleEmbed`.
//
// The page is a summary of what is on, where everything can be set up or
// changed: each line opens its own page, and the answers for new devices and
// for which way is tried first change in place. A guided setup that asks one
// question per screen — the Omnesis account (with the relay), the remote
// connection, what new devices may do (once one can ask to join) and where the
// MCP server answers, at home and away — is there for
// whoever prefers it, started from the summary and run again at will. Every
// answer is applied at once through the relay's and the Tailscale device's own
// routes, with their step-ups and checks; this page keeps only where the owner
// is in the setup, in the tab's session storage, so a sign-in that leaves the
// page comes back to the same step. The full account and device pages stay
// one click away from the summary and from each step.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { useStepFocus } from "../components/step-nav.js";
import { navigate } from "../lib/router.js";
import { getRemoteAccess, updateRemoteAccess } from "../lib/remote-access-api.js";
import { useAccountRefresh, useRelayManagement } from "../lib/use-relay-management.js";
import { useTailscaleAdmin } from "../lib/use-tailscale-admin.js";
import { AccountStep } from "./remote-access/account-step.js";
import { ConnectionStep } from "./remote-access/connection-step.js";
import { DevicesStep, devicePolicies } from "./remote-access/devices-step.js";
import { McpStep } from "./remote-access/mcp.js";
import { Summary } from "./remote-access/summary.js";
import {
  initialFlow,
  loadSetup,
  saveSetup,
  setupSteps,
  startFlow,
} from "./remote-access/model.js";

/** The relay's status and its one-at-a-time requests. */
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

/** Mounts the Tailscale device's reader only where the gateway has one, so otherwise it sends no request. */
function Feeds({ tailscaleEmbed, children }) {
  const withTailscale = (relay) =>
    tailscaleEmbed
      ? html`<${TailscaleFeed}>${(tailscale) => children(relay, tailscale)}<//>`
      : children(relay, null);
  return html`<${RelayFeed}>${withTailscale}<//>`;
}

function Flow({ remote, setRemote, relay, tailscale, tailscaleEmbed }) {
  const policies = devicePolicies(relay, tailscale);
  const steps = setupSteps({ devices: policies.relayLinked || policies.tailscaleOn });
  const [stored, setFlow] = useState(() => initialFlow(loadSetup(steps)));
  // A step that stops applying (step 3 once nothing can ask to join) gives way to the last one.
  const flow =
    stored.mode === "summary" || steps.includes(stored.step) ? stored : { ...stored, step: steps.at(-1), resume: null };
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => saveSetup(flow), [flow]);
  const headingRef = useStepFocus(flow.mode === "summary" ? "summary" : flow.step);

  const update = (patch) => setFlow((current) => ({ ...current, ...patch }));
  // Moving by Back or the step bar leaves a detour to step 1, so Continue goes on from where the owner is.
  const go = (step) => {
    setError("");
    update({ step, resume: null });
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
      setRemote=${setRemote}
      relay=${relay}
      tailscale=${tailscale}
      headingRef=${headingRef}
      onStart=${(mode) => setFlow(startFlow(mode, steps, remote))}
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
    // Every answer is applied as it is given, so the walk can be left at any step.
    onCancel: () => setFlow({ mode: "summary" }),
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
    case "devices":
      return html`<${DevicesStep} ...${common} relay=${relay} tailscale=${tailscale} />`;
    default:
      return html`<${McpStep} ...${common} remote=${remote} setRemote=${setRemote} />`;
  }
}

/** The gateway's remote-access settings, read once and replaced by every change's answer. */
export function useRemoteAccess() {
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

export function RemoteAccessView({ tailscaleEmbed = false }) {
  const { remote, setRemote, error, load } = useRemoteAccess();
  return html`<section class="remote-access-view" aria-label="Connectivity">
    ${error &&
    html`<div class="remote-access-load-error" role="alert">
      <span>${error}</span>
      <button type="button" class="btn-secondary" onClick=${load}>Try again</button>
    </div>`}
    ${!remote && !error && html`<p class="remote-access-loading" role="status">Loading…</p>`}
    ${remote &&
    html`<${Feeds} tailscaleEmbed=${tailscaleEmbed}>
      ${(relay, tailscale) =>
        // Where the page opens depends on what is already on, so it waits for each feature's first answer.
        (relay && !relay.status && !relay.error) || (tailscale && !tailscale.state && !tailscale.error)
          ? html`<p class="remote-access-loading" role="status">Loading…</p>`
          : html`<${Flow}
              remote=${remote}
              setRemote=${setRemote}
              relay=${relay}
              tailscale=${tailscale}
              tailscaleEmbed=${tailscaleEmbed}
            />`}
    <//>`}
  </section>`;
}
