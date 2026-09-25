// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One operator-visible merge rule. Mirrors `MergeRuleWithResolved` in the
 * gateway (`packages/gateway/src/domain/merge/types.ts`) and the iOS
 * `MergeRule`. A rule records that one pre-merge identity (`sideA`) and
 * another (`sideB`) name the same person; `winnerSide` is the survivor and
 * the other side is the loser. With `resolve`+`details`+`preMerge` the
 * gateway fills `resolvedSideA` / `resolvedSideB` with the pre-merge people
 * each side carried.
 */
@Serializable
data class MergeRule(
    val id: String,
    /** `system` (auto-detected) or `user` (operator-issued). */
    val kind: String = "user",
    val sideA: MergeRuleSide = MergeRuleSide(),
    val sideB: MergeRuleSide = MergeRuleSide(),
    /** `a` or `b` — which side survives the merge. */
    val winnerSide: String = "a",
    val reason: String? = null,
    val createdAt: String? = null,
    /**
     * Correlation id shared by all rules from one cluster-merge action;
     * null for single-pair and auto-detected rules.
     */
    val groupId: String? = null,
    val resolvedSideA: List<MergeRulePerson>? = null,
    val resolvedSideB: List<MergeRulePerson>? = null,
)

/** One alias side of a merge rule — the (aliasType, alias) tuple it was keyed on. */
@Serializable
data class MergeRuleSide(
    val aliasType: String = "",
    val alias: String = "",
)

/**
 * A person one side of a merge rule currently resolves to (pre-merge view).
 * Mirrors `ResolvedSidePerson` in the gateway. The optional fields are
 * filled only when the rule list is fetched with `details`.
 */
@Serializable
data class MergeRulePerson(
    val id: String,
    val canonicalName: String = "",
    val aliases: List<MergeRuleSide>? = null,
    val sourceIds: List<String>? = null,
    /** When this row is the merged loser, the canonical's display name. */
    val mergedIntoCanonicalName: String? = null,
)

/** `GET /people/merge-rules` envelope — `{ rules: [...] }`. */
@Serializable
data class MergeRulesResponse(
    val rules: List<MergeRule> = emptyList(),
)

/** One complete surviving-identity card from `/people/merge-rule-groups`. */
@Serializable
data class MergeRuleGroup(
    val key: String,
    val person: MergeRulePerson? = null,
    val name: String = "",
    val canonicalEmail: String? = null,
    val sourceIds: List<String> = emptyList(),
    val kinds: List<String> = emptyList(),
    val ruleIds: List<String> = emptyList(),
    val groupIds: List<String> = emptyList(),
    val latest: String? = null,
    val sources: List<MergeRuleGroupSource> = emptyList(),
)

@Serializable
data class MergeRuleGroupSource(
    val ruleId: String,
    val groupId: String? = null,
    val alias: String = "",
    val aliasType: String = "",
    val name: String? = null,
    val personId: String? = null,
    val sourceIds: List<String> = emptyList(),
    @SerialName("when") val when_: String? = null,
    val reason: String? = null,
)
