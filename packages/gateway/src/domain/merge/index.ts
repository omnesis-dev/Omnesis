// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Barrel for the merge subsystem. Re-exports every public entry from
 * the per-concern modules so consumers (people.ts, MergeService.ts,
 * MergeCandidateDetector.ts) keep one stable import surface.
 */

export { mergePeople, unmergePerson, pickWinner } from "./primitives.js";

export {
  createMergeRule,
  deleteMergeRule,
  deleteMergeRuleGroup,
  resolveAliasSide,
  listMergeRules,
  countMergeRules,
  getMergeRuleById,
  readMergeRulesMeta,
} from "./rule-crud.js";

export {
  computeMergeEquivalences,
  fetchMergeEquivalencesData,
  computeMergeEquivalencesFromData,
  upsertMergeEquivalences,
} from "./rule-evaluator.js";

export {
  computeAutoDetectedRules,
  fetchAutoDetectData,
  computeAutoDetectedRulesFromData,
  upsertAutoDetectedRules,
} from "./auto-detect.js";
export type { AutoDetectUpsertResult, AutoDetectUpsertResumeState } from "./auto-detect.js";

export { rebuildPeopleFromDocuments } from "./full-rebuild.js";
export type { RebuildPhase } from "./full-rebuild.js";

export type {
  MergeRuleAliasType,
  MergeRuleKind,
  MergeWinnerSide,
  MergeRuleSide,
  MergeRule,
  CreateMergeRuleInput,
  CreateMergeRuleResult,
  ListMergeRulesOpts,
  ResolvedSidePerson,
  MergeRuleWithResolved,
  MergeEquivalenceRow,
  MergeEquivalenceSnapshot,
  UpsertMergeEquivalencesResult,
  AutoDetectedRule,
  MergeEquivalencesIoData,
  AutoDetectIoData,
} from "./types.js";
