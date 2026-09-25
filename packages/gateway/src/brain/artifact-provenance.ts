// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * "Why am I seeing this?" — the run behind a durable artifact, named.
 *
 * Every loop and brief records the run that created it, but a run id answers
 * nothing on its own: it is opaque, and the queue row it names is pruned once
 * past the retention window. What an operator actually wants is which
 * procedure decided this, under which version of that procedure's contract,
 * on which model — and the attribution ledger keeps exactly that after the
 * run row is gone.
 *
 * Absent provenance is reported as absent rather than guessed. An artifact
 * created before attribution existed, or by a build that did not record it,
 * genuinely cannot be explained, and inventing a plausible workflow name
 * would make the surface less trustworthy than saying so.
 */

import { cognitiveWorkflowLabel, isCognitiveWorkflowId } from "./cognition/workflows.js";
import { getRunAttribution } from "./storage/run-attribution.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface ArtifactProvenanceDto {
  /** The run that created the artifact. Always present — artifacts store it. */
  runId: string;
  /** The procedure that ran, when it can be resolved. */
  workflow: { id: string; label: string; version: number } | null;
  /** Resolved backend model id; null when the ledger has no row or reported none. */
  modelId: string | null;
  /** When the run settled (ISO), or null when unattributed. */
  settledAt: string | null;
}

/**
 * Provenance for one artifact, from the run id it already carries.
 *
 * `workflow` is null when the ledger has no row for the run — the artifact
 * predates attribution — and also when the recorded id is not one this build
 * knows, which is how a downgrade reads a newer workflow.
 */
export function artifactProvenance(db: Db, createdByRun: string): ArtifactProvenanceDto {
  const attribution = getRunAttribution(db, createdByRun);
  if (!attribution) {
    return { runId: createdByRun, workflow: null, modelId: null, settledAt: null };
  }
  const id = attribution.workflowId;
  return {
    runId: createdByRun,
    workflow: isCognitiveWorkflowId(id)
      ? { id, label: cognitiveWorkflowLabel(id), version: attribution.workflowVersion }
      : null,
    modelId: attribution.modelId.length > 0 ? attribution.modelId : null,
    settledAt: new Date(attribution.settledAt).toISOString(),
  };
}
