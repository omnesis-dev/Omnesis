// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { patchAdminConfig } from "../api.js";
import { CloudInferenceConsentModal } from "../components/cloud-inference-consent.js";

/** Only the last failed turn can offer a retry; never replay an older message. */
export function cloudInferenceRecovery(state) {
  const last = state.turns.at(-1);
  if (last?.failure?.code === "remote_inference_disabled") {
    const user = state.turns.at(-2);
    return {
      key: last.id,
      message: user?.role === "user"
        ? user.parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n")
        : null,
      deepResearch: user?.deepResearch === true,
    };
  }
  if (state.agentConfig?.disabledCode === "remote_inference_disabled" && !state.turns.length) {
    return { key: "configuration", message: null };
  }
  return null;
}

/** Save consent, then observe backend readiness without sending a message. */
export async function enableCloudInferenceForAgent({ patch = patchAdminConfig, getConfig, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), isCurrent = () => true }) {
  const result = await patch({ inference: { allowRemoteInference: true } });
  if (!result.ok) {
    throw new Error(result.body?.errors?.[0]?.message ?? result.body?.error ?? "Could not enable cloud inference.");
  }
  let lastConfig;
  for (let attempt = 0; attempt < 30 && isCurrent(); attempt += 1) {
    const config = await getConfig();
    if (!isCurrent()) return null;
    if (config.enabled) return config;
    lastConfig = config;
    await delay(500);
  }
  if (!isCurrent()) return null;
  if (lastConfig?.disabledReason && lastConfig.disabledCode !== "remote_inference_disabled") {
    throw new Error(`Cloud inference is enabled. ${lastConfig.disabledReason}`);
  }
  throw new Error("Cloud inference was enabled, but the model is not ready yet. Try enabling again to check readiness, or open Settings → Models.");
}

export function AgentCloudInferenceRecovery({ recovery, model, getConfig, onEnabled, onRetry, busy: agentBusy = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const current = useRef(true);
  const running = useRef(false);
  useEffect(() => () => { current.current = false; }, []);

  async function enable() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const config = await enableCloudInferenceForAgent({ getConfig, isCurrent: () => current.current });
      if (!config || !current.current) return;
      onEnabled(config);
      setReady(true);
      setOpen(false);
    } catch (err) {
      if (current.current) setError(err.message ?? String(err));
    } finally {
      running.current = false;
      if (current.current) setBusy(false);
    }
  }

  return html`<div class="agent-cloud-inference" role="status">
    <div>
      <strong>${ready ? "Cloud inference enabled" : "Cloud inference is disabled"}</strong>
      <p>${ready
        ? "Your selected model is ready."
        : `Your selected model${model?.modelName ? `, ${model.modelName},` : ""} runs remotely. Enable cloud inference to use it.`}</p>
      ${ready && recovery.message
        ? html`<button class="btn-primary" disabled=${agentBusy} onClick=${() => onRetry(recovery.message, { deepResearch: recovery.deepResearch })}>Retry message</button>`
        : !ready ? html`<button class="btn-primary" disabled=${busy || agentBusy} onClick=${() => setOpen(true)}>Enable cloud inference…</button>` : null}
      <a class="btn-secondary" href="/portal/settings/models/agent">${ready ? "Model settings" : "Choose a local model"}</a>
    </div>
    <${CloudInferenceConsentModal} open=${open} modelName=${model?.modelName} providerLabel=${model?.providerId === "codex" ? "OpenAI" : model?.providerLabel} busy=${busy} error=${error} onConfirm=${enable} onCancel=${() => setOpen(false)} />
  </div>`;
}
