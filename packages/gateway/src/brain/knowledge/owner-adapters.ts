// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import { normalizeLoopTitle } from "../storage/retired-loops.js";
import { getOpenLoop, updateOpenLoop } from "../storage/open-loops.js";
import { getBrief, updateBrief } from "../storage/briefs.js";
import {
  getDocAnnotation,
  listDocAnnotationEvidence,
  updateDocAnnotation,
} from "../storage/annotations.js";
import {
  getPersonAnnotation,
  listPersonAnnotationEvidence,
  revisePersonAnnotation,
} from "../storage/person-annotations.js";
import { parseClaimMarkup } from "./claims.js";
import { getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { isKnowledgeOwnerReadable } from "./storage-fence.js";
import { knowledgeHash } from "./storage-validation.js";
import {
  KnowledgeStorageError,
  type KnowledgeNodeKind,
  type SaveKnowledgeNodeInput,
} from "./types.js";
import type Database from "better-sqlite3";

export type KnowledgeOwnerKind = Exclude<KnowledgeNodeKind, "wiki" | "root">;
export interface KnowledgeOwnerSnapshot {
  id: string;
  kind: KnowledgeOwnerKind;
  title: string;
  markdown: string;
  canonicalFields: Record<string, unknown>;
  evidenceDocumentIds: string[];
  versionFingerprint: string;
}
function snapshot(
  kind: KnowledgeOwnerKind,
  id: string,
  title: string,
  markdown: string,
  fields: Record<string, unknown>,
  documents: string[],
  raw: unknown,
): KnowledgeOwnerSnapshot {
  return {
    kind,
    id,
    title,
    markdown,
    canonicalFields: fields,
    evidenceDocumentIds: [...new Set(documents)],
    versionFingerprint: knowledgeHash([raw, documents]),
  };
}
export function readKnowledgeOwner(
  db: Database.Database,
  kind: KnowledgeOwnerKind,
  id: string,
): KnowledgeOwnerSnapshot {
  switch (kind) {
    case "loop": {
      const row = getOpenLoop(db, id);
      if (!row) {
        if (
          !db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_loops'")
            .get()
        )
          break;
        if (!isKnowledgeOwnerReadable(db, id)) break;
        const retired = db
          .prepare<
            [string],
            {
              title: string;
              description: string;
              outcome: string;
              importance: number;
              actors_json: string;
              involved_json: string;
              deadline_json: string | null;
              retired_at: number;
            }
          >("SELECT * FROM retired_loops WHERE id=?")
          .get(id);
        if (!retired) break;
        const evidence = db
          .prepare<[string], { document_id: string }>(
            "SELECT document_id FROM knowledge_retired_loop_sources WHERE loop_id=?",
          )
          .all(id)
          .map((entry) => entry.document_id);
        return snapshot(
          kind,
          id,
          retired.title,
          retired.description.trim() ? retired.description : retired.title,
          {
            state: "retired",
            outcome: retired.outcome,
            importance: retired.importance,
            actors: JSON.parse(retired.actors_json),
            involved: JSON.parse(retired.involved_json),
            deadline: retired.deadline_json ? JSON.parse(retired.deadline_json) : null,
            retiredAt: retired.retired_at,
          },
          evidence,
          retired,
        );
      }
      return snapshot(
        kind,
        id,
        row.title,
        // Title-only loops are valid canonical outcomes. Keep their existing
        // title as unverified context instead of constructing an empty claim.
        row.description.trim() ? row.description : row.title,
        {
          state: row.state,
          actors: row.actors,
          involved: row.involved,
          deadline: row.deadline,
          blockedBy: row.blockedBy,
          importance: row.importance,
          confidence: row.confidence,
        },
        row.docs,
        row,
      );
    }
    case "brief": {
      const row = getBrief(db, id);
      if (!row) break;
      return snapshot(
        kind,
        id,
        row.title,
        `## Description\n${row.description}\n\n## Body\n${row.body ?? ""}`,
        {
          state: row.state,
          kind: row.kind,
          urgency: row.urgency,
          relevantUntil: row.relevantUntil,
          nextShow: row.nextShow,
          eventAt: row.eventAt,
          relatedLoopIds: row.relatedLoopIds,
          userFeedback: row.userFeedback,
        },
        row.citations,
        row,
      );
    }
    case "doc_annotation": {
      const row = getDocAnnotation(db, id);
      if (!row) break;
      const evidence = listDocAnnotationEvidence(db, id);
      return snapshot(
        kind,
        id,
        row.claimType,
        row.claimText,
        {
          subjectId: row.docId,
          claimType: row.claimType,
          invalidatedAt: row.invalidatedAt,
          supersededBy: row.supersededBy,
          confidence: row.confidence,
        },
        [row.evidenceDocId, ...evidence.map((e) => e.evidenceDocId)],
        row,
      );
    }
    case "person_annotation": {
      const row = getPersonAnnotation(db, id);
      if (!row) break;
      const evidence = listPersonAnnotationEvidence(db, id);
      return snapshot(
        kind,
        id,
        row.claimType,
        row.claimText,
        {
          subjectId: row.personId,
          claimType: row.claimType,
          invalidatedAt: row.invalidatedAt,
          supersededBy: row.supersededBy,
          confidence: row.confidence,
        },
        [row.evidenceDocId, ...evidence.map((e) => e.evidenceDocId)],
        row,
      );
    }
    default:
      return assertNever(kind);
  }
  throw new KnowledgeStorageError("reference_invalid", "Canonical synthesis owner does not exist");
}

/** Canonical operational fields are read inside the writer transaction, never model supplied. */
export function saveOwnedKnowledgeNode(
  db: Database.Database,
  input: { node: SaveKnowledgeNodeInput; ownerVersion: string },
  now: number,
): ReturnType<typeof saveKnowledgeNode> {
  return db.transaction(() => {
    const proposed = input.node;
    if (
      proposed.kind === "wiki" ||
      proposed.kind === "root" ||
      !proposed.ownerId ||
      proposed.id !== proposed.ownerId
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Owned synthesis must preserve its canonical owner identity",
      );
    const owner = readKnowledgeOwner(db, proposed.kind, proposed.ownerId);
    if (owner.versionFingerprint !== input.ownerVersion)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical owner changed during synthesis",
      );
    if (
      (proposed.kind === "doc_annotation" || proposed.kind === "person_annotation") &&
      proposed.title !== owner.title
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Annotation classification changes require the canonical annotation tool",
      );
    if (
      (proposed.kind === "doc_annotation" || proposed.kind === "person_annotation") &&
      owner.canonicalFields.invalidatedAt !== null
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Canonical owner can no longer be revised",
      );
    const plain = parseClaimMarkup(proposed.markdown).text;
    let briefParts: RegExpExecArray | null = null;
    if (proposed.kind === "brief") {
      briefParts = /^## Description\n([\s\S]*?)\n\n## Body\n([\s\S]*)$/.exec(plain);
      if (!briefParts)
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Brief prose must preserve Description and Body sections",
        );
    }
    const result = saveKnowledgeNode(
      db,
      { ...proposed, canonicalFields: owner.canonicalFields },
      now,
    );
    db.prepare("INSERT OR IGNORE INTO knowledge_owner_write_guard(kind,owner_id) VALUES(?,?)").run(
      proposed.kind,
      owner.id,
    );
    try {
      let updated: unknown;
      // Proof maintenance is not new canonical activity, a decay reset, or a verification reset.
      if (proposed.title === owner.title && plain === owner.markdown) updated = true;
      else
        switch (proposed.kind) {
          case "loop":
            if (owner.canonicalFields.state === "retired") {
              updated =
                db
                  .prepare("UPDATE retired_loops SET title=?,title_norm=?,description=? WHERE id=?")
                  .run(proposed.title, normalizeLoopTitle(proposed.title), plain, owner.id)
                  .changes > 0;
              break;
            }
            updated = updateOpenLoop(
              db,
              owner.id,
              { title: proposed.title, description: plain },
              now,
            );
            break;
          case "brief":
            updated = updateBrief(
              db,
              owner.id,
              {
                title: proposed.title,
                description: briefParts![1]!.trim(),
                body: briefParts![2]!.trim() || null,
              },
              now,
            );
            break;
          case "doc_annotation":
            updated = updateDocAnnotation(
              db,
              owner.id,
              {
                claimText: plain,
                // Canonical quote checks have their own progress and evidence
                // invalidation. An unchanged synthesis must not erase that work.
                ...(plain !== owner.markdown
                  ? { verificationState: "unverified" as const, lastVerifiedAt: null }
                  : {}),
              },
              now,
            );
            break;
          case "person_annotation":
            updated = revisePersonAnnotation(
              db,
              owner.id,
              {
                claimText: plain,
                // Canonical quote checks have their own progress and evidence
                // invalidation. An unchanged synthesis must not erase that work.
                ...(plain !== owner.markdown
                  ? { verificationState: "unverified" as const, lastVerifiedAt: null }
                  : {}),
              },
              now,
            );
            break;
          default:
            return assertNever(proposed.kind);
        }
      if (!updated)
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Canonical owner can no longer be revised",
        );
    } finally {
      db.prepare("DELETE FROM knowledge_owner_write_guard WHERE kind=? AND owner_id=?").run(
        proposed.kind,
        owner.id,
      );
    }
    return result;
  })();
}

