// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*

enum class AccessLevelPage { OVERVIEW, NAME, PERMISSIONS, ANSWER_DATA, DIRECT_CHOICE, DIRECT_DATA, FUTURE, RELEASE, REVIEW }
/** The three capabilities in the order every list states them, so a capability keeps its place wherever they are listed. */
internal val ACCESS_CAPABILITIES = listOf(AccessCapability.ANSWER, AccessCapability.DIRECT, AccessCapability.NOTES)
/** A capability as an audience and a filter revision name it: "answer". */
internal val AccessCapability.wire: String get() = name.lowercase()
/** The title of the capability a wire name stands for. */
internal fun capabilityTitle(wire: String): String = ACCESS_CAPABILITIES.firstOrNull { it.wire == wire }?.title ?: wire
internal val AccessCapability.title: String get() = when (this) {
    AccessCapability.ANSWER -> "Answer"
    AccessCapability.DIRECT -> "Direct"
    AccessCapability.NOTES -> "Notes"
}
internal val AccessCapability.explanation: String get() = when (this) {
    AccessCapability.ANSWER -> "Ask questions to the Omnesis agent using allowed sources. A privacy policy can review every answer before it is released."
    AccessCapability.DIRECT -> "Search and read raw matching records from allowed sources."
    AccessCapability.NOTES -> "Save notes with Tell Omnesis. The agent’s name is recorded with each note. This does not grant access to read existing notes."
}
/** What allowing the capability gives up, said beside its explanation. */
internal val AccessCapability.warning: String? get() = if (this == AccessCapability.DIRECT) "Direct is not protected by a privacy policy." else null
/**
 * The steps of a new level. Direct is one step: beside Answer it first asks whether to use Answer's
 * sources ([AccessLevelPage.DIRECT_CHOICE]), and lists Direct's own accounts on the same screen when not.
 */
internal fun AccessLevelDraft.createPages(): List<AccessLevelPage> = buildList {
    add(AccessLevelPage.PERMISSIONS)
    if (rule(AccessCapability.ANSWER) != null) add(AccessLevelPage.ANSWER_DATA)
    if (rule(AccessCapability.DIRECT) != null) add(if (rule(AccessCapability.ANSWER) != null) AccessLevelPage.DIRECT_CHOICE else AccessLevelPage.DIRECT_DATA)
    if (readingCapabilities.isNotEmpty()) add(AccessLevelPage.FUTURE)
    if (rule(AccessCapability.ANSWER) != null) add(AccessLevelPage.RELEASE)
    add(AccessLevelPage.REVIEW)
}
internal fun AccessLevelPage.capability(): AccessCapability? = when (this) {
    AccessLevelPage.ANSWER_DATA -> AccessCapability.ANSWER
    AccessLevelPage.DIRECT_DATA, AccessLevelPage.DIRECT_CHOICE -> AccessCapability.DIRECT
    else -> null
}
/** The question a step asks. One title serves Direct whether its accounts are edited alone or chosen beside Answer. */
internal fun AccessLevelPage.question(creating: Boolean): String = when (this) {
    AccessLevelPage.OVERVIEW -> "What would you like to change?"
    AccessLevelPage.NAME -> "What should this access level be called?"
    AccessLevelPage.PERMISSIONS -> "What should this connection be allowed to do?"
    AccessLevelPage.ANSWER_DATA -> "Which sources can Answer use?"
    AccessLevelPage.DIRECT_CHOICE, AccessLevelPage.DIRECT_DATA -> "Which sources can Direct read?"
    AccessLevelPage.FUTURE -> "What about new sources?"
    AccessLevelPage.RELEASE -> "How should answers be released?"
    AccessLevelPage.REVIEW -> if (creating) "Ready to create this access level?" else "Review your changes"
}
internal val AccessLevelPage.subtitle: String? get() = when (this) {
    AccessLevelPage.DIRECT_CHOICE, AccessLevelPage.DIRECT_DATA -> "Direct mode allows the agent to read allowed raw records directly without Answer’s privacy review."
    else -> null
}
internal const val NO_PERMISSION_MESSAGE = "Choose at least one permission."
internal fun noSourceMessage(capability: AccessCapability): String = "Select at least one source for ${capability.title}."
/** What a capability whose boundary names more accounts than the gateway accepts says, whether it lists the allowed accounts or the blocked ones. */
internal fun tooManySourcesMessage(capability: AccessCapability): String = "${capability.title} can record at most $MAX_ACCESS_SOURCE_IDS source selections."

