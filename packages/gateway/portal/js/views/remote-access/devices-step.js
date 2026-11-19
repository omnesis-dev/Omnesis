// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Connectivity setup's step for new devices, also on its summary: the one
// setting for every way a new device can ask to join — signing in with the
// Omnesis account, or from the owner's Tailscale network. The account and
// Tailscale pages leave it to Connectivity. The answer is
// applied at once to the account's policy and to the Tailscale device's, each
// through its own route; letting
// devices join automatically asks for the owner's passkey where the gateway
// requires it, as on the account page. Requests that wait are still decided
// on Settings → Devices.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { updateTailscaleSettings } from "../../lib/tailscale-api.js";
import { relayAccountSetup, relayPhase } from "../relay.js";
import {
  POLICY_CHOICES,
  currentPolicy,
  joinWays,
  policyChanges,
  policyChoices,
  policyDifference,
} from "./model.js";
import { BackButton, StepFrame, nextLabel } from "./step-frame.js";


/** Where the relay's and the Tailscale device's own policies stand: what this step offers and shows. */
export function devicePolicies(relay, tailscale) {
  const enrollment = relay?.status ? relayAccountSetup(relay.status, relayPhase(relay.status)).enrollment : undefined;
  const relayLinked = Boolean(enrollment);
  const tailscaleOn = tailscale?.state?.enabled === true;
  const relayPolicy = enrollment?.policy;
  const tailscalePolicy = tailscaleOn ? tailscale.state.joinPolicy : undefined;
  return {
    relayLinked,
    tailscaleOn,
    relayPolicy,
    tailscalePolicy,
    held: Boolean(relay?.status?.incidentHold),
    stepUpRequired: relay?.status?.stepUpRequired === true,
    ...currentPolicy({ relayPolicy, tailscalePolicy }),
  };
}

/**
 * The one answer for new devices, changed in place: each choice is applied at
 * once to the account's policy and the Tailscale device's, each through its
 * own hook, which shows its own failure; a failure stops the rest. Step 3 and
 * the summary both show it: short choices on one line, the one picked
 * explained beneath. `onSaving` hears while a choice is being applied.
 */
export function DevicesChoice({ relay, tailscale, disabled: held = false, name = "remote-access-policy", onSaving }) {
  const policies = devicePolicies(relay, tailscale);
  const [saving, setSavingState] = useState("");
  const setSaving = (choice) => {
    setSavingState(choice);
    onSaving?.(Boolean(choice));
  };
  const choose = async (choice) => {
    if (choice === policies.value) return;
    setSaving(choice);
    try {
      for (const change of policyChanges(choice, policies)) {
        // Only loosening asks for the passkey, and the choice already said so.
        const announced = policies.stepUpRequired && change.policy === "automatic";
        const done =
          change.target === "relay"
            ? await relay.run("enrollment", { policy: change.policy }, "PUT", ...(announced ? [{ stepUpAnnounced: true }] : []))
            : await tailscale.run("join-policy", (signal) => updateTailscaleSettings({ joinPolicy: change.policy }, signal));
        if (done === undefined) break;
      }
    } finally {
      setSaving("");
    }
  };
  const value = saving || policies.value;
  const disabled = Boolean(saving) || held || policies.held;
  return html`<fieldset class="remote-access-choices is-compact" aria-label="When a new device asks to join">
    ${policies.held &&
    html`<p class="remote-access-problem">
      Every new device waits for your approval until the certificate problem on the Omnesis account page is dealt with.
    </p>`}
    ${policies.differ && !saving && html`<p class="remote-access-muted">${policyDifference(policies)}</p>`}
    ${policyChoices(policies).map(
      (choice) => html`<label
        key=${choice}
        class=${`remote-access-choice${value === choice ? " is-on" : ""}`}
        title=${POLICY_CHOICES[choice].text}
      >
        <input
          type="radio"
          name=${name}
          value=${choice}
          checked=${value === choice}
          disabled=${disabled}
          onChange=${() => choose(choice)}
        />
        <span class="remote-access-option-text">
          <strong>${POLICY_CHOICES[choice].short}</strong>
          ${choice === "automatic" &&
          policies.relayLinked &&
          policies.stepUpRequired &&
          policies.relayPolicy !== "automatic" &&
          html`<small class="remote-access-step-up">Turns on with your passkey.</small>`}
        </span>
      </label>`,
    )}
    ${POLICY_CHOICES[value] && html`<p class="remote-access-choice-detail">${POLICY_CHOICES[value].text}</p>`}
    ${relay?.error && html`<p class="remote-access-problem" role="alert">${relay.error}</p>`}
    ${tailscale?.error && html`<p class="remote-access-problem" role="alert">${tailscale.error.message}</p>`}
  </fieldset>`;
}

export function DevicesStep({ flow, steps, headingRef, error, onStep, onNext,
  onCancel, onBack, last, finishing, relay, tailscale }) {
  const policies = devicePolicies(relay, tailscale);
  const [saving, setSaving] = useState(false);
  const applies = policies.relayLinked || policies.tailscaleOn;

  return html`<${StepFrame}
    flow=${flow}
    steps=${steps}
    heading="When a new device asks to join, what should happen?"
    blurb=${joinWays({ relayLinked: policies.relayLinked, tailscaleOn: policies.tailscaleOn })}
    headingRef=${headingRef}
    error=${error}
    onStep=${onStep}
    onCancel=${onCancel}
    actions=${html`<${BackButton} onBack=${onBack} disabled=${finishing} />
      <button type="button" class="btn-primary" disabled=${finishing || saving} onClick=${onNext}>
        ${finishing ? "Finishing…" : nextLabel(last)}
      </button>`}
  >
    ${applies && html`<${DevicesChoice} relay=${relay} tailscale=${tailscale} disabled=${finishing} onSaving=${setSaving} />`}
  <//>`;
}
