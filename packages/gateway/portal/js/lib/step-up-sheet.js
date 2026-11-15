// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The note shown before the browser's passkey prompt when a change needs the passkey and its button
// didn't say so (a "step-up", see packages/gateway/src/http/step-up.ts). It only explains; the
// gateway still binds the step-up to the one request, and only the passkey proves anything.
// Shown only with the cloud relay on: no step-up is ever asked for without it.

let open = null;

/**
 * Asks the person to continue to the passkey prompt. Resolves true on Continue, false on Cancel, Escape or
 * `signal` aborting. Without a page to show it on, it goes straight on to the browser prompt.
 * While one is open, a second ask shares its answer.
 */
export function confirmStepUp({ doc = globalThis.document, signal } = {}) {
  if (!doc?.body) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  if (open) return open;
  const sheet = doc.createElement("div");
  sheet.className = "relay-step-up-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "relay-step-up-title");
  sheet.setAttribute("aria-describedby", "relay-step-up-text");
  const card = doc.createElement("div");
  card.className = "relay-step-up-card";
  const title = doc.createElement("p");
  title.className = "relay-step-up-title";
  title.id = "relay-step-up-title";
  title.textContent = "Confirm it's you";
  const text = doc.createElement("p");
  text.className = "relay-step-up-text";
  text.id = "relay-step-up-text";
  text.textContent = "You're connected from outside your home, so this needs your passkey.";
  const actions = doc.createElement("div");
  actions.className = "relay-step-up-actions";
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.className = "btn-secondary";
  cancel.textContent = "Cancel";
  const proceed = doc.createElement("button");
  proceed.type = "button";
  proceed.className = "btn-primary";
  proceed.textContent = "Continue";
  actions.append(cancel, proceed);
  card.append(title, text, actions);
  sheet.append(card);
  open = new Promise((resolve) => {
    const finish = (answer) => {
      sheet.remove();
      doc.removeEventListener("keydown", onKey);
      signal?.removeEventListener("abort", onAbort);
      open = null;
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
    };
    const onAbort = () => finish(false);
    cancel.addEventListener("click", () => finish(false));
    // A click is what lets the browser show its passkey prompt right after.
    proceed.addEventListener("click", () => finish(true));
    doc.addEventListener("keydown", onKey);
    signal?.addEventListener("abort", onAbort);
  });
  doc.body.append(sheet);
  proceed.focus?.();
  return open;
}