/** Why a step cannot be left as it stands, or null when it can. The review states the first thing any step would. */
internal fun AccessLevelDraft.pageError(page: AccessLevelPage, overview: AccessOverview): String? = when (page) {
    AccessLevelPage.NAME -> nameError(overview)
    AccessLevelPage.PERMISSIONS -> NO_PERMISSION_MESSAGE.takeIf { rules.isEmpty() }
    AccessLevelPage.ANSWER_DATA -> dataError(AccessCapability.ANSWER, overview)
    AccessLevelPage.DIRECT_DATA, AccessLevelPage.DIRECT_CHOICE -> dataError(AccessCapability.DIRECT, overview)
    AccessLevelPage.RELEASE -> if (releaseValid(overview)) null else "Choose a published privacy policy, or choose automatic release."
    AccessLevelPage.REVIEW -> NO_PERMISSION_MESSAGE.takeIf { rules.isEmpty() } ?: nameError(overview) ?: permissionsError(overview)
    else -> null
}
/** Why the level's permissions cannot be saved, whatever its name; null when they can. */
internal fun AccessLevelDraft.permissionsError(overview: AccessOverview): String? = NO_PERMISSION_MESSAGE.takeIf { rules.isEmpty() }
    ?: readingCapabilities.firstNotNullOfOrNull { dataError(it, overview) }
    ?: "Review the Answer release choice.".takeIf { !releaseValid(overview) }
/** What a step that chooses accounts says under its list while the choice cannot be saved. */
internal fun AccessLevelDraft.accountsNote(page: AccessLevelPage, overview: AccessOverview): String? = page.capability()?.let { dataError(it, overview) }
internal fun AccessLevelDraft.isChangedFrom(level: AccessLevelSummary?): Boolean = level == null || name.trim() != level.name || !sameGrantSettings(serializedRules, level.rules)
internal fun sourceAllowed(boundary: AccessSourceBoundary, id: String): Boolean = when (boundary.mode) {
    AccessSourceMode.ALL -> true
    AccessSourceMode.ALLOWLIST -> id in boundary.sourceIds
    AccessSourceMode.DENYLIST -> id !in boundary.sourceIds
}
/** The accounts a search shows; a blank search shows every account. */
internal fun visibleAccounts(sources: List<AccessSourceInstance>, query: String): List<AccessSourceInstance> =
    query.trim().let { search -> sources.filter { search.isEmpty() || it.name.contains(search, true) || it.id.contains(search, true) } }
/** A bulk choice reaches only the [visible] accounts. An unavailable account can be cleared, never selected. */
internal fun AccessSourceSelectionState.settingAll(visible: List<AccessSourceInstance>, allowed: Boolean): AccessSourceSelectionState =
    visible.filter { (it.available || !allowed) && allows(it.id) != allowed }.fold(this) { value, source -> value.setAllowed(source.id, allowed) }
internal fun AccessSourceInstance.accountLabel(displayName: String = name): String? {
    val account = id.substringAfter(':', "").takeIf { it.isNotBlank() } ?: return null
    fun normalized(value: String) = value.filter(Char::isLetterOrDigit).lowercase()
    if (normalized(displayName).contains(normalized(account))) return null
    val friendly = name.takeIf { it.startsWith(displayName) }?.removePrefix(displayName)?.trim(' ', '·', ':', '—', '-', '(', ')')
    return friendly?.takeIf { it.isNotBlank() } ?: account
}
internal fun scopeKindTitle(kind: String, source: AccessSourceInstance): String = source.scopes?.items?.firstOrNull { it.kind == kind }?.noun?.many?.replaceFirstChar { it.uppercase() }
    ?: if (kind == "participant") "People" else kind.replaceFirstChar { it.uppercase() }
/** An account's content under one capability, in a line. */
internal fun scopePolicySummary(policy: ScopePolicy?): String {
    if (policy == null) return ALL_CONTENT
    if (!policy.editable) return SAVED_FILTER
    val refs = policy.rules.single().match
    if (refs.isEmpty()) return if (policy.otherwise == "share") ALL_CONTENT else "No matching content"
    return "${if (policy.rules.single().action == "share") "Only" else "Except"} ${refs.size} selected ${if (refs.size == 1) "match" else "matches"}"
}
/** What a filter does with its matches, as a short pill label. */
internal fun scopePolicyActionLabel(policy: ScopePolicy): String = when (policy.rules.singleOrNull()?.action.takeIf { policy.editable }) {
    "share" -> "Share matching content"
    "hide" -> "Hide matching content"
    else -> SAVED_FILTER
}
/** What an account without a filter shares. */
internal const val ALL_CONTENT = "All content"
/** What stands for a saved filter this editor cannot express. */
internal const val SAVED_FILTER = "Saved filter"
/** What a saved item is shown by when its name cannot be loaded: "Saved conversation selection". */
internal fun savedSelectionName(kind: String, source: AccessSourceInstance): String = "Saved ${scopeKindCaption(kind, source).lowercase()} selection"
/** The line under a saved item that is shown without its name. */
internal const val NAME_UNAVAILABLE = "Name unavailable"
/**
 * What a source calls an item [depth] levels down a kind's tree. A source that names its levels has a word for each,
 * the last standing for every deeper level; null for any other source and for an item whose depth is not known.
 */
