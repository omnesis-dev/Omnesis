// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import kotlinx.serialization.Serializable
import java.text.Normalizer

/** The id a level carries until the gateway has saved it. */
internal const val NEW_ACCESS_LEVEL_ID = "new"

/** The policy a reviewed Answer starts with: the gateway's default, else the first published one. Null when none is published. */
internal val AccessOverview.startingPolicyId: String? get() = defaultPolicyFamilyId ?: policyFamilies.firstOrNull()?.id

/** The accounts a capability can be given: those whose source is still connected. */
internal val AccessOverview.availableSourceIds: Set<String> get() = sources.filter { it.available }.mapTo(mutableSetOf()) { it.id }

/** The release a reviewed Answer starts with, or an unreviewed placeholder while no policy is published to choose. */
private fun startingRelease(overview: AccessOverview): AccessAnswerRelease = overview.startingPolicyId?.let { AccessAnswerRelease.reviewed(it) } ?: AccessAnswerRelease.unreviewed()

/** An Answer that reads no account yet, released as [startingRelease] says. */
private fun startingAnswer(overview: AccessOverview): AccessGrantRule = AccessGrantRule.answer(AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList()), startingRelease(overview))

/** Every account [rules] can name: each account the overview lists, in its order, then those only the rules still name. */
internal fun accountIds(overview: AccessOverview, rules: List<AccessGrantRule>): List<String> =
    (overview.sources.map { it.id } + rules.flatMap { rule -> rule.sources.sourceIds + rule.scopePolicies.map { it.sourceId } }).distinct()

/**
 * Independent saved capabilities. The saved level records no link: a draft opens with Direct linked to
 * Answer when Direct reads exactly what Answer reads, and a linked draft saves Answer's sources and
 * filters as Direct's own.
 *
 * [removedRules] holds the rule of each permission switched off in this draft, and [separateDirect] the
 * Direct rule that linking Direct to Answer set aside, so reversing either choice restores what was chosen.
 */
