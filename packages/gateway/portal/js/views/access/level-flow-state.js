// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSourceAllowed, sourceId } from "../../components/grant-builder-state.js";
import { sourcePolicy, editableSourcePolicy } from "../../components/source-filter-state.js";

export function levelDecisionPath(rules, separateDirect = false) {
  const path = ["permissions"];
  if (rules.answer) path.push("answer-data");
  else if (rules.direct) path.push("direct-data");
  if (rules.answer && rules.direct) {
    path.push("direct-choice");
    if (separateDirect) path.push("direct-data");
  }
  if (rules.answer || rules.direct) path.push("future");
  if (rules.answer) path.push("release");
  path.push("review");
  return path;
}
/** Include saved account boundaries even when their source is no longer connected. */
export function levelSourceInventory(sources, ...rules) {
  const result = new Map(sources.map((source) => [sourceId(source), source]));
  for (const rule of rules) {
    const retained = [
      ...(rule?.sources?.sourceIds ?? []),
      ...(rule?.scopePolicies ?? []).map((policy) => policy.sourceId),
    ];
    for (const id of retained)
      if (!result.has(id))
        result.set(id, { id, displayName: "Unavailable account", available: false });
  }
  return [...result.values()];
}
export function sourceBoundarySummary(rule, source) {
  if (!isSourceAllowed(rule, sourceId(source))) return "Not shared";
  const policy = sourcePolicy(rule, sourceId(source));
  if (!policy) return "All content";
  if (!editableSourcePolicy(policy)) return "Saved restriction";
  const count = policy.rules[0].match?.length ?? 0;
  return `${policy.rules[0].action === "share" ? "Only" : "Except"} ${count} selected ${count === 1 ? "match" : "matches"}`;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function sameDecision(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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
    policies: [...(rule.scopePolicies ?? [])].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
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
    rule ? (rule.sources.mode === "allowlist" ? "blocked" : "automatic") : null;
  if (
    ["answer", "direct"].some(
      (capability) => future(before[capability]) !== future(after[capability]),
    )
  )
    changes.push("future");
  if (!sameDecision(before.answer?.release, after.answer?.release)) changes.push("release");
  return changes;
}
