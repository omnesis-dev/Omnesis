// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isDeepStrictEqual } from "node:util";
import { marked } from "marked";
import { decisionPayloadErasureGeneration } from "../decision-payload.js";
import { recordCheckPolicyKey } from "../record-check/rubric.js";
import { WIKI_REPAIR_RUBRIC_VERSION } from "../record-check/wiki-rubric.js";
import { parseClaimMarkup } from "./claims.js";
import { getKnowledgeClaims, getKnowledgeDependencies, getKnowledgeNode } from "./storage-read.js";
import { knowledgeHash } from "./storage-validation.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type Database from "better-sqlite3";

export interface WikiRepairAssessment {
  fingerprint: string;
  policy: string;
  rubricVersion: typeof WIKI_REPAIR_RUBRIC_VERSION;
  decisionId: string;
  erasureGeneration: number;
}

/** Server-owned scope check; a request alone never authorizes the writer exception. */
export function wikiFactualRepairSnapshot(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  resolvedStates = false,
) {
  const request = input.maintenance?.curationDeferral?.factualRepair;
  const previous = getKnowledgeNode(db, input.id);
  const refuse = (): never => {
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Factual repair requires an existing offered wiki, unchanged title/headings/claim identities, complete bounded before/after content, and only the explicitly named corrective claim changes; unrelated edits and claim deletion are not permitted",
    );
  };
  if (
    !request ||
    !previous ||
    input.kind !== "wiki" ||
    input.expectedRevision !== previous.revision ||
    input.title !== previous.title ||
    previous.markdown.length > 24_000 ||
    input.markdown.length > 24_000 ||
    !isDeepStrictEqual(input.canonicalFields ?? previous.canonicalFields, previous.canonicalFields)
  )
    return refuse();
  const before = parseClaimMarkup(previous.markdown),
    after = parseClaimMarkup(input.markdown);
  const shape = (parsed: typeof before) => parsed.claims.map((c) => [c.id, c.parentId]);
  const outside = (parsed: typeof before) => {
    let text = parsed.text;
    for (const claim of [...parsed.claims].filter((c) => c.parentId === null).reverse())
      text =
        text.slice(0, claim.textSpan.start) +
        `<claim:${claim.id}>` +
        text.slice(claim.textSpan.end);
    return text;
  };
  const headings = (text: string) => {
    const result: string[] = [];
    void marked.walkTokens(marked.lexer(text), (token) => {
      if (token.type === "heading") result.push(token.raw);
    });
    return result;
  };
  if (
    outside(before) !== outside(after) ||
    !isDeepStrictEqual(shape(before), shape(after)) ||
    !isDeepStrictEqual(headings(before.text), headings(after.text))
  )
    return refuse();
  const requested = new Set(request.claimIds);
  if (
    !requested.size ||
    requested.size > 8 ||
    requested.size !== request.claimIds.length ||
    [...requested].some((id) => !before.claims.some((c) => c.id === id))
  )
    return refuse();
  const states = new Map(getKnowledgeClaims(db, input.id).map((c) => [c.id, c]));
  const supplied = new Map(input.claims?.map((c) => [c.id, c]));
  const deps = getKnowledgeDependencies(db, input.id);
  const normalized = after.claims.map((claim, index) => {
    const old = before.claims[index]!;
    const prior = states.get(claim.id);
    if (!prior) return refuse();
    const suppliedState = supplied.get(claim.id);
    // The service inherits omitted metadata before saving; the raw writer defaults it.
    // Fingerprint the semantics that this caller will actually persist.
    const next = resolvedStates
      ? {
          supportLogic: suppliedState?.supportLogic ?? "all",
          modality: suppliedState?.modality ?? "observation",
          epistemicStatus: suppliedState?.epistemicStatus ?? "asserted",
          attribution: suppliedState?.attribution ?? null,
          validFrom: suppliedState?.validFrom ?? null,
          validUntil: suppliedState?.validUntil ?? null,
          relations: suppliedState?.relations ?? {},
        }
      : suppliedState;
    const previousRelations = Object.fromEntries(
      deps.filter((d) => d.claimId === claim.id).map((d) => [d.ref, d.relation]),
    );
    const semantics = {
      supportLogic: next?.supportLogic ?? prior.supportLogic,
      modality: next?.modality ?? prior.modality,
      epistemicStatus: next?.epistemicStatus ?? prior.epistemicStatus,
      attribution: next?.attribution === undefined ? prior.attribution : next.attribution,
      validFrom: next?.validFrom === undefined ? prior.validFrom : next.validFrom,
      validUntil: next?.validUntil === undefined ? prior.validUntil : next.validUntil,
      relations: Object.fromEntries(
        claim.refs.map((ref) => [
          ref.raw,
          (next?.relations ?? previousRelations)[ref.raw] ?? "supports",
        ]),
      ),
    };
    if (!requested.has(claim.id)) {
      const oldSemantics = {
        supportLogic: prior.supportLogic,
        modality: prior.modality,
        epistemicStatus: prior.epistemicStatus,
        attribution: prior.attribution,
        validFrom: prior.validFrom,
        validUntil: prior.validUntil,
        relations: previousRelations,
      };
      if (
        claim.ownText !== old.ownText ||
        !isDeepStrictEqual(
          claim.refs.map((r) => r.raw),
          old.refs.map((r) => r.raw),
        ) ||
        !isDeepStrictEqual(semantics, oldSemantics)
      )
        return refuse();
    }
    // Qualification may change, but not by relabelling an assertion as non-factual.
    if (
      semantics.epistemicStatus !== "asserted" ||
      semantics.supportLogic !== prior.supportLogic ||
      Object.values(semantics.relations).some((relation) => relation !== "supports") ||
      Object.values(previousRelations).some((relation) => relation !== "supports")
    )
      return refuse();
    return { id: claim.id, semantics };
  });
  if (
    before.text === after.text &&
    isDeepStrictEqual(
      normalized.map((c) => c.semantics),
      before.claims.map((c) => {
        const state = states.get(c.id)!;
        return {
          supportLogic: state.supportLogic,
          modality: state.modality,
          epistemicStatus: state.epistemicStatus,
          attribution: state.attribution,
          validFrom: state.validFrom,
          validUntil: state.validUntil,
          relations: Object.fromEntries(
            deps.filter((d) => d.claimId === c.id).map((d) => [d.ref, d.relation]),
          ),
        };
      }),
    )
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Use ordinary curationDeferral for unchanged prose proof repair; factualRepair requires an actual corrective delta",
    );
  return {
    fingerprint: knowledgeHash([
      previous.revision,
      previous.markdown,
      input.title,
      input.markdown,
      normalized,
      input.inputVersions,
      [...requested].sort(),
    ]),
    beforeStates: [...states.values()].map(
      ({ id, supportLogic, attribution, modality, epistemicStatus, validFrom, validUntil }) => ({
        id,
        supportLogic,
        attribution,
        modality,
        epistemicStatus,
        validFrom,
        validUntil,
      }),
    ),
    afterStates: normalized,
  };
}

