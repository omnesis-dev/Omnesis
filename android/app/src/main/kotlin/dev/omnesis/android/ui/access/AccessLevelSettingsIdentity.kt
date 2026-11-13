// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

/** Comparison only: never rewrites a serialized boundary, revision, or advanced rule. */
private data class PolicySettings(val policy: ScopePolicy, val selectors: List<Pair<String, Set<String>>>?)
private fun settings(policy: ScopePolicy): PolicySettings = if (!policy.editable) PolicySettings(policy, null) else
    PolicySettings(policy.copy(rules = emptyList()), policy.rules.map { it.action to it.match.map(::scopeRefKey).toSet() })
private fun settings(policies: List<ScopePolicy>): List<PolicySettings> = policies.map(::settings).sortedBy { it.policy.sourceId }
internal fun sameScopeSettings(first: List<ScopePolicy>, second: List<ScopePolicy>) = settings(first) == settings(second)

private data class GrantSettings(val grant: AccessGrantRule, val sourceIds: Set<String>, val policies: List<PolicySettings>)
private fun settings(rule: AccessGrantRule): GrantSettings = GrantSettings(
    grant = rule.copy(
        sources = AccessSourceBoundary(if (rule.capability != AccessCapability.NOTES && rule.sources.mode == AccessSourceMode.ALL) AccessSourceMode.DENYLIST else rule.sources.mode, emptyList()),
        scopePolicies = emptyList(), filterRevision = rule.filterRevision ?: 0,
    ),
    sourceIds = if (rule.sources.mode == AccessSourceMode.ALL) emptySet() else rule.sources.sourceIds.toSet(),
    policies = settings(rule.scopePolicies),
)
/**
 * Whether a saved Direct reads exactly what Answer reads: the same accounts, the same filters on them and
 * the same choice about new sources. Such a Direct opens linked to Answer.
 */
internal fun directSameAsAnswer(answer: AccessGrantRule, direct: AccessGrantRule): Boolean {
    fun boundary(rule: AccessGrantRule) = settings(rule).let { it.grant.sources.mode to it.sourceIds }
    fun policies(rule: AccessGrantRule) = rule.scopePolicies.map { it.copy(audience = ScopeAudience("", "")) }
    return boundary(answer) == boundary(direct) && sameScopeSettings(policies(answer), policies(direct))
}
internal fun sameGrantSettings(first: List<AccessGrantRule>, second: List<AccessGrantRule>) =
    first.associate { it.capability to settings(it) } == second.associate { it.capability to settings(it) }
