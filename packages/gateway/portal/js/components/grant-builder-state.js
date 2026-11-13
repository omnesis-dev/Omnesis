// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const SOURCE_MODES = ["all", "allowlist", "denylist"];

/** The capabilities a level can hold, in the order they are always shown and saved. */
export const CAPABILITIES = ["answer", "direct", "notes"];

const CAPABILITY_NAMES = { answer: "Answer", direct: "Direct", notes: "Notes" };

/** What a capability is called wherever it is named. */
export function capabilityName(capability) {
  return CAPABILITY_NAMES[capability];
}
export const DEFAULT_POLICY_FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const MAX_SOURCE_IDS = 256;

function uniqueSorted(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value))].sort();
}

export function sourceId(source) {
  return source.id ?? source.sourceId ?? "";
}

export function sourceLabel(source) {
  return source.displayName ?? source.name ?? source.accountName ?? sourceId(source);
}

export function policyFamilyId(policy) {
  return policy?.id ?? policy?.familyId ?? "";
}

export function policyFamilyName(policy) {
  return policy?.name ?? policy?.familyName ?? "Unnamed policy";
}

/** The policy a reviewed release names, or undefined when `policies` does not carry it. */
export function findPolicyFamily(policies, id) {
  return policies.find((policy) => policyFamilyId(policy) === id);
}

export function defaultPolicyFamilyId(policies = [], configured = null) {
  if (configured && findPolicyFamily(policies, configured)) {
    return configured;
  }
  return policyFamilyId(policies.find((policy) => policy.isDefault)) ||
    policyFamilyId(policies[0]) ||
    DEFAULT_POLICY_FAMILY_ID;
}

/** New capability rules deliberately grant no current source until the owner selects one. */
export function newGrantRule(capability, selectedPolicyFamilyId = DEFAULT_POLICY_FAMILY_ID) {
  const common = {
    capability,
    sources: { mode: capability === "notes" ? "all" : "allowlist", sourceIds: [] },
  };
  return capability === "answer"
    ? {
        ...common,
        release: { mode: "reviewed", policyFamilyId: selectedPolicyFamilyId },
      }
    : common;
}

/**
 * The sources a wire rule allows. A rule with source filters carries its real
 * selection in `scopeSources`; its `sources` then leaves the filtered accounts
 * out, for clients that do not apply filters.
 */
function normalizeSources(rule) {
  if (rule?.scopeSources && SOURCE_MODES.includes(rule.scopeSources.mode)) {
    return { mode: rule.scopeSources.mode, sourceIds: uniqueSorted(rule.scopeSources.sourceIds) };
  }
  if (rule?.sources && SOURCE_MODES.includes(rule.sources.mode)) {
    return { mode: rule.sources.mode, sourceIds: uniqueSorted(rule.sources.sourceIds) };
  }
  // V1 overview compatibility. V1 rules were always all-source.
  if (SOURCE_MODES.includes(rule?.sourceMode)) {
    return { mode: rule.sourceMode, sourceIds: uniqueSorted(rule.sourceIds) };
  }
  return { mode: "all", sourceIds: [] };
}

function normalizeAnswerRelease(rule, fallbackPolicyFamilyId) {
  if (rule?.release?.mode === "unreviewed") return { mode: "unreviewed" };
  if (rule?.releaseMode === "unreviewed") return { mode: "unreviewed" };
  if (rule?.release?.mode === "reviewed") {
    return { mode: "reviewed", policyFamilyId: rule.release.policyFamilyId ?? "" };
  }
  if (rule?.privacyPolicy === "unreviewed") return { mode: "unreviewed" };
  return {
    mode: "reviewed",
    policyFamilyId: (
      rule?.policyFamilyId ??
      (rule?.privacyPolicy && rule.privacyPolicy !== "default" ? rule.privacyPolicy : "")
    ) || fallbackPolicyFamilyId,
  };
}

