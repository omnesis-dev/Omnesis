// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-compute portion of fuzzy merge-candidate detection. NO database
 * imports — runs on CPU pool workers.
 *
 * Receives pre-fetched alias rows, interaction scores, and decided
 * candidate keys from the IO worker's IO phase, then runs the
 * full tokenization → IDF → inverted-index → scoring pipeline.
 */

import { createLogger, hasValidEmailTld } from "@omnesis/core";
import {
  DEFAULT_SCORE_THRESHOLD,
  DEFAULT_MERGE_CANDIDATE_MAX_RESULTS,
  COMMON_TOKEN_DF_MAX,
  buildDomainSpread,
  distinctNameConcepts,
  findIdentityBridges,
  hasFirstNameConflict,
  hasSurnameConflict,
  isGenericOrgPair,
  isHubPerson,
  isPersonEntity,
  nameMatchStrength,
  ORG_COMMON_TOKEN_DF_MAX,
  scoreTokenBags,
  shouldSuppressCandidate,
  tokenizeAlias,
  type IdfContext,
  type MergeCandidateProposal,
  type SuppressionContext,
  type TokenIdf,
  type TokenLabel,
} from "./domain/MergeCandidateDetector.js";
import type { MergeRuleAliasType } from "./people.js";

const log = createLogger("gateway:merge-candidates:cpu");

export interface MergeCandidatesFetchData {
  aliasRows: Array<{ person_id: string; alias_type: string; alias: string; is_primary: number }>;
  scoreRows: Array<{ id: string; score: number }>;
  decidedKeys: string[];
  /** Identity labels for high-spread tokens (role-mailbox suppression veto). */
  tokenLabels: Array<{ token: string; label: string }>;
  /** Emails flagged non-identifying by people-resolution (firehose mailboxes). */
  blockedEmails: string[];
}

export interface MergeCandidatesCpuOpts {
  scoreThreshold?: number;
  maxResults?: number;
  headPercentile?: number;
}

interface PersonBundle {
  id: string;
  aliases: Array<{ aliasType: MergeRuleAliasType; alias: string }>;
  tokens: Set<string>;
}

const COMMON_TOKEN_DF_CAP = 50;

const STRENGTH_RANK: Record<MergeRuleAliasType, number> = {
  email: 0,
  phone: 1,
  lid: 2,
  name: 3,
};

function pickRepresentative(
  bundle: PersonBundle,
): { aliasType: MergeRuleAliasType; alias: string } | null {
  if (bundle.aliases.length === 0) return null;
  const sorted = [...bundle.aliases].sort((a, b) => {
    const ra = STRENGTH_RANK[a.aliasType];
    const rb = STRENGTH_RANK[b.aliasType];
    if (ra !== rb) return ra - rb;
    return a.alias.localeCompare(b.alias);
  });
  return sorted[0];
}

function canonicalCandidateKey(
  a: { aliasType: MergeRuleAliasType; alias: string },
  b: { aliasType: MergeRuleAliasType; alias: string },
): string {
  const [lo, hi] =
    a.aliasType < b.aliasType || (a.aliasType === b.aliasType && a.alias <= b.alias)
      ? [a, b]
      : [b, a];
  return `${lo.aliasType}|${lo.alias}|${hi.aliasType}|${hi.alias}`;
}