@Serializable
data class AccessLevelDraft(
    val id: String, val name: String, val rules: List<AccessGrantRule>,
    val expectedRevision: Int?, val expectedFilterRevisions: Map<String, Int>,
    val directSameAsAnswer: Boolean,
    val requireAnswerPolicySelection: Boolean = false,
    val originalLevel: AccessLevelSummary? = null,
    val removedRules: Map<AccessCapability, AccessGrantRule> = emptyMap(),
    val separateDirect: AccessGrantRule? = null,
) {
    fun rule(capability: AccessCapability) = rules.firstOrNull { it.capability == capability }
    fun setRule(rule: AccessGrantRule) = copy(rules = rules.filterNot { it.capability == rule.capability } + rule)
    fun enabled(capability: AccessCapability, enabled: Boolean, overview: AccessOverview): AccessLevelDraft {
        if (!enabled) {
            val current = rule(capability) ?: return this
            val retained = if (capability == AccessCapability.ANSWER && directSameAsAnswer && rule(AccessCapability.DIRECT) != null)
                copyAnswer().copy(directSameAsAnswer = false) else this
            return retained.copy(rules = retained.rules.filterNot { it.capability == capability }, removedRules = removedRules + (capability to current))
        }
        if (rule(capability) != null) return this
        removedRules[capability]?.let { return setRule(it).copy(removedRules = removedRules - capability) }
        val boundary = AccessSourceBoundary(AccessSourceMode.ALLOWLIST, emptyList())
        // The gateway fences filter edits on the revision the saved level holds for this capability.
        val savedRevision = originalLevel?.rules?.firstOrNull { it.capability == capability }?.filterRevision
        val changed = setRule(when (capability) {
            AccessCapability.NOTES -> AccessGrantRule.notes()
            AccessCapability.DIRECT -> AccessGrantRule.direct(boundary)
            AccessCapability.ANSWER -> startingAnswer(overview)
        }.copy(filterRevision = savedRevision))
        return when (capability) {
            AccessCapability.ANSWER -> changed.copy(requireAnswerPolicySelection = overview.startingPolicyId == null)
            // Beside Answer, a new Direct starts linked to it, so it never reads more than Answer does until its own list is chosen.
            AccessCapability.DIRECT -> if (rule(AccessCapability.ANSWER) != null && changed.canCopyAnswer(overview.sourceFilters?.enabled)) changed.copy(directSameAsAnswer = true, separateDirect = null) else changed
            AccessCapability.NOTES -> changed
        }
    }
    fun canCopyAnswer(authoringEnabled: Boolean?): Boolean = authoringEnabled == true ||
        (rule(AccessCapability.ANSWER)?.scopePolicies.isNullOrEmpty() && rule(AccessCapability.DIRECT)?.scopePolicies.isNullOrEmpty())
    /** While filters cannot be authored, a boundary may not drop an account that has one: selecting the account again could not bring the filter back. */
    fun canSetBoundary(boundary: AccessSourceBoundary, capability: AccessCapability, authoringEnabled: Boolean?): Boolean =
        authoringEnabled == true || rule(capability)?.scopePolicies.orEmpty().all { sourceAllowed(boundary, it.sourceId) }
    /** A deselected source keeps its filter in the draft, so selecting it again brings the filter back; [serializedRules] leaves it out. */
    fun setBoundary(boundary: AccessSourceBoundary, capability: AccessCapability, authoringEnabled: Boolean?): AccessLevelDraft {
        val previous = rule(capability) ?: return this
        if (!canSetBoundary(boundary, capability, authoringEnabled)) return this
        return setRule(previous.copy(sources = boundary))
    }
    fun copyAnswer(authoringEnabled: Boolean? = true): AccessLevelDraft {
        if (!canCopyAnswer(authoringEnabled)) return this
        val answer = rule(AccessCapability.ANSWER) ?: return this
        val direct = rule(AccessCapability.DIRECT) ?: return this
        return setRule(direct.copy(sources = answer.sources, scopePolicies = answer.scopePolicies.map {
            it.copy(audience = ScopeAudience(id, AccessCapability.DIRECT.wire))
        }))
    }
    fun withDirectSameAsAnswer(linked: Boolean, authoringEnabled: Boolean? = true): AccessLevelDraft = when {
        linked == directSameAsAnswer -> this
        linked -> if (canCopyAnswer(authoringEnabled)) copy(directSameAsAnswer = true, separateDirect = rule(AccessCapability.DIRECT)) else this
        else -> (separateDirect?.takeIf { rule(AccessCapability.DIRECT) != null }?.let(::setRule) ?: copyAnswer()).copy(directSameAsAnswer = false, separateDirect = null)
    }
    /** What saving sends: a linked Direct as a copy of Answer, and no filter for an account its capability does not read. */
    val serializedRules: List<AccessGrantRule> get() = (if (directSameAsAnswer) copyAnswer().rules else rules).map { rule ->
        val applied = rule.copy(scopePolicies = rule.scopePolicies.filter { sourceAllowed(rule.sources, it.sourceId) })
        if (applied.scopePolicies.isNotEmpty() && applied.filterRevision == null) applied.copy(filterRevision = 0) else applied
    }
    /** Whether the level can be saved as it stands: [pageError] of the review finds nothing to correct. */
    fun validFor(overview: AccessOverview): Boolean = pageError(AccessLevelPage.REVIEW, overview) == null
    val readingCapabilities: List<AccessCapability> get() = listOf(AccessCapability.ANSWER, AccessCapability.DIRECT).filter { rule(it) != null }
    fun knownSourceIds(overview: AccessOverview): Set<String> = accountIds(overview, rules).toSet()
    /**
     * Why [capability] cannot be saved with the accounts chosen for it, or null when it can. It must read at least one
     * connected account, and its boundary can name at most [MAX_ACCESS_SOURCE_IDS] accounts. A saved list whose accounts
     * have all been disconnected stays valid until it is changed.
     */
    fun dataError(capability: AccessCapability, overview: AccessOverview): String? {
        val current = serializedRules.firstOrNull { it.capability == capability } ?: return null
        val available = overview.availableSourceIds
        val saved = savedLevel(overview)?.rules?.firstOrNull { it.capability == capability }
        val keptAsSaved = saved != null && saved.sources == current.sources && current.sources.mode == AccessSourceMode.ALLOWLIST &&
            current.sources.sourceIds.isNotEmpty() && current.sources.sourceIds.none(available::contains)
        return when {
            current.sources.sourceIds.size > MAX_ACCESS_SOURCE_IDS -> tooManySourcesMessage(capability)
            AccessSourceSelectionState.from(current.sources, available).permitsAnyKnownSource(available) || keptAsSaved -> null
            else -> noSourceMessage(capability)
        }
    }
    fun releaseValid(overview: AccessOverview): Boolean {
        val answer = rule(AccessCapability.ANSWER) ?: return true
        if (requireAnswerPolicySelection) return false
        if (answer.release?.mode == AccessAnswerReleaseMode.UNREVIEWED) return true
        val release = answer.release ?: return false
        val saved = savedLevel(overview)?.rules?.firstOrNull { it.capability == AccessCapability.ANSWER }?.release
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
        /** The draft that edits [level], or the draft of a new level: Answer alone, reading no account yet. */
        fun opening(level: AccessLevelSummary?, overview: AccessOverview): AccessLevelDraft {
            val rules = level?.rules ?: listOf(startingAnswer(overview))
            val linked = level == null || directLinkedIn(rules)
            return AccessLevelDraft(level?.id ?: NEW_ACCESS_LEVEL_ID, level?.name.orEmpty(), rules, level?.revision,
                rules.filter { it.capability != AccessCapability.NOTES }.associate { it.capability.wire to (it.filterRevision ?: 0) },
                linked, level == null && overview.startingPolicyId == null, level)
        }

        /**
         * The draft of a new level that starts as a copy of [rules]: their sources, and their filters addressed to the new
         * level. A reviewed Answer whose policy is no longer published starts with the policy a new Answer would, because
         * a new level can only be reviewed by a published policy.
         */
        fun copying(rules: List<AccessGrantRule>, overview: AccessOverview): AccessLevelDraft {
            val unpublished = rules.any { rule -> rule.release?.mode == AccessAnswerReleaseMode.REVIEWED && overview.policyFamilies.none { it.id == rule.release?.policyFamilyId } }
            val copied = rules.map { rule ->
                rule.copy(
                    release = if (unpublished && rule.release != null) startingRelease(overview) else rule.release, filterRevision = null,
                    scopePolicies = rule.scopePolicies.map { it.copy(audience = ScopeAudience(NEW_ACCESS_LEVEL_ID, rule.capability.wire)) },
                )
            }
            return AccessLevelDraft(NEW_ACCESS_LEVEL_ID, "", copied, expectedRevision = null, expectedFilterRevisions = emptyMap(),
                directSameAsAnswer = copied.none { it.capability == AccessCapability.DIRECT } || directLinkedIn(copied),
                requireAnswerPolicySelection = unpublished && overview.startingPolicyId == null)
        }
    }
}