export function normalizeGrantRules(rules = [], fallbackPolicyFamilyId = "") {
  const normalized = {};
  const input = Array.isArray(rules)
    ? rules
    : CAPABILITIES.flatMap((capability) => rules?.[capability] ? [rules[capability]] : []);
  for (const rule of input) {
    if (!CAPABILITIES.includes(rule?.capability) || normalized[rule.capability]) continue;
    const release = rule.capability === "answer"
      ? normalizeAnswerRelease(rule, fallbackPolicyFamilyId)
      : null;
    const retained = { ...rule };
    // `scopeSources` is read-only wire data: the selection is sent back as `sources`.
    for (const key of ["sourceMode", "sourceIds", "scopeSources", "releaseMode", "policyFamilyId", "policyRevision", "privacyPolicy"]) delete retained[key];
    normalized[rule.capability] = {
      ...retained,
      capability: rule.capability,
      sources: normalizeSources(rule),
      ...(rule.capability === "answer"
        ? {
            release,
          }
        : {}),
    };
  }
  return normalized;
}

/**
 * The rules as they are saved. A draft keeps the filter of an account that was
 * unselected, so selecting it again brings the filter back; what is saved
 * holds filters only for the accounts the capability shares.
 */
export function serializeGrantRules(state) {
  return CAPABILITIES.flatMap((capability) => {
    const rule = state?.[capability];
    if (!rule) return [];
    const common = {
      ...rule,
      ...(rule.scopePolicies ? { scopePolicies: sharedScopePolicies(rule) } : {}),
      capability,
      sources: {
        mode: rule.sources.mode,
        sourceIds: uniqueSorted(rule.sources.sourceIds),
      },
    };
    return capability === "answer"
      ? [{
          ...common,
          release: rule.release.mode === "unreviewed"
            ? { mode: "unreviewed" }
            : { mode: "reviewed", policyFamilyId: rule.release.policyFamilyId },
        }]
      : [common];
  });
}

/**
 * The filters in effect: a filter a draft keeps on an account that is not
 * shared is neither enforced nor saved.
 */
export function sharedScopePolicies(rule) {
  return (rule?.scopePolicies ?? []).filter((policy) => isSourceAllowed(rule, policy.sourceId));
}

/** The same filter, held by another access level or capability. */
export function rebindScopePolicy(policy, accessLevel, capability) {
  return { ...policy, audience: { ...policy.audience, accessLevel, capability } };
}

/** A fresh authority owns new revisions and audiences, never the matched connection's fence. */
export function serializeNewAuthorityRules(state) {
  return serializeGrantRules(state).map((rule) => {
    if (rule.filterRevision === undefined && !rule.scopePolicies?.length) return rule;
    return {
      ...rule,
      filterRevision: 0,
      scopePolicies: (rule.scopePolicies ?? []).map((policy) =>
        rebindScopePolicy(policy, "new", rule.capability),
      ),
    };
  });
}

export function newAuthorityFilterError(state, authoringEnabled) {
  return authoringEnabled !== true && serializeGrantRules(state).some((rule) => rule.scopePolicies?.length)
    ? "Creating a new access level with these saved filters requires experimental mode. Choose an existing access level to keep its filters."
    : null;
}

export const SAVED_FILTER_SOURCE_MESSAGE =
  "Sources with saved filters must stay allowed while filter editing is unavailable. You can still remove the capability.";

export function sourceBoundaryBlocksSavedFilter(rule, authoringEnabled) {
  return authoringEnabled !== true &&
    (rule.scopePolicies ?? []).some((policy) => !isSourceAllowed(rule, policy.sourceId));
}

/**
 * What is wrong with one source boundary, worded for the decision that owns
 * it. `scope` names the capability the boundary governs; `sources` are the
 * sources the gateway knows, so a boundary that allows none of them is
 * caught however it was reached.
 */
export function sourceBoundaryError(rule, scope, sources = []) {
  if (!rule) return null;
  if (!SOURCE_MODES.includes(rule.sources.mode)) return "Choose how new sources are handled.";
  if (uniqueSorted(rule.sources.sourceIds).length > MAX_SOURCE_IDS) {
    return `${scope} can record at most ${MAX_SOURCE_IDS} source selections.`;
  }
  if (blocksNewSources(rule) && rule.sources.sourceIds.length === 0) {
    return `Select at least one source for ${scope}.`;
  }
  if (!readsAnySource(rule, sources)) return `${scope} would not be able to read any source.`;
  return null;
}

