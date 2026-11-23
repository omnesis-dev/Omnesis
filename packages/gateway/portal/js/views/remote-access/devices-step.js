// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Connectivity setup's step for new devices, also on its summary: the one
// setting for every way a new device can ask to join — signing in with the
// Omnesis account, or from the owner's Tailscale network. The account and
// Tailscale pages leave it to Connectivity. One answer is one request
// (PUT /admin/remote-access/new-devices), which sets the account's policy and
// the Tailscale device's together, so letting devices join automatically asks
// for the owner's passkey once where the gateway requires it. Requests that
// wait are still decided on Settings → Devices.

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import { updateNewDevices } from "../../lib/remote-access-api.js";
import { relayAccountSetup, relayPhase } from "../relay.js";
import { POLICY_CHOICES, currentPolicy, joinWays, policyChoices, policyDifference } from "./model.js";
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
    // Until both feeds have answered once, which ways apply, and so the answer, is not known.
    loading: Boolean((relay && !relay.status && !relay.error) || (tailscale && !tailscale.state && !tailscale.error)),
    held: Boolean(relay?.status?.incidentHold),
    stepUpRequired: relay?.status?.stepUpRequired === true,
    ...currentPolicy({ relayPolicy, tailscalePolicy }),
  };
}

/**
 * The one answer for new devices, changed in place: short choices on one
 * line, the one picked explained beneath. Exactly one is always selected:
 * while the two ways' own policies differ, that is shown as its own answer,
 * saying what each does, until the owner picks one for both (picking it again
 * changes nothing). Step 3 and the
 * summary both show it. `onSaving` hears while a choice is being applied.
 */
export function DevicesChoice({ relay, tailscale, disabled: held = false, name = "remote-access-policy", onSaving }) {
  const policies = devicePolicies(relay, tailscale);
  const [saving, setSavingState] = useState("");
  const [error, setError] = useState("");
  const setSaving = (choice) => {
    setSavingState(choice);
    onSaving?.(Boolean(choice));
  };
  const choose = async (choice) => {
    if (choice === policies.value) return;
    setSaving(choice);
    setError("");
    try {
      // The choice already said the passkey comes next, so no note before the prompt.
      const announced = policies.stepUpRequired && choice === "automatic";
      const answer = await updateNewDevices(choice, { stepUpAnnounced: announced });
      if (answer.relay) relay?.adopt(answer.relay);
      if (answer.tailscale) tailscale?.adopt(answer.tailscale);
    } catch (cause) {
      setError((cause?.stepUp === true && cause.message) || cause?.serverMessage || "Couldn't change that. Try again.");
    } finally {
      setSaving("");
    }
  };
  if (policies.loading) return html`<p class="remote-access-muted" role="status">Loading…</p>`;
  const value = saving || policies.value;
  const disabled = Boolean(saving) || held || policies.held;
  const choices = [...policyChoices(policies), ...(value === "split" ? ["split"] : [])];
  const detail = value === "split" ? policyDifference(policies) : POLICY_CHOICES[value]?.text;
  return html`<fieldset class="remote-access-choices is-compact" aria-label="When a new device asks to join">
    ${policies.held &&
    html`<p class="remote-access-problem">
      Every new device waits for your approval until the certificate problem on the Omnesis account page is dealt with.
    </p>`}
    ${choices.map(
      (choice) => html`<label
        key=${choice}
        class=${`remote-access-choice${value === choice ? " is-on" : ""}`}
        title=${choice === "split" ? detail : POLICY_CHOICES[choice].text}
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
          <strong>${choice === "split" ? "Different for each way" : POLICY_CHOICES[choice].short}</strong>
          ${choice === "automatic" &&
          policies.stepUpRequired &&
          value !== "automatic" &&
          html`<small class="remote-access-step-up">Turns on with your passkey.</small>`}
        </span>
      </label>`,
    )}
    ${detail && html`<p class="remote-access-choice-detail">${detail}</p>`}
    ${error && html`<p class="remote-access-problem" role="alert">${error}</p>`}
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
