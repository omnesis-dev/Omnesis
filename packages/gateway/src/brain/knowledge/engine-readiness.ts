// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { documentDerivationState } from "../../domain/DocumentDerivation.js";
import type { KnowledgeEngineDeps } from "./engine.js";

/** Wait ceilings preserve eventual progress; readiness releases immediately. */
export function knowledgeSourceReadiness(deps: KnowledgeEngineDeps, id: string, anchor: number) {
  const now = deps.clock(),
    settings = deps.getSettings();
  if (now < anchor + settings.pendingContentBarrierMs && deps.contentPending?.([id]).has(id))
    return {
      ready: false,
      reason: "pending_content" as const,
      until: anchor + settings.pendingContentBarrierMs,
    };
  const stages = deps.activeDerivationStages?.() ?? [];
  if (stages.length && now < anchor + settings.derivationBarrierMs) {
    const state = documentDerivationState(deps.db, id, stages);
    if (state.exists && !state.complete)
      return {
        ready: false,
        reason: "derivation" as const,
        until: anchor + settings.derivationBarrierMs,
      };
  }
  return { ready: true, reason: null, until: null };
}