/**
 * The identifier for an address typed by hand, or null when the text names no address of that type. It reads every way
 * of writing an address the gateway reads (separators, a leading 00, a tel: or mailto: prefix, a display name, capitals)
 * into the gateway's spelling, so the item is recognised as already selected and lines up with the counts the gateway
 * returns for it. The gateway stays the authority on what it saves.
 */
fun scopeTypedIdentifier(value: String, type: String): ScopeIdentifier? {
    if (value.length > 512) return null
    val text = Normalizer.normalize(value, Normalizer.Form.NFKC).trim { it.isWhitespace() }
    val typed = when (type) {
        "phone" -> typedPhone(text)
        "email" -> typedEmail(text)
        "domain" -> typedDomain(text)
        else -> null
    }
    return typed?.let { ScopeIdentifier(type, it) }
}

private const val SPACE = "\\s\\p{Z}"
private fun hostName(value: String) = value.lowercase().replace(Regex("\\.+$"), "")

private fun typedPhone(text: String): String? {
    // "+44 (0)20 …" does not say whether the zero is dialled, so it names no single number.
    if (Regex("\\([$SPACE]*0[$SPACE]*\\)").containsMatchIn(text)) return null
    var value = text.replace(Regex("^tel:", RegexOption.IGNORE_CASE), "")
        .replace(Regex("[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]"), "-")
        .replace(Regex("[$SPACE().-]"), "")
    if (Regex("^00[1-9]").containsMatchIn(value)) value = "+" + value.drop(2)
    return value.takeIf { Regex("^\\+[1-9][0-9]{6,14}$").matches(it) }
}

private fun typedEmail(text: String): String? {
    val inner = Regex("<([^<>]*)>$").find(text)?.groupValues?.get(1) ?: text
    val value = hostName(inner.trim { it.isWhitespace() }.replace(Regex("^mailto:", RegexOption.IGNORE_CASE), ""))
    val part = "[^$SPACE@<>]+"
    return value.takeIf { it.length <= 320 && Regex("^$part@$part\\.$part$").matches(it) }
}

private fun typedDomain(text: String): String? {
    val value = hostName(text.removePrefix("@"))
    // A host name written in another script is left for the gateway to judge.
    val pattern = if (value.all { it.code < 128 }) "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"
        else "^[^$SPACE@/:*.]+(?:\\.[^$SPACE@/:*.]+)+$"
    return value.takeIf { it.length <= 253 && Regex(pattern).matches(it) }
}
