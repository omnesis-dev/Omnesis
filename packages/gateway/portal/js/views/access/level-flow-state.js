// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sameGrantIntent, scopePolicyIntent } from "../../components/grant-intent.js";
import {
  blocksNewSources,
  isSourceAllowed,
  rulesShareSources,
  sharedScopePolicies,
  sourceId,
} from "../../components/grant-builder-state.js";
import {
  SAVED_FILTER_LABEL,
  sourcePolicy,
  editableSourcePolicy,
} from "../../components/source-filter-state.js";
import { filterModeLabel } from "../../components/access-pills.js";
import { sourceLabel as sourceTypeLabel } from "../../lib/format.js";

/**
 * The decisions a level is made of, in the order every page lists them: the
 * ones any of `drafts` calls for, so a review of a change lists a decision
 * that either side has.
 */
export function levelDecisions(...drafts) {
  const held = (capability) => drafts.some((rules) => rules?.[capability]);
  return [
    "permissions",
    ...(held("answer") ? ["answer-data"] : []),
    ...(held("direct") ? ["direct-data"] : []),
    ...(held("answer") || held("direct") ? ["future"] : []),
    ...(held("answer") ? ["release"] : []),
  ];
}

/** The capability a data decision is about; undefined for any other decision. */
export function dataDecisionCapability(decision) {
  return { "answer-data": "answer", "direct-data": "direct" }[decision];
}

/** Whether Direct follows Answer's sources and filters: both are held and Direct is linked. */
export function directFollowsAnswer(rules, linkDirect) {
  return Boolean(rules.answer && rules.direct && linkDirect);
}

/**
 * The screens a new level walks: its decisions, then the review. A level
 * with both reading capabilities is asked whether Direct follows Answer
 * before — or, when it does, instead of — choosing Direct's own sources.
 */
export function levelDecisionPath(rules, separateDirect = false) {
  const both = rules.answer && rules.direct;
  return [
    ...levelDecisions(rules).flatMap((decision) =>
      decision === "direct-data" && both
        ? ["direct-choice", ...(separateDirect ? [decision] : [])]
        : [decision],
    ),
    "review",
  ];
}
/** Every account a rule names, including the ones that are no longer connected. */
export function levelSourceInventory(sources, ...rules) {
  // An account that is gone is named for its source type: the overview knows it only by id.
  const gone = (id) => ({ id, displayName: sourceTypeLabel(id), available: false });
  const result = new Map(
    sources.map((source) => [
      sourceId(source),
      source.available === false ? { ...source, ...gone(sourceId(source)) } : source,
    ]),
  );
  for (const rule of rules) {
    const retained = [
      ...(rule?.sources?.sourceIds ?? []),
      ...(rule?.scopePolicies ?? []).map((policy) => policy.sourceId),
    ];
    for (const id of retained)
      if (!result.has(id))
        result.set(id, gone(id));
  }
  return [...result.values()];
}
export function sourceBoundarySummary(rule, source) {
  if (!isSourceAllowed(rule, sourceId(source))) return "Not shared";
  const policy = sourcePolicy(rule, sourceId(source));
  if (!policy) return "All content";
  if (!editableSourcePolicy(policy)) return SAVED_FILTER_LABEL;
  const count = policy.rules[0].match?.length ?? 0;
  return `${filterModeLabel(policy.rules[0].action)} · ${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
}
export const sameDecision = sameGrantIntent;
/** Whether Direct reads exactly what Answer uses: the same accounts under the same filters. */
export function directMirrorsAnswer(rules) {
  if (!rules.answer || !rules.direct) return true;
  const filters = (rule) =>
    (rule.scopePolicies ?? [])
      .map((policy) => JSON.stringify(scopePolicyIntent({ ...policy, audience: null })))
      .sort();
  return (
    rulesShareSources(rules) &&
    sameDecision(filters(rules.answer), filters(rules.direct))
  );
}
function dataDecision(rule, sources) {
  if (!rule) return null;
  const known = new Set(sources.map(sourceId));
  return {
    allowed: sources
      .filter((source) => isSourceAllowed(rule, sourceId(source)))
      .map(sourceId)
      .sort(),
    retained: [...(rule.sources.sourceIds ?? [])].filter((id) => !known.has(id)).sort(),
    policies: sharedScopePolicies(rule)
      .map(scopePolicyIntent)
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}
export function changedLevelDecisions(before, after, sources) {
  const changes = [];
  if (!sameDecision(Object.keys(before).sort(), Object.keys(after).sort()))
    changes.push("permissions");
  for (const capability of ["answer", "direct"]) {
    if (
      !sameDecision(
        dataDecision(before[capability], sources),
        dataDecision(after[capability], sources),
      )
    )
      changes.push(`${capability}-data`);
  }
  const future = (rule) =>
    rule ? (blocksNewSources(rule) ? "blocked" : "automatic") : null;
  if (
    ["answer", "direct"].some(
      (capability) => future(before[capability]) !== future(after[capability]),
    )
  )
    changes.push("future");
  if (!sameDecision(before.answer?.release, after.answer?.release)) changes.push("release");
  return changes;
}