internal fun scopeLevelNoun(kind: String, source: AccessSourceInstance, depth: Int?): SourceScopeNoun? {
    val levels = source.scopes?.items?.firstOrNull { it.kind == kind }?.levels?.takeIf { it.isNotEmpty() } ?: return null
    return depth?.takeIf { it >= 0 }?.let { levels[minOf(it, levels.lastIndex)] }
}
/** The singular type of a selected item ("Conversation", "Person", "Label", "Folder"), by its level where the source names the levels of a tree. */
internal fun scopeKindCaption(kind: String, source: AccessSourceInstance, depth: Int? = null): String =
    (scopeLevelNoun(kind, source, depth)?.one ?: source.scopes?.items?.firstOrNull { it.kind == kind }?.noun?.one)?.replaceFirstChar { it.uppercase() }
        ?: if (kind == "participant") "Person" else kind.replaceFirstChar { it.uppercase() }
/** The top of a kind's tree, in the source's word for its first level: "All folders". */
internal fun scopeTreeRootLabel(kind: String, source: AccessSourceInstance): String =
    "All ${(scopeLevelNoun(kind, source, 0)?.many ?: scopeKindTitle(kind, source)).lowercase()}"
/** The tone of the pill that states an account's content: neutral for all of it, accent for a share filter, danger for a hide filter. */
internal fun scopePolicyTone(policy: ScopePolicy?): AccessPillTone = when {
    policy == null || !policy.editable || policy.rules.single().match.isEmpty() -> AccessPillTone.NEUTRAL
    policy.rules.single().action == "share" -> AccessPillTone.ACCENT
    else -> AccessPillTone.DANGER
}
internal fun ruleDataSummary(rule: AccessGrantRule, overview: AccessOverview): String {
    val chosen = accountIds(overview, listOf(rule)).count { sourceAllowed(rule.sources, it) }
    val filtered = rule.scopePolicies.count { sourceAllowed(rule.sources, it.sourceId) }
    return "$chosen ${if (chosen == 1) "account" else "accounts"} selected" + if (filtered > 0) " · $filtered filtered" else if (chosen > 0) " · all content" else ""
}
internal fun newSourcesSummary(boundary: AccessSourceBoundary): String = if (boundary.mode.admitsNewSources) "Automatic" else "Blocked"
internal fun releaseSummary(rule: AccessGrantRule?, overview: AccessOverview): String = when {
    rule == null -> NOT_GRANTED
    rule.release?.mode == AccessAnswerReleaseMode.UNREVIEWED -> "No privacy review"
    else -> "Privacy review · ${overview.policyFamilies.firstOrNull { it.id == rule.release?.policyFamilyId }?.name ?: "Saved policy unavailable"}"
}
internal const val DIRECT_SAME_AS_ANSWER_LABEL = "Use same sources and filters as Answer mode"
internal const val DIRECT_OWN_LIST_LABEL = "Choose different sources"
/** What the Direct data screen says while Direct is linked to Answer. */
internal const val DIRECT_LINKED_NOTE = "Uses the same sources and filters as Answer mode."

/** Which of Answer, Direct and Notes a level allows, as its capability pills show them. */
internal data class AccessCapabilityHoldings(val answer: Boolean, val direct: Boolean, val notes: Boolean) {
    fun holds(capability: AccessCapability): Boolean = when (capability) {
        AccessCapability.ANSWER -> answer
        AccessCapability.DIRECT -> direct
        AccessCapability.NOTES -> notes
    }
    /** What the pills read out as one: "Answer and Direct allowed, Notes not allowed". */
    val description: String get() {
        fun names(capabilities: List<AccessCapability>) = capabilities.map { it.title }.let { if (it.size < 2) it.joinToString() else it.dropLast(1).joinToString() + " and " + it.last() }
        val (allowed, withheld) = ACCESS_CAPABILITIES.partition { holds(it) }
        return listOfNotNull(
            names(allowed).takeIf { allowed.isNotEmpty() }?.let { "$it allowed" },
            names(withheld).takeIf { withheld.isNotEmpty() }?.let { "$it not allowed" },
        ).joinToString(", ")
    }
    companion object {
        fun of(rules: List<AccessGrantRule>): AccessCapabilityHoldings = AccessCapabilityHoldings(
            rules.any { it.capability == AccessCapability.ANSWER }, rules.any { it.capability == AccessCapability.DIRECT }, rules.any { it.capability == AccessCapability.NOTES })
    }
}

