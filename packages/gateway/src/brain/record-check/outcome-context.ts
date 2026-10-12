// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import { KnowledgeStorageError } from "../knowledge/types.js";
import { captureOutcomeWriteFence } from "../storage/outcome-write-fence.js";
import type { OpenLoopRow } from "../storage/types.js";
import type Database from "better-sqlite3";

export type OutcomeProposal = Pick<
  OpenLoopRow,
  "title" | "description" | "state" | "deadline" | "actors"
>;

/** Original evidence is distinct from the existing outcome, which is only a prior. */
export interface OutcomeRecordContext {
  now: string;
  previous: OutcomeProposal | null;
  proposed: OutcomeProposal;
  proposed_actor_roles: Array<{ id: string; is_self: boolean | null }>;
  sources: Array<{
    id: string;
    text: string;
    truncated: boolean;
    title?: string | null;
    title_truncated?: boolean;
    source_created_at?: string | null;
    source_updated_at?: string | null;
    selection?: "proposed_evidence" | "prior_evidence" | "related_evidence";
  }>;
  sources_omitted: number;
}

const MAX_SOURCES = 8;
const SOURCE_CHARACTERS = 4_000;

function sourceExcerpt(text: string): { text: string; truncated: boolean } {
  if (text.length <= SOURCE_CHARACTERS) return { text, truncated: false };
  const boundedSlice = (start: number, end: number) => {
    if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    )
      end--;
    return text.slice(start, end);
  };
  return {
    text:
      boundedSlice(0, 3_000) +
      "\n[Middle omitted: absence here is not absence from the source]\n" +
      boundedSlice(text.length - 1_000, text.length),
    truncated: true,
  };
}

/** Capture ancestry and read evidence in one snapshot before asynchronous judgment. */
export function prepareOutcomeRecordContext(
  db: Database.Database,
  input: {
    documentIds: readonly string[];
    priorityDocumentIds?: readonly string[];
    priorDocumentIds?: readonly string[];
    previous: OutcomeProposal | null;
    ownerId?: string;
    outcomeId?: string;
    supportingNodeIds?: readonly string[];
    proposed: OutcomeProposal;
    now: number;
  },
) {
  if (input.proposed.actors.length > 100)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Outcome actor context exceeds the bounded assessment limit",
    );
  return db.transaction(() => {
    const ids = [...new Set(input.documentIds)];
    const nodeIds = [
      ...new Set([...(input.ownerId ? [input.ownerId] : []), ...(input.supportingNodeIds ?? [])]),
    ];
    if (!ids.length && !nodeIds.length) return null;
    const payloadCapture = captureDecisionPayloadSubjects(
      db,
      { sourceIds: ids, nodeIds },
      decisionPayloadErasureGeneration(db),
    );
    // A missing privacy closure is not permission to send raw context to a judge.
    if (!payloadCapture) return null;
    const capturedIds = [
      ...new Set([
        ...ids,
        ...payloadCapture.subjects
          .filter((subject) => subject.kind === "source")
          .map((subject) => subject.id),
      ]),
    ];
    const allowed = new Set(capturedIds);
    const priority = [...new Set(input.priorityDocumentIds ?? ids)].filter((id) => allowed.has(id));
    const prior = [...new Set(input.priorDocumentIds ?? [])].filter((id) => allowed.has(id));
    // Preserve room for both sides of a revision instead of letting a broad
    // owner's residual linked documents crowd out its newly cited evidence.
    const preferred = Array.from({ length: Math.max(priority.length, prior.length) }, (_, i) =>
      [priority[i], prior[i]].filter((id): id is string => id !== undefined),
    ).flat();
    const evidenceIds = [...new Set([...preferred, ...capturedIds])];
    if (!evidenceIds.length) return null;
    const hasPeople = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='people'")
      .get();
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(documents)")
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const metadataColumns = ["title", "source_created_at", "source_updated_at"].map((name) =>
      columns.has(name) ? name : `NULL AS ${name}`,
    );
    const sources = evidenceIds.slice(0, MAX_SOURCES).map((id) => {
      const row = db
        .prepare<
          [string],
          {
            content: string | null;
            title?: string | null;
            source_created_at?: string | null;
            source_updated_at?: string | null;
          }
        >(`SELECT content,${metadataColumns.join(",")} FROM documents WHERE id=?`)
        .get(id);
      return {
        id,
        ...sourceExcerpt(row?.content ?? ""),
        title: row?.title?.slice(0, 500) ?? null,
        title_truncated: (row?.title?.length ?? 0) > 500,
        source_created_at: row?.source_created_at ?? null,
        source_updated_at: row?.source_updated_at ?? null,
        selection: priority.includes(id)
          ? ("proposed_evidence" as const)
          : prior.includes(id)
            ? ("prior_evidence" as const)
            : ("related_evidence" as const),
      };
    });
    const context: OutcomeRecordContext = {
      now: new Date(input.now).toISOString(),
      previous: input.previous,
      proposed: input.proposed,
      proposed_actor_roles: input.proposed.actors.map((id) => {
        const person = hasPeople
          ? db
              .prepare<[string], { is_self: number }>("SELECT is_self FROM people WHERE id=?")
              .get(id)
          : undefined;
        return { id, is_self: person ? !!person.is_self : null };
      }),
      sources,
      sources_omitted: Math.max(0, evidenceIds.length - MAX_SOURCES),
    };
    const outcomeFence = input.outcomeId
      ? captureOutcomeWriteFence(db, input.outcomeId, evidenceIds)
      : undefined;
    if (outcomeFence) outcomeFence.actorRoles = context.proposed_actor_roles;
    return {
      context,
      payloadCapture,
      documentId: evidenceIds[0]!,
      outcomeFence,
    };
  })();
}

export function outcomeProposal(loop: OutcomeProposal): OutcomeProposal {
  return {
    title: loop.title,
    description: loop.description,
    state: loop.state,
    deadline: loop.deadline,
    actors: loop.actors,
  };
}
