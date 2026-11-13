// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sameScopePolicyIntent } from "./grant-intent.js";
import { rebindScopePolicy } from "./grant-builder-state.js";

const SCOPE_KINDS = ["conversation", "participant", "label", "folder"];

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

export function scopeRefKey(ref) {
  if (ref.kind !== "participant") return JSON.stringify([ref.kind, ref.id]);
  const tuples = new Map(
    (ref.identifiers ?? []).map((id) => {
      const tuple = [id.type, id.value];
      return [JSON.stringify(tuple), tuple];
    }),
  );
  return JSON.stringify([
    "participant",
    [...tuples.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, tuple]) => tuple),
  ]);
}

export function editableSourcePolicy(policy) {
  return Boolean(
    policy &&
    Object.keys(policy).every((key) =>
      ["sourceId", "audience", "rules", "otherwise"].includes(key),
    ) &&
    policy.audience &&
    Object.keys(policy.audience).every((key) => ["accessLevel", "capability"].includes(key)) &&
    policy.rules?.length === 1 &&
    ["share", "hide"].includes(policy.rules[0].action) &&
    Object.keys(policy.rules[0]).every((key) => ["action", "match"].includes(key)) &&
    policy.otherwise === (policy.rules[0].action === "share" ? "hide" : "share") &&
    Array.isArray(policy.rules[0].match) &&
    policy.rules[0].match.every(
      (ref) =>
        SCOPE_KINDS.includes(ref.kind) &&
        Object.keys(ref).every((key) =>
          (ref.kind === "participant" ? ["kind", "label", "identifiers"] : ["kind", "id"]).includes(
            key,
          ),
        ) &&
        (ref.kind !== "participant" ||
          (typeof ref.label === "string" &&
            !!ref.label.trim() &&
            Array.isArray(ref.identifiers) &&
            ref.identifiers.every(
              (id) =>
                ["phone", "email", "domain"].includes(id.type) &&
                Object.keys(id).every((key) => ["type", "value"].includes(key)),
            ))),
    ),
  );
}

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

/** The kinds of item a filter matches on. */
function policyKinds(policy) {
  return (policy?.rules ?? []).flatMap((rule) => (rule.match ?? []).map((ref) => ref.kind));
}

/** The kinds a filter matches on that the account is still working out, from its readiness. */
export function unreadyKinds(policy, readiness = []) {
  const required = new Set(policyKinds(policy));
  return (readiness ?? []).filter((item) => required.has(item.kind) && !item.ready);
}

export function toggleScopeRef(policy, ref) {
  const key = scopeRefKey(ref);
  const refs = policy.rules[0].match;
  const match = refs.some((current) => scopeRefKey(current) === key)
    ? refs.filter((current) => scopeRefKey(current) !== key)
    : [...refs, cloneFilter(ref)];
  return { ...policy, rules: [{ ...policy.rules[0], match }] };
}

export function addProposedIdentifiers(policy, proposal) {
  const match = policy.rules[0].match.map((ref, index) => {
    if (index !== proposal.itemIndex || ref.kind !== "participant") return ref;
    const ids = new Map(ref.identifiers.map((id) => [`${id.type}:${id.value}`, id]));
    for (const id of proposal.identifiers)
      ids.set(`${id.type}:${id.value}`, { type: id.type, value: id.value });
    return { ...ref, identifiers: [...ids.values()] };
  });
  return { ...policy, rules: [{ ...policy.rules[0], match }] };
}

const UNICODE_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const ASCII_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A host name written in another script; the gateway decides whether it names a domain.
const WORLD_DOMAIN = /^[^\s@/:*.]+(?:\.[^\s@/:*.]+)+$/;
const hostName = (value) => value.toLowerCase().replace(/\.+$/, "");

function typedPhone(input) {
  // "+44 (0)20 …" does not say whether the zero is dialled, so it names no single number.
  if (/\(\s*0\s*\)/.test(input)) return null;
  let value = input
    .replace(/^tel:/i, "")
    .replace(UNICODE_DASHES, "-")
    .replace(/[\s().-]/g, "");
  if (/^00[1-9]/.test(value)) value = `+${value.slice(2)}`;
  return /^\+[1-9][0-9]{6,14}$/.test(value) ? value : null;
}

function typedEmail(input) {
  const angle = /<([^<>]*)>$/.exec(input);
  const value = hostName((angle ? angle[1] : input).trim().replace(/^mailto:/i, ""));
  return value.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? value : null;
}

function typedDomain(input) {
  const value = hostName(input.replace(/^@/, ""));
  // eslint-disable-next-line no-control-regex
  const pattern = /^[\x00-\x7f]*$/.test(value) ? ASCII_DOMAIN : WORLD_DOMAIN;
  return value.length <= 253 && pattern.test(value) ? value : null;
}

/**
 * The filter item for an address typed by hand, or null when the text names no
 * address of that type. It reads every way of writing an address the gateway
 * reads (separators, a leading 00, a tel: or mailto: prefix, a display name,
 * capitals) into the gateway's spelling, so the item is recognised as already
 * selected and lines up with the counts the gateway returns for it. The
 * gateway stays the authority on what it saves.
 */
export function typedParticipant(type, input) {
  if (input.length > 512) return null;
  const text = input.normalize("NFKC").trim();
  const value =
    type === "phone"
      ? typedPhone(text)
      : type === "email"
        ? typedEmail(text)
        : type === "domain"
          ? typedDomain(text)
          : null;
  return value ? { kind: "participant", label: value, identifiers: [{ type, value }] } : null;
}

export function filterDraftError(policy, source) {
  if (!editableSourcePolicy(policy))
    return "This filter uses settings this editor cannot change. Its saved policy is preserved.";
  if (!policy.rules[0].match.length) return "Select at least one item.";
  if (policy.rules[0].match.reduce((sum, ref) => sum + (ref.identifiers?.length ?? 1), 0) > 256)
    return "A filter can include at most 256 values.";
  const kinds = new Set(policy.rules[0].match.map((ref) => ref.kind));
  for (const kind of kinds) {
    const readiness = source.scopeReadiness?.find((item) => item.kind === kind);
    if (!readiness?.ready)
      return readiness?.message ?? "This source is not ready for this filter yet.";
  }
  return null;
}

/** One owner action can never let an older asynchronous response replace another source/query. */
export function requestIdentity(sourceId, kind, query = "", parentId = "") {
  return JSON.stringify([sourceId, kind, query, parentId]);
}
