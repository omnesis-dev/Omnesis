// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

internal enum class AccessLevelPage { OVERVIEW, PERMISSIONS, ANSWER_DATA, DIRECT_CHOICE, DIRECT_DATA, FUTURE, RELEASE, REVIEW }
internal val AccessCapability.title: String get() = when (this) {
    AccessCapability.ANSWER -> "Answer"
    AccessCapability.DIRECT -> "Direct"
    AccessCapability.NOTES -> "Notes"
}
internal val AccessCapability.outcome: String get() = when (this) {
    AccessCapability.ANSWER -> "Ask Omnesis questions"
    AccessCapability.DIRECT -> "Read original records"
    AccessCapability.NOTES -> "Save new notes"
}
internal val AccessCapability.explanation: String get() = when (this) {
    AccessCapability.ANSWER -> "Omnesis answers using the data you choose."
    AccessCapability.DIRECT -> "Search and read the original data, without Answer’s privacy review."
    AccessCapability.NOTES -> "Create new notes. This does not allow reading existing notes."
}
internal fun AccessLevelDraft.createPages(): List<AccessLevelPage> = buildList {
    add(AccessLevelPage.PERMISSIONS)
    if (rule(AccessCapability.ANSWER) != null) add(AccessLevelPage.ANSWER_DATA)
    if (rule(AccessCapability.DIRECT) != null) {
        if (rule(AccessCapability.ANSWER) != null) add(AccessLevelPage.DIRECT_CHOICE)
        if (rule(AccessCapability.ANSWER) == null || !directSameAsAnswer) add(AccessLevelPage.DIRECT_DATA)
    }
    if (readingCapabilities.isNotEmpty()) add(AccessLevelPage.FUTURE)
    if (rule(AccessCapability.ANSWER) != null) add(AccessLevelPage.RELEASE)
    add(AccessLevelPage.REVIEW)
}
internal fun AccessLevelPage.capability(): AccessCapability? = when (this) {
    AccessLevelPage.ANSWER_DATA -> AccessCapability.ANSWER
    AccessLevelPage.DIRECT_DATA -> AccessCapability.DIRECT
    else -> null
}
internal fun AccessLevelDraft.pageError(page: AccessLevelPage, overview: AccessOverview): String? = when (page) {
    AccessLevelPage.PERMISSIONS -> if (rules.isEmpty()) "Choose what this access level may do." else null
    AccessLevelPage.ANSWER_DATA -> dataError(AccessCapability.ANSWER, overview)
    AccessLevelPage.DIRECT_DATA -> dataError(AccessCapability.DIRECT, overview)
    AccessLevelPage.RELEASE -> if (releaseValid(overview)) null else "Choose a published privacy policy, or choose automatic release."
    AccessLevelPage.REVIEW -> when {
        rules.isEmpty() -> "Choose what this access level may do."
        nameError(overview) != null -> nameError(overview)
        else -> readingCapabilities.firstNotNullOfOrNull { dataError(it, overview) } ?: if (releaseValid(overview)) null else "Review the Answer release choice."
    }
    else -> null
}
internal fun AccessLevelDraft.isChangedFrom(level: AccessLevelSummary?): Boolean = level == null || name.trim() != level.name || serializedRules.associateBy { it.capability } != level.rules.associateBy { it.capability }
internal fun sourceAllowed(boundary: AccessSourceBoundary, id: String): Boolean = when (boundary.mode) {
    AccessSourceMode.ALL -> true
    AccessSourceMode.ALLOWLIST -> id in boundary.sourceIds
    AccessSourceMode.DENYLIST -> id !in boundary.sourceIds
}
internal fun futureAllowed(boundary: AccessSourceBoundary): Boolean = boundary.mode != AccessSourceMode.ALLOWLIST
internal fun AccessSourceInstance.accountLabel(displayName: String = name): String? {
    val account = id.substringAfter(':', "").takeIf { it.isNotBlank() } ?: return null
    fun normalized(value: String) = value.filter(Char::isLetterOrDigit).lowercase()
    if (normalized(displayName).contains(normalized(account))) return null
    val friendly = name.takeIf { it.startsWith(displayName) }?.removePrefix(displayName)?.trim(' ', '·', ':', '—', '-', '(', ')')
    return friendly?.takeIf { it.isNotBlank() } ?: account
}
internal fun scopeKindTitle(kind: String, source: AccessSourceInstance): String = source.scopes?.items?.firstOrNull { it.kind == kind }?.noun?.many?.replaceFirstChar { it.uppercase() }
    ?: if (kind == "participant") "People" else kind.replaceFirstChar { it.uppercase() }
