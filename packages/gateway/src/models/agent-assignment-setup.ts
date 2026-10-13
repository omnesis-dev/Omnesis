// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ConfigStore } from "../config-store.js";

export class AgentSetupUnavailableError extends Error {}
export class AgentSetupConflictError extends Error {}

export interface AgentSetupResult {
  assignment: string;
  allowRemoteInference: true;
}

/** The status a built-in subscription backend (Codex, Claude Code) reports. */
export interface SubscriptionBackendReadiness {
  status: "ok" | "unreachable" | "probing";
  loggedIn: boolean;
  models: string[];
  reason?: string;
}

/**
 * Verify a model against the signed-in account, then enable remote inference
 * and assign Agent only if it is still unassigned. The condition and mutation
 * share ConfigStore's write mutex so a concurrent administrator always wins.
 */
export async function setupAgentAssignment(opts: {
  configStore: ConfigStore;
  /** Assignment prefix, e.g. `codex` for `codex/<model>`. */
  backend: "codex" | "claude-code";
  /** Name used in operator-facing errors. */
  label: string;
  refreshStatus: () => Promise<SubscriptionBackendReadiness>;
  model: string;
}): Promise<AgentSetupResult> {
  const { configStore, label, model } = opts;
  const status = await opts.refreshStatus();
  if (status.status !== "ok" || !status.loggedIn) {
    throw new AgentSetupUnavailableError(status.reason ?? `${label} is not logged in and ready.`);
  }
  if (!status.models.includes(model)) {
    throw new AgentSetupUnavailableError(`${label} model is not available: ${model}`);
  }

  let existingAssignment: string | null | undefined;
  const assignment = `${opts.backend}/${model}`;
  const res = await configStore.update((current) => {
    existingAssignment = current.inference?.assignments?.agent;
    if (existingAssignment) return current;
    return {
      ...current,
      inference: {
        ...current.inference,
        allowRemoteInference: true,
        assignments: { ...current.inference?.assignments, agent: assignment },
      },
    };
  });
  if (!res.ok) {
    throw new Error(
      `${label} agent config rejected: ${res.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (existingAssignment) {
    throw new AgentSetupConflictError(`Agent is already assigned to ${existingAssignment}.`);
  }
  return { assignment, allowRemoteInference: true };
}