/**
 * Whether a boundary allows at least one known source. With no source known
 * yet, only an empty allowlist reads nothing, and that has its own message.
 */
function readsAnySource(rule, sources) {
  if (rule.sources.mode === "all" || sources.length === 0) return true;
  return sources.some((source) => isSourceAllowed(rule, sourceId(source)));
}

/** What is wrong with Answer's release — the one fault no source card owns. */
export function releaseError(state) {
  const answer = state?.answer;
  if (!answer) return null;
  if (answer.release.mode === "reviewed" && !answer.release.policyFamilyId) {
    return "Choose a privacy policy for Answer, or explicitly choose unreviewed release.";
  }
  return null;
}

export function validateGrantRules(state, sources = []) {
  const rules = serializeGrantRules(state);
  if (rules.length === 0) return NO_CAPABILITY_MESSAGE;
  for (const rule of rules) {
    const error = sourceBoundaryError(state[rule.capability], capabilityName(rule.capability), sources);
    if (error) return error;
  }
  return releaseError(state);
}

/** What a draft that grants nothing is told; nothing else means much until it grants something. */
export const NO_CAPABILITY_MESSAGE = "Choose at least one permission.";

export function hasCapability(state) {
  return CAPABILITIES.some((capability) => Boolean(state?.[capability]));
}

/** Whether sources connected later stay out until the owner allows each one. */
export function blocksNewSources(rule) {
  return rule.sources.mode === "allowlist";
}

export function isSourceAllowed(rule, id) {
  if (rule.sources.mode === "all") return true;
  const listed = rule.sources.sourceIds.includes(id);
  return blocksNewSources(rule) ? listed : !listed;
}

/** Change future-source behavior without changing access to any source visible now. */
export function setSourceMode(rule, mode, allSourceIds) {
  const allowed = uniqueSorted(allSourceIds).filter((id) => isSourceAllowed(rule, id));
  return {
    ...rule,
    sources: {
      mode,
      sourceIds: mode === "all"
        ? []
        : mode === "allowlist"
          ? allowed
          : uniqueSorted(allSourceIds).filter((id) => !allowed.includes(id)),
    },
  };
}

export function setSourceAllowed(rule, id, allowed) {
  if (rule.sources.mode === "all") {
    return allowed
      ? rule
      : { ...rule, sources: { mode: "denylist", sourceIds: [id] } };
  }
  const listed = new Set(rule.sources.sourceIds);
  const shouldList = blocksNewSources(rule) ? allowed : !allowed;
  if (shouldList) listed.add(id);
  else listed.delete(id);
  return { ...rule, sources: { ...rule.sources, sourceIds: uniqueSorted([...listed]) } };
}

/** Change only whether sources connected later inherit access. */
export function setFutureSourcesAllowed(rule, allowed, allSourceIds) {
  if (!allowed) return setSourceMode(rule, "allowlist", allSourceIds);
  const visibleIds = uniqueSorted(allSourceIds);
  const allowedIds = visibleIds.filter((id) => isSourceAllowed(rule, id));
  if (allowedIds.length === visibleIds.length) {
    return { ...rule, sources: { mode: "all", sourceIds: [] } };
  }
  return {
    ...rule,
    sources: {
      mode: "denylist",
      sourceIds: visibleIds.filter((id) => !allowedIds.includes(id)),
    },
  };
}

export function copyRuleSources(rule, sourceRule) {
  return {
    ...rule,
    sources: {
      mode: sourceRule.sources.mode,
      sourceIds: uniqueSorted(sourceRule.sources.sourceIds),
    },
  };
}

export function rulesShareSources(state) {
  if (!state?.answer || !state?.direct) return true;
  const answer = state.answer.sources;
  const direct = state.direct.sources;
  return answer.mode === direct.mode &&
    uniqueSorted(answer.sourceIds).join("\u0000") === uniqueSorted(direct.sourceIds).join("\u0000");
}
