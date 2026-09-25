// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Forwarder shell for the merge subsystem.
 *
 * The implementation lives under `domain/merge/` split by concern
 * (primitives, rule-crud, rule-evaluator, auto-detect, full-rebuild).
 * This file is kept so external import paths
 * (`./domain/MergeService.js`) stay stable.
 */

export {
  mergePeople,
  unmergePerson,
  pickWinner,
  createMergeRule,
  deleteMergeRule,
  deleteMergeRuleGroup,
  resolveAliasSide,
  listMergeRules,
  countMergeRules,
  getMergeRuleById,
  readMergeRulesMeta,
  computeMergeEquivalences,
  fetchMergeEquivalencesData,
  computeMergeEquivalencesFromData,
  upsertMergeEquivalences,
  computeAutoDetectedRules,
  fetchAutoDetectData,
  computeAutoDetectedRulesFromData,
  upsertAutoDetectedRules,
  rebuildPeopleFromDocuments,
} from "./merge/index.js";

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
  AutoDetectUpsertResult,
  AutoDetectUpsertResumeState,
  RebuildPhase,
} from "./merge/index.js";