/** Upgrade is a conversion, not evidence of completion, verification, or renewed intent. */
export function convertKnowledgeOwner(
  db: Database.Database,
  kind: KnowledgeOwnerKind,
  ownerId: string,
  now: number,
): ReturnType<typeof saveKnowledgeNode> {
  return db.transaction(() => {
    const existing = getKnowledgeNode(db, ownerId);
    if (existing) {
      if (existing.kind !== kind || existing.ownerId !== ownerId)
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Canonical owner identity collides with another synthesis node",
        );
      return { node: existing, meaningChanged: false };
    }
    const owner = readKnowledgeOwner(db, kind, ownerId);
    return saveKnowledgeNode(db, buildLegacyOwnerKnowledge(db, owner, 0), now);
  })();
}

export function buildLegacyOwnerKnowledge(
  db: Database.Database,
  owner: KnowledgeOwnerSnapshot,
  expectedRevision: number,
): SaveKnowledgeNodeInput {
  const ownerId = owner.id;
  const kind = owner.kind;
  const versions: Record<string, string> = {};
  for (const id of owner.evidenceDocumentIds) {
    const doc = db
      .prepare<[string], { content_hash: string }>("SELECT content_hash FROM documents WHERE id=?")
      .get(id);
    if (doc) versions[`source:${id}`] = doc.content_hash;
  }
  if (owner.evidenceDocumentIds.length && !Object.keys(versions).length)
    throw new KnowledgeStorageError(
      "reference_invalid",
      "Legacy evidence is unavailable; conversion cannot restore derived text",
    );
  // Escape legacy claim-like syntax: migration must not interpret arbitrary old
  // text as authoritative new provenance markup.
  const escaped = owner.markdown.replace(/<\/?claim\b/g, (token) => `\\${token}`);
  const refs = Object.keys(versions);
  const groups = Array.from({ length: Math.ceil(refs.length / 64) }, (_, index) =>
    refs.slice(index * 64, index * 64 + 64),
  );
  if (groups.length > 16)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Legacy provenance exceeds the bounded conversion context",
    );
  let markdown = escaped;
  const claimStates: NonNullable<SaveKnowledgeNodeInput["claims"]> = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    const id = index === 0 ? "legacy" : `legacy-context-${index}`;
    markdown = `<claim id="${id}" refs="${group.join(" ")}">${markdown}</claim>`;
    claimStates.push({
      id,
      relations: Object.fromEntries(group.map((ref) => [ref, "context" as const])),
    });
  }
  return {
    id: ownerId,
    ownerId,
    kind,
    title: owner.title,
    markdown,
    expectedRevision,
    inputVersions: versions,
    canonicalFields: owner.canonicalFields,
    claims: claimStates,
    metadata: {
      uncertainty: 1,
      activity:
        (kind === "loop" && owner.canonicalFields.state !== "open") ||
        owner.canonicalFields.invalidatedAt != null
          ? "historical"
          : "active",
    },
  };
}