export function wikiFactualRepairFingerprint(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  resolvedStates = false,
): string {
  return wikiFactualRepairSnapshot(db, input, resolvedStates).fingerprint;
}

export function assertWikiRepairAssessment(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  resolvedStates = false,
): void {
  const fingerprint = wikiFactualRepairFingerprint(db, input, resolvedStates),
    receipt = input.wikiRepairAssessment;
  const hasLedger = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cognition_decisions'")
    .get();
  const decision =
    receipt && hasLedger
      ? db
          .prepare<
            [string],
            {
              run_id: string;
              record_id: string;
              rubric_version: string;
              enforced: number;
              verdict: string;
              requested_model_id: string;
            }
          >(
            "SELECT run_id,record_id,rubric_version,enforced,verdict,requested_model_id FROM cognition_decisions WHERE id=?",
          )
          .get(receipt.decisionId)
      : undefined;
  if (
    !receipt ||
    !decision ||
    decision.run_id !== input.maintenance?.runId ||
    decision.record_id !== input.id ||
    decision.rubric_version !== WIKI_REPAIR_RUBRIC_VERSION ||
    decision.enforced !== 1 ||
    decision.verdict !== "pass" ||
    receipt.policy !== recordCheckPolicyKey("enforce", decision.requested_model_id) ||
    receipt.rubricVersion !== WIKI_REPAIR_RUBRIC_VERSION ||
    !receipt.decisionId ||
    !receipt.policy ||
    receipt.fingerprint !== fingerprint ||
    receipt.erasureGeneration !== decisionPayloadErasureGeneration(db)
  )
    throw new KnowledgeStorageError(
      "claim_invalid",
      "Factual repair requires a current enforced repair-integrity assessment for this exact proposal; unavailable or observational decisions cannot authorize it",
    );
}