internal fun scopePolicySummary(policy: ScopePolicy?, source: AccessSourceInstance): String {
    if (policy == null) return "All content"
    if (!policy.editable) return "Saved restriction · advanced settings"
    val refs = policy.rules.single().match
    if (refs.isEmpty()) return if (policy.otherwise == "share") "All content" else "No matching content"
    val names = refs.map { scopeKindTitle(it.kind, source).lowercase() }.distinct().joinToString(" and ")
    return "${if (policy.rules.single().action == "share") "Only selected" else "All except selected"} $names · ${refs.size}"
}
internal fun ruleDataSummary(rule: AccessGrantRule, overview: AccessOverview): String {
    val chosen = (overview.sources.map { it.id } + rule.sources.sourceIds + rule.scopePolicies.map { it.sourceId }).distinct().count { sourceAllowed(rule.sources, it) }
    val restrictions = rule.scopePolicies.size
    return "$chosen ${if (chosen == 1) "source" else "sources"}${if (restrictions > 0) " · $restrictions restricted" else " · all content"}"
}
internal fun releaseSummary(rule: AccessGrantRule?, overview: AccessOverview): String = when {
    rule == null -> "Answer is not enabled"
    rule.release?.mode == AccessAnswerReleaseMode.UNREVIEWED -> "Automatic release · no privacy review"
    else -> "Privacy review · ${overview.policyFamilies.firstOrNull { it.id == rule.release?.policyFamilyId }?.name ?: "Saved policy unavailable"}"
}
internal data class AccessLevelChange(val title: String, val before: String, val after: String)
internal fun AccessLevelDraft.changes(overview: AccessOverview): List<AccessLevelChange> {
    val previous = originalLevel ?: overview.levels.firstOrNull { it.id == id } ?: return emptyList()
    return buildList {
        if (name.trim() != previous.name) add(AccessLevelChange("Name", previous.name, name.trim()))
        fun capabilityList(items: List<AccessGrantRule>) = listOf(AccessCapability.ANSWER, AccessCapability.DIRECT, AccessCapability.NOTES)
            .filter { cap -> items.any { it.capability == cap } }.joinToString { it.outcome }.ifEmpty { "None" }
        if (rules.map { it.capability }.toSet() != previous.rules.map { it.capability }.toSet()) add(AccessLevelChange("Permissions", capabilityList(previous.rules), capabilityList(rules)))
        listOf(AccessCapability.ANSWER, AccessCapability.DIRECT).forEach { cap ->
            val before = previous.rules.firstOrNull { it.capability == cap }
            val after = serializedRules.firstOrNull { it.capability == cap }
            val known = knownSourceIds(overview)
            val beforeIds = before?.let { AccessSourceSelectionState.from(it.sources, known).allowedSourceIds }
            val afterIds = after?.let { AccessSourceSelectionState.from(it.sources, known).allowedSourceIds }
            if (beforeIds != afterIds || before?.scopePolicies != after?.scopePolicies) {
                fun detail(rule: AccessGrantRule) = ruleDataSummary(rule, overview)
                add(AccessLevelChange("${cap.title} data", before?.let(::detail) ?: "Not allowed", after?.let(::detail) ?: "Not allowed"))
            }
            if (after != null && (before == null || futureAllowed(before.sources) != futureAllowed(after.sources))) add(AccessLevelChange("New sources for ${cap.title}", if (before == null) "Not allowed" else if (futureAllowed(before.sources)) "Allowed automatically" else "Blocked until allowed", if (futureAllowed(after.sources)) "Allowed automatically" else "Blocked until allowed"))
        }
        val beforeAnswer = previous.rules.firstOrNull { it.capability == AccessCapability.ANSWER }
        val afterAnswer = rule(AccessCapability.ANSWER)
        if (beforeAnswer?.release != afterAnswer?.release) add(AccessLevelChange("Answer release", releaseSummary(beforeAnswer, overview), releaseSummary(afterAnswer, overview)))
    }
}

internal fun AccessLevelDraft.nameError(overview: AccessOverview): String? = when {
    name.trim().isEmpty() -> "Give this access level a name."
    name.trim().length > 120 -> "Use a name of 120 characters or fewer."
    overview.levels.any { it.id != id && it.name.trim().equals(name.trim(), ignoreCase = true) } -> "An access level already uses this name. Choose another."
    else -> null
}
