// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const CAPABILITIES = new Set(["answer", "direct", "notes"]);
const SOURCE_MODES = new Set(["all", "allowlist", "denylist"]);
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
function sorted(values, unique = false) {
  const entries = values.map((value) => [JSON.stringify(value), value]);
  const ordered = unique ? [...new Map(entries).entries()] : entries;
  return ordered.sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}
function referenceIntent(ref) {
  const value = canonical(ref);
  if (ref?.kind === "participant") {
    // The snapshot name describes the selection; identifiers determine access.
    delete value.label;
    if (Array.isArray(ref.identifiers))
      value.identifiers = sorted(ref.identifiers.map(canonical), true);
  }
  return value;
}
export function scopePolicyIntent(policy) {
  if (!policy || typeof policy !== "object") return policy;
  const value = canonical(policy);
  if (Array.isArray(policy.rules))
    value.rules = policy.rules.map((rule) => {
      const next = canonical(rule);
      if (["share", "hide"].includes(rule.action) && Array.isArray(rule.match))
        next.match = sorted(rule.match.map(referenceIntent), true);
      return next;
    });
  // Rule order and every unsupported advanced field remain authoritative.
  return value;
}
export function sameScopePolicyIntent(left, right) {
  return JSON.stringify(scopePolicyIntent(left)) === JSON.stringify(scopePolicyIntent(right));
}
function ruleIntent(rule) {
  if (!rule || typeof rule !== "object") return rule;
  const value = canonical(rule);
  if (SOURCE_MODES.has(rule.sources?.mode) && Array.isArray(rule.sources.sourceIds))
    value.sources.sourceIds = sorted(rule.sources.sourceIds.map(canonical), true);
  if (value.sources?.mode === "denylist" && value.sources.sourceIds?.length === 0)
    value.sources.mode = "all";
  if (Array.isArray(rule.scopePolicies))
    value.scopePolicies = sorted(rule.scopePolicies.map(scopePolicyIntent));
  return value;
}
function decisionIntent(value) {
  if (Array.isArray(value))
    return value.every((rule) => CAPABILITIES.has(rule?.capability))
      ? sorted(value.map(ruleIntent))
      : canonical(value);
  if (value && typeof value === "object") {
    if (CAPABILITIES.has(value.capability)) return ruleIntent(value);
    if (Object.keys(value).every((key) => CAPABILITIES.has(key)))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ruleIntent(value[key])]),
      );
  }
  return canonical(value);
}
export function sameGrantIntent(left, right) {
  return JSON.stringify(decisionIntent(left)) === JSON.stringify(decisionIntent(right));
}
