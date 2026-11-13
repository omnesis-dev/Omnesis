// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sameScopePolicyIntent } from "./grant-intent.js";
import { rebindScopePolicy } from "./grant-builder-state.js";

/** What a saved filter the editor cannot express is called, as a status and as a pill. */
export const SAVED_FILTER_LABEL = "Saved filter";

export const cloneFilter = (value) => JSON.parse(JSON.stringify(value));

export function sourcePolicy(rule, sourceId) {
  return rule?.scopePolicies?.find((policy) => policy.sourceId === sourceId) ?? null;
}

export function expectedFilterRevisions(original) {
  return Object.fromEntries(
    ["answer", "direct"]
      .filter((capability) => original?.[capability])
      .map((capability) => [capability, original[capability].filterRevision ?? 0]),
  );
}

export function newSourcePolicy(sourceId, capability, accessLevel = "new") {
  return {
    sourceId,
    audience: { accessLevel, capability },
    rules: [{ action: "share", match: [] }],
    otherwise: "hide",
  };
}

/** The rule holding `policies`, with a filter revision once it has ever held a filter. */
function withScopePolicies(rule, policies) {
  return {
    ...rule,
    ...(rule.filterRevision !== undefined || policies.length
      ? { filterRevision: rule.filterRevision ?? 0 }
      : {}),
    scopePolicies: policies,
  };
}

export function setSourcePolicy(rule, sourceId, policy) {
  const current = sourcePolicy(rule, sourceId);
  if ((!current && !policy) || (current && policy && sameScopePolicyIntent(current, policy)))
    return rule;
  const policies = (rule.scopePolicies ?? []).flatMap((item) =>
    item.sourceId === sourceId ? (policy ? [cloneFilter(policy)] : []) : [item],
  );
  if (policy && !current) policies.push(cloneFilter(policy));
  return withScopePolicies(rule, policies);
}

/** Copy is explicit and never transfers another capability's optimistic revision. */
export function copyRuleFilters(rule, sourceRule, accessLevel = "new") {
  return withScopePolicies(
    rule,
    (sourceRule?.scopePolicies ?? []).map((policy) =>
      rebindScopePolicy(cloneFilter(policy), accessLevel, rule.capability),
    ),
  );
}

/** A filter entry's identity: the field, device and item it names, or the identifiers of a person. */
export function scopeRefKey(ref) {
  if (ref?.capability !== "person") return JSON.stringify([ref?.field, ref?.device ?? "", ref?.id]);
  const tuples = new Map(
    (ref.identifiers ?? []).map((id) => {
      const tuple = [id.type, id.value];
      return [JSON.stringify(tuple), tuple];
    }),
  );
  return JSON.stringify([
    "person",
    [...tuples.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, tuple]) => tuple),
  ]);
}

const IDENTIFIER_TYPES = ["phone", "email", "domain"];
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const text = (value) => typeof value === "string";

/** Whether `ref` is one entry the editor can show and change: an item of a field, or a person. */
function editableRef(ref) {
  if (!ref || typeof ref !== "object") return false;
  if (ref.capability === "person")
    return (
      only(ref, ["capability", "label", "identifiers"]) &&
      text(ref.label) &&
      !!ref.label.trim() &&
      Array.isArray(ref.identifiers) &&
      ref.identifiers.length > 0 &&
      ref.identifiers.every(
        (id) => IDENTIFIER_TYPES.includes(id?.type) && text(id.value) && only(id, ["type", "value"]),
      )
    );
  return (
    ["membership", "tree"].includes(ref.capability) &&
    only(ref, ["capability", "field", "id", "device"]) &&
    text(ref.field) &&
    !!ref.field &&
    text(ref.id) &&
    (ref.device === undefined || (text(ref.device) && !!ref.device)) &&
    (ref.id !== "" || ref.device !== undefined)
  );
}

export function editableSourcePolicy(policy) {
  return Boolean(
    policy &&
    only(policy, ["sourceId", "audience", "rules", "otherwise"]) &&
    policy.audience &&
    only(policy.audience, ["accessLevel", "capability"]) &&
    policy.rules?.length === 1 &&
    ["share", "hide"].includes(policy.rules[0].action) &&
    only(policy.rules[0], ["action", "match"]) &&
    policy.otherwise === (policy.rules[0].action === "share" ? "hide" : "share") &&
    Array.isArray(policy.rules[0].match) &&
    policy.rules[0].match.every(editableRef),
  );
}

/** A whole device of a field whose items belong to a device: everything that device holds. */
export function isDeviceRef(ref) {
  return ref?.capability !== "person" && ref?.id === "" && text(ref?.device);
}

/** The editor field an entry belongs to, or undefined when the account no longer declares it. */
export function refField(editor, ref) {
  return ref?.capability === "person"
    ? editor?.fields?.find((field) => field.capability === "person")
    : editor?.fields?.find((field) => field.field === ref?.field);
}

/** The person entry for an address the gateway has read into its own spelling. */
export function identifierRef(identifier) {
  return {
    capability: "person",
    label: identifier.value,
    identifiers: [{ type: identifier.type, value: identifier.value }],
  };
}

/** A filter holds at most this many entries. */
const MAX_FILTER_ENTRIES = 256;

/**
 * The filter dialog's modes — "only" the matching content, or everything
 * "except" it — and the rule action each is saved as.
 */
export function filterModeAction(mode) {
  return mode === "except" ? "hide" : "share";
}

/** The dialog mode a saved filter opens on. */
export function policyFilterMode(policy) {
  return policy.rules?.[0]?.action === "hide" ? "except" : "only";
}

export function setFilterMode(policy, mode) {
  if (!editableSourcePolicy(policy)) return policy;
  const action = filterModeAction(mode);
  return {
    ...policy,
    rules: [{ ...policy.rules[0], action }],
    otherwise: action === "share" ? "hide" : "share",
  };
}

export function toggleScopeRef(policy, ref) {
  const key = scopeRefKey(ref);
  const refs = policy.rules[0].match;
  const match = refs.some((current) => scopeRefKey(current) === key)
    ? refs.filter((current) => scopeRefKey(current) !== key)
    : [...refs, cloneFilter(ref)];
  return { ...policy, rules: [{ ...policy.rules[0], match }] };
}

export function filterDraftError(policy) {
  if (!editableSourcePolicy(policy))
    return "This filter uses settings this editor cannot change. Its saved policy is preserved.";
  if (!policy.rules[0].match.length) return "Select at least one item.";
  if (policy.rules[0].match.length > MAX_FILTER_ENTRIES)
    return `A filter can include at most ${MAX_FILTER_ENTRIES} items.`;
  return null;
}