export function scoreMergeCandidates(
  data: MergeCandidatesFetchData,
  opts: MergeCandidatesCpuOpts = {},
): MergeCandidateProposal[] {
  const threshold = opts.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const maxResults = opts.maxResults ?? DEFAULT_MERGE_CANDIDATE_MAX_RESULTS;
  const headPercentile = opts.headPercentile ?? 0.95;

  // Build per-person bundles
  const bundles = new Map<string, PersonBundle>();
  for (const row of data.aliasRows) {
    const aliasType = row.alias_type as MergeRuleAliasType;
    if (
      aliasType !== "email" &&
      aliasType !== "phone" &&
      aliasType !== "lid" &&
      aliasType !== "name"
    ) {
      continue;
    }
    // Defensive mirror of the identity-boundary guard: an email alias ending in
    // a non-existent TLD is an extraction artifact. Skip it so already-extracted
    // junk (created before that guard shipped) never drives a merge candidate.
    if (aliasType === "email" && !hasValidEmailTld(row.alias)) continue;
    let bundle = bundles.get(row.person_id);
    if (!bundle) {
      bundle = { id: row.person_id, aliases: [], tokens: new Set() };
      bundles.set(row.person_id, bundle);
    }
    // Every alias is kept on the bundle so the hub gate + conflict vetoes see the
    // full name set. But only the DOMINANT name is tokenized for matching — a
    // minority name accreted onto a shared identifier can't drive a candidate.
    bundle.aliases.push({ aliasType, alias: row.alias });
    if (aliasType === "name" && row.is_primary !== 1) continue;
    for (const t of tokenizeAlias(aliasType, row.alias)) {
      bundle.tokens.add(t);
    }
  }
  for (const [id, b] of bundles) {
    if (b.tokens.size === 0) bundles.delete(id);
  }

  // Smart-split unsplit email locals. Only a UNIQUE concatenation is split —
  // a long token that recurs across people is an established standalone name
  // (e.g. "alexandre") and splitting it into common fragments ("alex"+"andre")
  // would manufacture a fake two-name match bridging every unrelated Alexandre.
  const corpusFreq = new Map<string, number>();
  for (const b of bundles.values()) {
    for (const t of b.tokens) corpusFreq.set(t, (corpusFreq.get(t) ?? 0) + 1);
  }
  for (const b of bundles.values()) {
    const longTokens = [...b.tokens].filter((t) => t.length >= 8);
    for (const T of longTokens) {
      if ((corpusFreq.get(T) ?? 0) > 1) continue;
      let split: [string, string] | null = null;
      for (let i = 3; i <= T.length - 3; i++) {
        const left = T.slice(0, i);
        const right = T.slice(i);
        if (corpusFreq.has(left) && corpusFreq.has(right)) {
          split = [left, right];
          break;
        }
      }
      if (split) {
        b.tokens.delete(T);
        b.tokens.add(split[0]);
        b.tokens.add(split[1]);
      }
    }
  }

  // Build IDF
  const df: TokenIdf = new Map();
  for (const b of bundles.values()) {
    for (const t of b.tokens) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const ctx: IdfContext = { df, totalPeople: bundles.size };

  // Inverted index
  const postings = new Map<string, Set<string>>();
  for (const b of bundles.values()) {
    for (const t of b.tokens) {
      const dfT = df.get(t) ?? 0;
      if (dfT > COMMON_TOKEN_DF_CAP) continue;
      let set = postings.get(t);
      if (!set) {
        set = new Set();
        postings.set(t, set);
      }
      set.add(b.id);
    }
  }

  // Substring-shadow expansion
  const allTokens = [...postings.keys()];
  for (const L of allTokens) {
    if (L.length < 10) continue;
    for (const S of allTokens) {
      if (S === L) continue;
      if (S.length < 6 || S.length >= L.length) continue;
      if (!L.includes(S)) continue;
      const Lpeople = postings.get(L)!;
      const Spostings = postings.get(S)!;
      for (const p of Lpeople) Spostings.add(p);
    }
  }

  // Interaction-score head gate
  const personScores = new Map<string, number>();
  for (const r of data.scoreRows) personScores.set(r.id, r.score);
  let headThreshold = 0;
  if (headPercentile > 0 && data.scoreRows.length > 0) {
    const sorted = data.scoreRows.map((r) => r.score).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * headPercentile));
    headThreshold = sorted[idx];
  }
  const isHead = (personId: string): boolean => {
    if (headPercentile <= 0) return true;
    const s = personScores.get(personId) ?? 0;
    return s >= headThreshold && s > 0;
  };

  // Decided keys set
  const decidedKeys = new Set(data.decidedKeys);

  // Role-mailbox suppression context: domain-spread is derived from the raw
  // email aliases, labels + blocklist arrive pre-fetched from the IO phase.
  const suppression: SuppressionContext = {
    domainSpread: buildDomainSpread(data.aliasRows),
    tokenLabels: new Map(data.tokenLabels.map((r) => [r.token, r.label as TokenLabel])),
    blockedEmails: new Set(data.blockedEmails.map((e) => e.toLowerCase())),
  };

  // Hub buckets: a person carrying ≥2 distinct people's names (a shared RT
  // queue / notification relay) — excluded so it can't bridge unrelated
  // identity clusters.
  const hubIds = new Set<string>();
  for (const b of bundles.values()) {
    const names = b.aliases.filter((al) => al.aliasType === "name").map((al) => al.alias);
    if (isHubPerson(names)) hubIds.add(b.id);
  }

  // Generate pairs
  const seenPairs = new Set<string>();
  const proposals: MergeCandidateProposal[] = [];
  let skippedByHeadGate = 0;
  let skippedByFamilyGate = 0;
  let skippedBySuppression = 0;
  let skippedByFirstName = 0;
  let skippedBySurname = 0;
  let skippedByGenericOrg = 0;
  let skippedByHub = 0;

  for (const [_token, personSet] of postings) {
    if (personSet.size < 2) continue;
    const persons = [...personSet];
    for (let i = 0; i < persons.length; i++) {
      for (let j = i + 1; j < persons.length; j++) {
        const a = persons[i];
        const b = persons[j];
        const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        if (!isHead(a) && !isHead(b)) {
          skippedByHeadGate += 1;
          continue;
        }

        // Hub gate: never propose a pair involving a shared-queue bucket.
        if (hubIds.has(a) || hubIds.has(b)) {
          skippedByHub += 1;
          continue;
        }

        const bundleA = bundles.get(a)!;
        const bundleB = bundles.get(b)!;
        const repA = pickRepresentative(bundleA);
        const repB = pickRepresentative(bundleB);
        if (!repA || !repB) continue;

        const candKey = canonicalCandidateKey(repA, repB);
        if (decidedKeys.has(candKey)) continue;

        const crossType = repA.aliasType !== repB.aliasType;
        const result = scoreTokenBags([...bundleA.tokens], [...bundleB.tokens], ctx, { crossType });
        if (result.score < threshold) continue;

        // Name gate: require a full-name match — ≥2 distinct name concepts
        // (collapsing initials / prefix-variants). A single shared name concept
        // (two people who share only a first name, even spelled "C." +
        // "Christophe") is not an identity match.
        if (distinctNameConcepts(result.matchedTokens).length < 2) {
          skippedByFamilyGate += 1;
          continue;
        }

        // Role-mailbox gate: cross-org matches resting only on generic
        // functional words (reservations@a ↔ reservations@b) are dropped.
        if (shouldSuppressCandidate(repA, repB, result.matchedTokens, suppression)) {
          skippedBySuppression += 1;
          continue;
        }

        // First-name-conflict gate: a shared surname but conflicting given names
        // (Alex Reeves vs Jamie Reeves) is two different people, not a merge.
        if (hasFirstNameConflict(bundleA.aliases, bundleB.aliases, result.matchedTokens)) {
          skippedByFirstName += 1;
          continue;
        }

        // Surname-conflict gate (the mirror): a shared compound given name but
        // conflicting surnames (Jean-Marc Roussel vs Jean-Marc Varenne) is two
        // different namesakes, not a merge.
        if (hasSurnameConflict(bundleA.aliases, bundleB.aliases, result.matchedTokens)) {
          skippedBySurname += 1;
          continue;
        }

        // Generic-org gate: two org/role mailboxes on different domains matching
        // only on generic words (no distinctive brand) are different organisations.
        if (
          isGenericOrgPair(
            repA,
            repB,
            result.matchedTokens,
            isPersonEntity(bundleA.aliases),
            isPersonEntity(bundleB.aliases),
            (t) => (df.get(t) ?? 0) > ORG_COMMON_TOKEN_DF_MAX,
          )
        ) {
          skippedByGenericOrg += 1;
          continue;
        }

        proposals.push({
          sideA: repA,
          sideB: repB,
          score: result.score,
          matchedTokens: result.matchedTokens,
          matchStrength: nameMatchStrength(
            result.matchedTokens,
            (t) => (df.get(t) ?? 0) > COMMON_TOKEN_DF_MAX,
          ),
          detectionKind: "name_token_overlap",
          personA: a,
          personB: b,
        });
      }
    }
  }

  // Identity-bridge guard: drop edges incident to a record that bridges ≥2
  // token-disjoint identity clusters (it matches different people on tokens that
  // share nothing) — left in, it fuses them into one giant false component.
  const bridges = findIdentityBridges(
    proposals.map((p) => ({ a: p.personA, b: p.personB, matchedTokens: p.matchedTokens })),
  );
  let skippedByBridge = 0;
  const kept = proposals.filter((p) => {
    if (bridges.has(p.personA) || bridges.has(p.personB)) {
      skippedByBridge += 1;
      return false;
    }
    return true;
  });

  kept.sort((x, y) => y.score - x.score);
  if (kept.length > maxResults) kept.length = maxResults;
  if (
    skippedByHeadGate > 0 ||
    skippedByFamilyGate > 0 ||
    skippedBySuppression > 0 ||
    skippedByFirstName > 0 ||
    skippedBySurname > 0 ||
    skippedByGenericOrg > 0 ||
    skippedByBridge > 0 ||
    skippedByHub > 0 ||
    kept.length > 0
  ) {
    log.info(
      `gates p${(headPercentile * 100).toFixed(0)}: threshold=${headThreshold.toExponential(2)}, ${kept.length} proposals kept, ${skippedByHeadGate} long-tail, ${skippedByFamilyGate} single-name, ${skippedBySuppression} role-mailbox, ${skippedByFirstName} first-name-conflict, ${skippedBySurname} surname-conflict, ${skippedByGenericOrg} generic-org, ${skippedByBridge} bridge, ${skippedByHub} hub`,
    );
  }
  return kept;
}
