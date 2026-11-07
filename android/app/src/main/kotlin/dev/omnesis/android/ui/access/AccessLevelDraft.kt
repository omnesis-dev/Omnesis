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
    val originalLevel: AccessLevelSummary? = null,
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
    val valid: Boolean get() = name.trim().isNotEmpty() && name.trim().length <= 120 && rules.isNotEmpty() &&
        !(requireAnswerPolicySelection && rule(AccessCapability.ANSWER) != null) && serializedRules.all {
            it.capability == AccessCapability.NOTES || it.sources.mode != AccessSourceMode.ALLOWLIST || it.sources.sourceIds.isNotEmpty()
        }
    fun validFor(overview: AccessOverview): Boolean = valid && nameError(overview) == null && readingCapabilities.all { dataError(it, overview) == null } && releaseValid(overview)
    val readingCapabilities: List<AccessCapability> get() = listOf(AccessCapability.ANSWER, AccessCapability.DIRECT).filter { rule(it) != null }
    fun knownSourceIds(overview: AccessOverview): Set<String> = overview.sources.mapTo(mutableSetOf()) { it.id }.also { ids ->
        rules.forEach { rule -> ids.addAll(rule.sources.sourceIds); ids.addAll(rule.scopePolicies.map { it.sourceId }) }
    }
    fun dataError(capability: AccessCapability, overview: AccessOverview): String? {
        val current = serializedRules.firstOrNull { it.capability == capability } ?: return null
        val known = overview.sources.mapTo(mutableSetOf()) { it.id }
        val selection = AccessSourceSelectionState.from(current.sources, known)
        val saved = (originalLevel ?: overview.levels.firstOrNull { it.id == id })?.rules?.firstOrNull { it.capability == capability }
        return if (selection.permitsAnyKnownSource(known) || (saved != null && saved.sources == current.sources && current.sources.mode == AccessSourceMode.ALLOWLIST && current.sources.sourceIds.isNotEmpty() && current.sources.sourceIds.none(known::contains))) null
        else "Choose at least one source for ${capability.title}."
    }
    fun releaseValid(overview: AccessOverview): Boolean {
        val answer = rule(AccessCapability.ANSWER) ?: return true
        if (requireAnswerPolicySelection) return false
        if (answer.release?.mode == AccessAnswerReleaseMode.UNREVIEWED) return true
        val release = answer.release ?: return false
        val saved = (originalLevel ?: overview.levels.firstOrNull { it.id == id })?.rules?.firstOrNull { it.capability == AccessCapability.ANSWER }?.release
        return overview.policyFamilies.any { it.id == release.policyFamilyId } || (saved != null && saved == release)
    }
    fun setPolicy(policy: ScopePolicy?, sourceId: String, capability: AccessCapability): AccessLevelDraft {
        val rule = rule(capability) ?: return this
        val previous = rule.scopePolicies.firstOrNull { it.sourceId == sourceId }
        if (previous == policy) return this
        val policies = when {
            policy == null -> rule.scopePolicies.filterNot { it.sourceId == sourceId }
            previous != null -> rule.scopePolicies.map { if (it.sourceId == sourceId) policy else it }
            else -> rule.scopePolicies + policy
        }
        return setRule(rule.copy(scopePolicies = policies))
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
                }, level == null, level == null && overview.defaultPolicyFamilyId == null && overview.policyFamilies.isEmpty(), level)
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
