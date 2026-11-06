// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

fun scopeBoundaryPreservesFilters(boundary: AccessSourceBoundary, policies: List<ScopePolicy>, authoringEnabled: Boolean?): Boolean =
    authoringEnabled == true || policies.all { policy -> when (boundary.mode) {
        AccessSourceMode.ALL -> true
        AccessSourceMode.ALLOWLIST -> policy.sourceId in boundary.sourceIds
        AccessSourceMode.DENYLIST -> policy.sourceId !in boundary.sourceIds
    } }

/** Independent saved capabilities; linking is confined to a new level's unsaved draft. */
data class AccessLevelDraft(
    val id: String, val name: String, val rules: List<AccessGrantRule>,
    val expectedRevision: Int?, val expectedFilterRevisions: Map<String, Int>,
    val directSameAsAnswer: Boolean,
    val requireAnswerPolicySelection: Boolean = false,
) {
    fun rule(capability: AccessCapability) = rules.firstOrNull { it.capability == capability }
    fun setRule(rule: AccessGrantRule) = copy(rules = rules.filterNot { it.capability == rule.capability } + rule)
    fun enabled(capability: AccessCapability, enabled: Boolean, overview: AccessOverview): AccessLevelDraft {
        if (!enabled) {
            val retained = if (capability == AccessCapability.ANSWER && directSameAsAnswer && rule(AccessCapability.DIRECT) != null)
                copyAnswer().copy(directSameAsAnswer = false) else this
            return retained.copy(rules = retained.rules.filterNot { it.capability == capability })
        }
        if (rule(capability) != null) return this
        val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList())
        val changed = setRule(when (capability) {
            AccessCapability.NOTES -> AccessGrantRule.notes()
            AccessCapability.DIRECT -> AccessGrantRule.direct(boundary)
            AccessCapability.ANSWER -> AccessGrantRule.answer(boundary, (overview.defaultPolicyFamilyId ?: overview.policyFamilies.firstOrNull()?.id)?.let {
                AccessAnswerRelease.reviewed(it)
            } ?: AccessAnswerRelease.unreviewed())
        })
        return if (capability == AccessCapability.ANSWER) changed.copy(requireAnswerPolicySelection = overview.defaultPolicyFamilyId == null && overview.policyFamilies.isEmpty()) else changed
    }
    fun canCopyAnswer(authoringEnabled: Boolean?): Boolean = authoringEnabled == true ||
        (rule(AccessCapability.ANSWER)?.scopePolicies.isNullOrEmpty() && rule(AccessCapability.DIRECT)?.scopePolicies.isNullOrEmpty())
    fun canSetBoundary(boundary: AccessSourceBoundary, capability: AccessCapability, authoringEnabled: Boolean?): Boolean =
        scopeBoundaryPreservesFilters(boundary, rule(capability)?.scopePolicies.orEmpty(), authoringEnabled)
    fun setBoundary(boundary: AccessSourceBoundary, capability: AccessCapability, authoringEnabled: Boolean?): AccessLevelDraft {
        val previous = rule(capability) ?: return this
        if (!canSetBoundary(boundary, capability, authoringEnabled)) return this
        return setRule(previous.copy(sources = boundary, scopePolicies = previous.scopePolicies.filter {
            scopeBoundaryPreservesFilters(boundary, listOf(it), false)
        }))
    }
    fun copyAnswer(authoringEnabled: Boolean? = true): AccessLevelDraft {
        if (!canCopyAnswer(authoringEnabled)) return this
        val answer = rule(AccessCapability.ANSWER) ?: return this
        val direct = rule(AccessCapability.DIRECT) ?: return this
        return setRule(direct.copy(sources = answer.sources, scopePolicies = answer.scopePolicies.map {
            it.copy(audience = ScopeAudience(id, "direct"))
        }))
    }
    fun withDirectSameAsAnswer(linked: Boolean, authoringEnabled: Boolean? = true): AccessLevelDraft =
        if (linked && !canCopyAnswer(authoringEnabled)) this else
            (if (!linked && directSameAsAnswer) copyAnswer() else this).copy(directSameAsAnswer = linked)
    val serializedRules: List<AccessGrantRule> get() = (if (directSameAsAnswer) copyAnswer().rules else rules).map {
        if (it.scopePolicies.isNotEmpty() && it.filterRevision == null) it.copy(filterRevision = 0) else it
    }
    val valid: Boolean get() = name.trim().isNotEmpty() && name.length <= 120 && rules.isNotEmpty() && !(requireAnswerPolicySelection && rule(AccessCapability.ANSWER) != null)
    fun setPolicy(policy: ScopePolicy?, sourceId: String, capability: AccessCapability): AccessLevelDraft {
        val rule = rule(capability) ?: return this
        return setRule(rule.copy(scopePolicies = rule.scopePolicies.filterNot { it.sourceId == sourceId } + listOfNotNull(policy)))
    }
    companion object {
        fun opening(level: AccessLevelSummary?, overview: AccessOverview): AccessLevelDraft {
            val rules = level?.rules ?: listOf(AccessGrantRule.answer(
                AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()),
                (overview.defaultPolicyFamilyId ?: overview.policyFamilies.firstOrNull()?.id)?.let { AccessAnswerRelease.reviewed(it) } ?: AccessAnswerRelease.unreviewed(),
            ))
            return AccessLevelDraft(level?.id ?: "new", level?.name.orEmpty(), rules, level?.revision,
                rules.filter { it.capability != AccessCapability.NOTES }.associate {
                    it.capability.name.lowercase() to (it.filterRevision ?: 0)
                }, level == null, level == null && overview.defaultPolicyFamilyId == null && overview.policyFamilies.isEmpty())
        }
    }
}

fun scopeTypedIdentifier(value: String, type: String): ScopeIdentifier? {
    val normalized = if (type == "phone") value.trim().replace(Regex("[\\s().-]"), "") else value.trim().lowercase()
    val pattern = when(type) {
        "phone" -> "^\\+[1-9][0-9]{6,14}$"
        "domain" -> "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$"
        "email" -> "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
        else -> return null
    }
    return normalized.takeIf { Regex(pattern).matches(it) }?.let { ScopeIdentifier(type, it) }
}