/**
 * One decision of an access level, with what it holds in a line or two. A decision of [capabilities] is shown as
 * their pills, and its [value] is what the pills read out.
 */
internal data class AccessDecision(val page: AccessLevelPage, val title: String, val value: String, val capabilities: AccessCapabilityHoldings? = null)

/**
 * Every decision a set of rules holds, in the order the level page lists them. [linked] is a level whose
 * Direct uses Answer's sources, which states that once and not as a second list.
 */
internal fun levelDecisions(name: String, rules: List<AccessGrantRule>, overview: AccessOverview, linked: Boolean = false): List<AccessDecision> = buildList {
    add(AccessDecision(AccessLevelPage.NAME, "Name", name))
    val holdings = AccessCapabilityHoldings.of(rules)
    add(AccessDecision(AccessLevelPage.PERMISSIONS, "Permissions", holdings.description, holdings))
    val answer = rules.firstOrNull { it.capability == AccessCapability.ANSWER }
    val direct = rules.firstOrNull { it.capability == AccessCapability.DIRECT }
    answer?.let { add(AccessDecision(AccessLevelPage.ANSWER_DATA, "Answer data", ruleDataSummary(it, overview))) }
    direct?.let { add(AccessDecision(AccessLevelPage.DIRECT_DATA, "Direct data", if (linked) "Same sources and filters as Answer" else ruleDataSummary(it, overview))) }
    val reading = listOfNotNull(answer, direct)
    if (reading.isNotEmpty()) add(AccessDecision(AccessLevelPage.FUTURE, "New sources",
        if (linked) "Answer and Direct: ${newSourcesSummary(reading.first().sources)}" else reading.joinToString("\n") { "${it.capability.title}: ${newSourcesSummary(it.sources)}" }))
    answer?.let { add(AccessDecision(AccessLevelPage.RELEASE, "Answer release", releaseSummary(it, overview))) }
}

/** Whether the draft's Direct uses Answer's sources and filters, now and after later edits of Answer. */
internal val AccessLevelDraft.directLinked: Boolean get() = directSameAsAnswer && rule(AccessCapability.ANSWER) != null && rule(AccessCapability.DIRECT) != null

/** One decision an edit changed, with what it held before and holds after; a change of permissions also as their pills. */
internal data class AccessLevelChange(
    val page: AccessLevelPage, val title: String, val before: String, val after: String,
    val beforeCapabilities: AccessCapabilityHoldings? = null, val afterCapabilities: AccessCapabilityHoldings? = null,
)

/** The level as saved when this draft opened it; null for a new level. */
internal fun AccessLevelDraft.savedLevel(overview: AccessOverview): AccessLevelSummary? = originalLevel ?: overview.levels.firstOrNull { it.id == id }

/** Whether a set of rules gives Direct exactly Answer's sources and filters, so a level page states them once. */
internal fun directLinkedIn(rules: List<AccessGrantRule>): Boolean {
    val answer = rules.firstOrNull { it.capability == AccessCapability.ANSWER } ?: return false
    val direct = rules.firstOrNull { it.capability == AccessCapability.DIRECT } ?: return false
    return directSameAsAnswer(answer, direct)
}

/** One account whose share of a capability an edit changes. */
internal data class AccountChange(val sourceId: String, val before: AccountShare, val after: AccountShare)

/**
 * The accounts whose share of [capability] the draft changes: connected accounts in the overview's order,
 * then accounts only the rules still name. An account that neither side reads is unchanged, whether the
 * capability is off or the account is not selected.
 */
internal fun AccessLevelDraft.changedAccounts(capability: AccessCapability, overview: AccessOverview): List<AccountChange> {
    val old = savedLevel(overview)?.rules?.firstOrNull { it.capability == capability }
    val new = serializedRules.firstOrNull { it.capability == capability }
    return accountIds(overview, listOfNotNull(old, new)).map { AccountChange(it, AccountShare.of(old, it), AccountShare.of(new, it)) }.filterNot { it.before.sameAs(it.after) }
}

/**
 * The decisions an edit changed, in the level page's order. A data decision changed when an account's
 * share changed, the release when the saved release did, and any other when its value did. A decision the edit
 * removes or adds reads "Not granted" on the side that lacks it. Values are compared as saved and stated as the level
 * page states them.
 */
