// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cognitionBudgetVerdict } from "../cognition/budget.js";
import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import {
  DISCOVERY_WORTH_THRESHOLD,
  discoveryDecisionState,
  judgeKnowledge,
  knowledgeRubricVersion,
} from "./decision.js";
import { knowledgeHash } from "./storage-validation.js";
import type { KnowledgeEngineDeps } from "./engine.js";

export interface OrganizationWorthSource {
  title: string;
  content: string;
  sourceRevision: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

/**
 * A source's discovery worth verdict under the current rubric, or undefined
 * when none was recorded. Verdicts are matched by the exact decision input,
 * so an edited source or a changed rubric has no current verdict.
 */
export function currentDiscoveryVerdict(
  db: KnowledgeEngineDeps["db"],
  sourceId: string,
  source: OrganizationWorthSource,
): number | undefined {
  const row = db
    .prepare<[string, string, string], { score: number }>(
      `SELECT score FROM knowledge_decisions WHERE node_id=? AND purpose='discovery'
      AND rubric_version=? AND input_fingerprint=? AND score IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    )
    .get(
      `source:${sourceId}`,
      knowledgeRubricVersion("discovery"),
      knowledgeHash(discoveryDecisionState(source)),
    );
  return row?.score;
}

/**
 * The cohort members whose current discovery worth is low. Organization
 * regroups evidence that was interpreted earlier, often under an older
 * rubric; a member admitted then may now read as low-information (another
 * routine status notification, say) and must not feed a page again. A member
 * without a verdict under the current rubric is judged once, through the same
 * gate and ledger as new evidence; a recorded verdict is reused. Without a
 * decision model, or once the budget is spent, members are kept: the gate
 * fails open, as discovery admission does.
 */
export async function lowWorthOrganizationSources(
  deps: KnowledgeEngineDeps,
  sourceVersions: Record<string, string>,
  source: (id: string) => OrganizationWorthSource | null,
): Promise<Record<string, string>> {
  const low: Record<string, string> = {};
  for (const [id, revision] of Object.entries(sourceVersions)) {
    const current = source(id);
    if (!current || current.sourceRevision !== revision) continue;
    let score: number | null | undefined = currentDiscoveryVerdict(deps.db, id, current);
    if (score === undefined) {
      if (!deps.decisions.getDecision?.()) continue;
      if (cognitionBudgetVerdict(deps.db, deps.getSettings().budget, deps.clock()).exhausted) break;
      score = await judgeKnowledge(deps.decisions, "discovery", discoveryDecisionState(current), {
        nodeId: `source:${id}`,
        threshold: DISCOVERY_WORTH_THRESHOLD,
        payloadCapture:
          captureDecisionPayloadSubjects(
            deps.db,
            { sourceIds: [id], nodeIds: [] },
            decisionPayloadErasureGeneration(deps.db),
          ) ?? undefined,
      });
    }
    if (score !== null && score < DISCOVERY_WORTH_THRESHOLD) low[id] = revision;
  }
  return low;
}
