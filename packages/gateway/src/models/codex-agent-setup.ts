// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { CodexBackendStatus } from "@omnesis/core";
import type { ConfigStore } from "../config-store.js";

export class CodexAgentSetupUnavailableError extends Error {}
export class CodexAgentSetupConflictError extends Error {}

export interface CodexAgentSetupResult {
  assignment: string;
  allowRemoteInference: true;
}

/**
 * Verify a model against the signed-in account, then enable remote inference
 * and assign Agent only if it is still unassigned. The condition and mutation
 * share ConfigStore's write mutex so a concurrent administrator always wins.
 */
export async function setupCodexAgent(
  configStore: ConfigStore,
  refreshStatus: () => Promise<CodexBackendStatus>,
  model: string,
): Promise<CodexAgentSetupResult> {
  const status = await refreshStatus();
  if (status.status !== "ok" || !status.loggedIn) {
    throw new CodexAgentSetupUnavailableError(status.reason ?? "Codex is not logged in and ready.");
  }
  if (!status.models.includes(model)) {
    throw new CodexAgentSetupUnavailableError(`Codex model is not available: ${model}`);
  }

  let existingAssignment: string | null | undefined;
  const assignment = `codex/${model}`;
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
    throw new Error(`Codex agent config rejected: ${res.errors.map((e) => e.message).join("; ")}`);
  }
  if (existingAssignment) {
    throw new CodexAgentSetupConflictError(`Agent is already assigned to ${existingAssignment}.`);
  }
  return { assignment, allowRemoteInference: true };
}
