// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const SOURCE_MODES = ["all", "allowlist", "denylist"];
export const CAPABILITIES = ["direct", "answer", "notes"];
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

export function defaultPolicyFamilyId(policies = [], configured = null) {
  if (configured && policies.some((policy) => policyFamilyId(policy) === configured)) {
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

function normalizeSources(rule) {
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
    normalized[rule.capability] = {
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

export function serializeGrantRules(state) {
  return CAPABILITIES.flatMap((capability) => {
    const rule = state?.[capability];
    if (!rule) return [];
    const common = {
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
 * What the capabilities a single source boundary governs are called.
 *
 * A shared boundary is one list standing for two capabilities, so a refusal it
 * earns has to name both — saying only "Direct" in front of a list the owner
 * chose for Answer and Direct together describes a boundary that is not there.
 */
export function sourceScopeName(capability) {
  if (capability === "shared") return "Answer and Direct";
  return capability === "direct" ? "Direct" : "Answer";
}

/**
 * What is wrong with one source boundary, worded for the card that owns it.
 * `scope` names the capabilities that boundary governs; `sources` are the
 * sources the gateway knows, so a boundary that allows none of them is
 * caught however it was reached.
 */
export function sourceBoundaryError(rule, scope, sources = []) {
  if (!rule) return null;
  if (!SOURCE_MODES.includes(rule.sources.mode)) return "Choose how future sources are handled.";
  if (uniqueSorted(rule.sources.sourceIds).length > MAX_SOURCE_IDS) {
    return `${scope} can record at most ${MAX_SOURCE_IDS} source selections.`;
  }
  if (rule.sources.mode === "allowlist" && rule.sources.sourceIds.length === 0) {
    return `Select at least one source for ${scope}.`;
  }
  if (!readsAnySource(rule, sources)) return `${scope} would not be able to read any source.`;
  return null;
}

/**
 * Whether a boundary allows at least one known source. With no source known
 * yet, only an empty allowlist reads nothing, and that has its own message.
 */
export function readsAnySource(rule, sources) {
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
  // One boundary or two. When Answer and Direct hold the same list the owner
  // edits it once, so an empty one is a single fault named for both.
  if (state.answer && state.direct && rulesShareSources(state)) {
    const shared = sourceBoundaryError(state.answer, sourceScopeName("shared"), sources);
    if (shared) return shared;
  } else {
    for (const rule of rules) {
      const error = sourceBoundaryError(state[rule.capability], sourceScopeName(rule.capability), sources);
      if (error) return error;
    }
  }
  return releaseError(state);
}

/** Whether the profile grants anything at all; nothing else means much until it does. */
export const NO_CAPABILITY_MESSAGE = "Select at least one capability.";

export function hasCapability(state) {
  return CAPABILITIES.some((capability) => Boolean(state?.[capability]));
}

export function isSourceAllowed(rule, id) {
  if (rule.sources.mode === "all") return true;
  const listed = rule.sources.sourceIds.includes(id);
  return rule.sources.mode === "allowlist" ? listed : !listed;
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
  const shouldList = rule.sources.mode === "allowlist" ? allowed : !allowed;
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

export function setAllSourcesAllowed(rule, allSourceIds, allowed) {
  const ids = uniqueSorted(allSourceIds);
  if (allowed) {
    return {
      ...rule,
      sources: rule.sources.mode === "denylist"
        ? { mode: "denylist", sourceIds: [] }
        : { mode: rule.sources.mode, sourceIds: rule.sources.mode === "all" ? [] : ids },
    };
  }
  return {
    ...rule,
    // "Block all" must stay blocked when another source is connected later.
    // An empty allowlist also makes the wizard require an intentional next
    // selection instead of approving the surprising "none now, all later"
    // combination.
    sources: { mode: "allowlist", sourceIds: [] },
  };
}