internal fun AccessLevelDraft.changes(overview: AccessOverview): List<AccessLevelChange> {
    val previous = savedLevel(overview) ?: return emptyList()
    val before = levelDecisions(previous.name, previous.rules, overview)
    val after = levelDecisions(name.trim(), serializedRules, overview)
    val stated = levelDecisions(previous.name, previous.rules, overview, directLinkedIn(previous.rules)) to levelDecisions(name.trim(), serializedRules, overview, directLinked)
    return (before + after).map { it.page }.distinct().sortedBy { it.ordinal }.mapNotNull { page ->
        // Two policies can share a name, so the release is compared as saved and not as stated.
        val changed = page.capability()?.let { changedAccounts(it, overview).isNotEmpty() }
            ?: if (page == AccessLevelPage.RELEASE) previous.rules.firstOrNull { it.capability == AccessCapability.ANSWER }?.release != rule(AccessCapability.ANSWER)?.release
            else before.firstOrNull { it.page == page }?.value != after.firstOrNull { it.page == page }?.value
        if (!changed) return@mapNotNull null
        val old = stated.first.firstOrNull { it.page == page }
        val new = stated.second.firstOrNull { it.page == page }
        AccessLevelChange(page, (new ?: old)!!.title, old?.value ?: NOT_GRANTED, new?.value ?: NOT_GRANTED, old?.capabilities, new?.capabilities)
    }
}

/**
 * The decisions the saved level held and the edit leaves as they were, as the rows of a review's "Unchanged"
 * block, stated as the level page states them. A decision a newly granted capability brings is never unchanged.
 */
internal fun AccessLevelDraft.unchangedDecisions(overview: AccessOverview): List<AccessDecision> {
    val changed = changes(overview).mapTo(mutableSetOf()) { it.page }
    val held = savedLevel(overview)?.let { level -> levelDecisions(level.name, level.rules, overview).mapTo(mutableSetOf()) { it.page } }
    return levelDecisions(name.trim(), serializedRules, overview, directLinked).filter { it.page !in changed && (held == null || it.page in held) }
}

internal const val ACCESS_LEVEL_NAME_LABEL = "Access level name"
internal const val NO_LEVEL_NAME_MESSAGE = "Enter a name for this access level."
/** What a connection or access level name longer than the gateway accepts says. */
internal const val NAME_TOO_LONG_MESSAGE = "Use at most $MAX_ACCESS_NAME_LENGTH characters."
/** What a level name another live level already has says, whether this app or the gateway noticed. */
internal const val LEVEL_NAME_TAKEN_MESSAGE = "An access level already uses this name. Choose another."

/**
 * Why the level's name cannot be used: it is empty, longer than the gateway accepts, or already the name of another
 * live level in [overview], compared trimmed and regardless of case as the gateway compares it. The gateway's own
 * `level-name-taken` refusal covers a level created since [overview] was read.
 */
internal fun AccessLevelDraft.nameError(overview: AccessOverview): String? = when {
    name.isBlank() -> NO_LEVEL_NAME_MESSAGE
    name.trim().length > MAX_ACCESS_NAME_LENGTH -> NAME_TOO_LONG_MESSAGE
    overview.levels.any { it.id != id && it.name.trim().equals(name.trim(), ignoreCase = true) } -> LEVEL_NAME_TAKEN_MESSAGE
    else -> null
}

/**
 * Who uses an access level. The counts are the gateway's; [connections] names the live connections the
 * overview lists on the level, and [integrations] the paired devices that ask it for answers.
 */
internal data class AccessLevelUsers(val connectionCount: Int, val connections: List<String>, val integrations: List<String>) {
    val integrationCount: Int get() = integrations.size
    val inUse: Boolean get() = connectionCount > 0 || integrationCount > 0
    /** What must happen before the level can be deleted; null when nothing uses it. */
    val deletionBlocker: String? get() = when {
        !inUse -> null
        integrationCount == 0 -> "Move or remove its connections first."
        connectionCount == 0 -> "Move its integrations to another access level first."
        else -> ACCESS_LEVEL_IN_USE_HINT
    }
}
internal fun AccessLevelSummary.users(overview: AccessOverview): AccessLevelUsers = AccessLevelUsers(
    connectionCount,
    overview.principals.filter { it.revokedAt == null }.flatMap { principal ->
        principal.grants.filter { it.revokedAt == null && it.levelId == id }.map { principal.name }
    }.sortedWith(String.CASE_INSENSITIVE_ORDER),
    devices.map { it.name },
)
