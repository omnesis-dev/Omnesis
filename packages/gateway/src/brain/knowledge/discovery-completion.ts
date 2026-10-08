// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { KnowledgeStorageError } from "./types.js";
import type { DiscoveryPhase } from "./discovery.js";
import type Database from "better-sqlite3";

/** Terminal source work must satisfy the phases used by discovery admission. */
export function assertKnowledgeDiscoveryComplete(
  db: Database.Database,
  subjectId: string,
  inputRevision: string,
  supplied: readonly DiscoveryPhase[],
  now: number,
): void {
  const covered = new Set(supplied);
  for (const row of db
    .prepare<[string, string, string, number], { phase: DiscoveryPhase }>(
      `SELECT phase FROM knowledge_discovery_coverage
    WHERE subject_id=? AND input_revision=? AND policy_version=?
      AND status IN ('considered','gated') AND (reconsider_at IS NULL OR reconsider_at>?)`,
    )
    .all(subjectId, inputRevision, KNOWLEDGE_DISCOVERY_POLICY, now))
    covered.add(row.phase);
  const missing = (["interpretation", "organization"] as const).filter(
    (phase) => !covered.has(phase),
  );
  if (missing.length)
    throw new KnowledgeStorageError(
      "claim_invalid",
      `Source discovery is incomplete: ${missing.join(", ")} still requires review. Complete the missing phases and include them in knowledge_discovery_complete; do not report a phase you have not reviewed.`,
    );
}
