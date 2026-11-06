// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const SCOPE_KINDS = ["conversation", "participant", "label", "folder"];
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

export function setSourcePolicy(rule, sourceId, policy) {
  const policies = (rule.scopePolicies ?? []).filter((current) => current.sourceId !== sourceId);
  if (policy) policies.push(cloneFilter(policy));
  return {
    ...rule,
    ...(rule.filterRevision !== undefined || policies.length
      ? { filterRevision: rule.filterRevision ?? 0 }
      : {}),
    scopePolicies: policies,
  };
}

/** Copy is explicit and never transfers another capability's optimistic revision. */
export function copyRuleFilters(rule, sourceRule, accessLevel = "new") {
  const policies = (sourceRule?.scopePolicies ?? []).map((policy) => ({
    ...cloneFilter(policy),
    audience: { ...policy.audience, accessLevel, capability: rule.capability },
  }));
  return {
    ...rule,
    ...(rule.filterRevision !== undefined || policies.length
      ? { filterRevision: rule.filterRevision ?? 0 }
      : {}),
    scopePolicies: policies,
  };
}

export function scopeRefKey(ref) {
  return ref.kind === "participant"
    ? `participant:${(ref.identifiers ?? [])
        .map((id) => `${id.type}:${id.value}`)
        .sort()
        .join("|")}`
    : `${ref.kind}:${ref.id}`;
}

export function scopeRefLabel(ref) {
  return ref.kind === "participant"
    ? ref.label || (ref.identifiers ?? []).map((id) => id.value).join(" or ")
    : ref.id;
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

export function setFilterMode(policy, mode) {
  if (!editableSourcePolicy(policy)) return policy;
  return {
    ...policy,
    rules: [{ ...policy.rules[0], action: mode === "only" ? "share" : "hide" }],
    otherwise: mode === "only" ? "hide" : "share",
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

export function typedParticipant(type, input) {
  if (!["phone", "email", "domain"].includes(type)) return null;
  let value = input.normalize("NFKC").trim();
  if (value.length > 512) return null;
  if (type === "phone") value = value.replace(/[\s().-]/g, "");
  else {
    value = value.toLowerCase();
    if (type === "domain") value = value.replace(/^@/, "");
  }
  if ((type === "email" && value.length > 320) || (type === "domain" && value.length > 253))
    return null;
  const valid =
    type === "phone"
      ? /^\+[1-9][0-9]{6,14}$/.test(value)
      : type === "email"
        ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        : /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
  return valid ? { kind: "participant", label: value, identifiers: [{ type, value }] } : null;
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
