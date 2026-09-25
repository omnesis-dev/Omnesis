// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessConnectionLevel
import dev.omnesis.android.transport.dto.AccessConnectionProposal
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessGrantSummary
import dev.omnesis.android.transport.dto.AccessLevelSummary
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.MAX_ACCESS_NAME_LENGTH
import dev.omnesis.android.ui.common.TimeFormat

/**
 * Where an approved connection's permissions come from: a level this approval creates, a
 * level that already exists, or the connection a new sign-in takes over.
 */
enum class AccessConnectionPath { NEW_LEVEL, EXISTING_LEVEL, REPLACE }

/** One live connection, as the replace list shows it. */
data class AccessConnectionTarget(
    val id: String,
    val name: String,
    val grant: AccessGrantSummary,
    /** The latest use of any of its sign-ins, or null when none has been used. */
    val lastUsedAt: Long?,
)

/** Every connection: a live interactive principal with its one live grant. */
private fun connections(overview: AccessOverview): List<AccessConnectionTarget> =
    overview.principals
        .filter { it.revokedAt == null && it.kind == "interactive" }
        .mapNotNull { principal ->
            val grant = principal.grants.firstOrNull { it.revokedAt == null } ?: return@mapNotNull null
            AccessConnectionTarget(
                id = principal.id,
                name = principal.name,
                grant = grant,
                lastUsedAt = grant.credentials.mapNotNull { it.lastUsedAt }.maxOrNull(),
            )
        }

/**
 * The connections a new sign-in can take over at [nowMillis]: those whose grant has not
 * expired, most recently used first and never-used ones last, ties broken by name regardless
 * of case.
 */
internal fun liveConnections(overview: AccessOverview, nowMillis: Long): List<AccessConnectionTarget> =
    connections(overview)
        .filter { (it.grant.expiresAt ?: Long.MAX_VALUE) > nowMillis }
        .sortedWith(
            compareByDescending<AccessConnectionTarget> { it.lastUsedAt ?: Long.MIN_VALUE }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name },
        )

/**
 * Why a set of existing permissions cannot serve this request, or null when it can. An agent
 * bound to this phone's execution requires Answer, and the gateway refuses permissions
 * without it.
 */
internal fun unavailableReason(rules: List<AccessGrantRule>, request: AccessAuthorizationRequest): String? =
    if (request.requiresAnswer && rules.none { it.capability == AccessCapability.ANSWER }) {
        "This agent needs Answer."
    } else {
        null
    }

/** The refusal a new access level's name earns when a live level already has it. */
internal const val LEVEL_NAME_TAKEN_MESSAGE = "An access level with that name already exists."

internal fun connectionCountLabel(count: Int): String = when (count) {
    0 -> "No connections"
    1 -> "1 connection"
    else -> "$count connections"
}

internal fun lastUsedLabel(lastUsedAt: Long?, nowMillis: Long): String =
    lastUsedAt?.let { "Last used ${TimeFormat.relative(it, nowMillis)}" } ?: "Never used"

/**
 * The review's warning that the approved connection shares its level with [others] live
 * connections, or null when it shares it with none.
 */
internal fun sharedLevelFootnote(others: Int): String? = when {
    others < 1 -> null
    else -> "Also used by $others other connection${if (others == 1) "" else "s"}. " +
        "Changing this access level later changes all of them."
}

/**
 * The Connection step's answers.
 *
 * [levelId] names the existing level the new connection uses, or is null while "New access
 * level" is chosen. [replacing] switches the step to picking a connection to take over, and
 * [connectionId] is the one picked; the other answers are kept for a return to normal mode.
 */
data class AccessConnectionChoice(
    val proposal: AccessConnectionProposal,
    val name: String,
    val levelName: String,
    val levelId: String? = null,
    val replacing: Boolean = false,
    val connectionId: String? = null,
) {
    val path: AccessConnectionPath
        get() = when {
            replacing -> AccessConnectionPath.REPLACE
            levelId != null -> AccessConnectionPath.EXISTING_LEVEL
            else -> AccessConnectionPath.NEW_LEVEL
        }

    val nameError: String? get() = if (name.isBlank()) "Enter a name for this connection." else null

    /**
     * Why the new level's name cannot be used: it is empty, or it is already the name of a live
     * level in [overview], compared trimmed and regardless of case as the gateway compares it.
     * The gateway's own `level-name-taken` refusal covers a level created since [overview] was read.
     */
    fun levelNameError(overview: AccessOverview): String? {
        val trimmed = levelName.trim()
        return when {
            trimmed.isEmpty() -> "Enter a name for this access level."
            overview.levels.any { it.name.trim().equals(trimmed, ignoreCase = true) } -> LEVEL_NAME_TAKEN_MESSAGE
            else -> null
        }
    }

    /**
     * The connection the gateway suggests replacing, because this agent is already connected
     * as it on this device, while it is still offered in the replace list at [nowMillis]. The
     * list marks it whichever connection is picked.
     */
    fun suggestedConnection(overview: AccessOverview, nowMillis: Long): AccessConnectionTarget? {
        val match = proposal.match?.takeIf { proposal.recommended == "replace" } ?: return null
        return liveConnections(overview, nowMillis).firstOrNull { it.id == match.connectionId }
    }

    /** The live level the matched connection uses, which the list tags and offers first. */
    fun suggestedLevel(overview: AccessOverview): AccessLevelSummary? =
        proposal.match?.levelId?.let { id -> overview.levels.firstOrNull { it.id == id } }

    /** The live levels in the order offered: the suggested one first, then the rest by name. */
    fun orderedLevels(overview: AccessOverview): List<AccessLevelSummary> {
        val suggested = suggestedLevel(overview)
        return listOfNotNull(suggested) + overview.levels
            .filter { it.id != suggested?.id }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

    fun level(overview: AccessOverview): AccessLevelSummary? = overview.levels.firstOrNull { it.id == levelId }

    /**
     * The connection picked for replacement. It is looked up without the expiry filter the list
     * applies, so the decision does not change with the clock; the gateway refuses a grant
     * that has expired since.
     */
    fun target(overview: AccessOverview): AccessConnectionTarget? =
        connections(overview).firstOrNull { it.id == connectionId }

    /** Whether the Connection step's own questions are answered well enough to move on. */
    fun canContinue(request: AccessAuthorizationRequest, overview: AccessOverview): Boolean = when (path) {
        AccessConnectionPath.NEW_LEVEL -> nameError == null && levelNameError(overview) == null
        AccessConnectionPath.EXISTING_LEVEL ->
            nameError == null && level(overview)?.let { unavailableReason(it.rules, request) == null } == true
        AccessConnectionPath.REPLACE ->
            target(overview)?.let { unavailableReason(it.grant.rules, request) == null } == true
    }

    /** The decision this choice describes, with [form] holding a new level's permissions. */
    fun selection(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
        form: AccessAuthorizationForm,
    ): AccessAuthorizationSelection? {
        if (!canContinue(request, overview)) return null
        return when (path) {
            AccessConnectionPath.NEW_LEVEL -> AccessAuthorizationSelection.NewConnection(
                name = name.trim(),
                level = AccessConnectionLevel.New(
                    name = levelName.trim(),
                    rules = form.ownRules(request, overview) ?: return null,
                ),
            )
            AccessConnectionPath.EXISTING_LEVEL -> requireNotNull(level(overview)).let {
                AccessAuthorizationSelection.NewConnection(
                    name = name.trim(),
                    level = AccessConnectionLevel.Existing(it.id, it.revision),
                )
            }
            AccessConnectionPath.REPLACE -> requireNotNull(target(overview)).let {
                AccessAuthorizationSelection.ReplaceConnection(it.id, it.grant.revision)
            }
        }
    }

    companion object {
        /**
         * The step as the gateway's proposal opens it at [nowMillis]. A recommended connection
         * or level is preselected only while it is still live and can serve this request;
         * anything else opens on a new access level.
         */
        fun initial(
            request: AccessAuthorizationRequest,
            overview: AccessOverview,
            proposal: AccessConnectionProposal,
            nowMillis: Long,
        ): AccessConnectionChoice {
            val base = AccessConnectionChoice(
                proposal = proposal,
                name = utf16Prefix(proposal.defaultName.trim(), MAX_ACCESS_NAME_LENGTH),
                levelName = utf16Prefix(
                    proposal.defaultLevelName.trim().ifEmpty { request.clientName.trim() },
                    MAX_ACCESS_NAME_LENGTH,
                ),
            )
            val match = proposal.match ?: return base
            when (proposal.recommended) {
                "replace" -> liveConnections(overview, nowMillis)
                    .firstOrNull { it.id == match.connectionId }
                    ?.takeIf { unavailableReason(it.grant.rules, request) == null }
                    ?.let { return base.copy(replacing = true, connectionId = it.id) }
                "existing-level" -> base.suggestedLevel(overview)
                    ?.takeIf { unavailableReason(it.rules, request) == null }
                    ?.let { return base.copy(levelId = it.id) }
            }
            return base
        }
    }
}

/**
 * What the Review step states: the connection, its access level, what it replaces, and the
 * permissions it gets as a form, so every path is reviewed with the same rows.
 *
 * [accessLevel] and [replaces] are null when their row is not shown. [otherConnections] is how
 * many live connections other than this one use the same level.
 */
internal data class AccessReviewSummary(
    val connectionName: String,
    val accessLevel: String?,
    val replaces: String?,
    val permissions: AccessAuthorizationForm,
    val otherConnections: Int,
)

/**
 * The review of [form]'s decision. A gateway that predates connections has no level to name,
 * and its connection is the one it reconnects the client to, or else the client itself.
 */
internal fun reviewSummary(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    form: AccessAuthorizationForm,
    legacyConnectionName: String? = null,
): AccessReviewSummary {
    val choice = form.connection ?: return AccessReviewSummary(
        connectionName = legacyConnectionName ?: request.clientName,
        accessLevel = null,
        replaces = null,
        permissions = form,
        otherConnections = 0,
    )
    return when (choice.path) {
        AccessConnectionPath.NEW_LEVEL -> AccessReviewSummary(
            connectionName = choice.name.trim(),
            accessLevel = "${choice.levelName.trim()} (new)",
            replaces = null,
            permissions = form,
            otherConnections = 0,
        )
        AccessConnectionPath.EXISTING_LEVEL -> {
            val level = choice.level(overview)
            AccessReviewSummary(
                connectionName = choice.name.trim(),
                accessLevel = level?.name,
                replaces = null,
                permissions = level?.let { AccessAuthorizationForm.describing(it.rules, overview, publishedPolicyOnly = false) }
                    ?: form,
                otherConnections = level?.connectionCount ?: 0,
            )
        }
        AccessConnectionPath.REPLACE -> {
            val target = choice.target(overview)
            val level = target?.grant?.levelId?.let { id -> overview.levels.firstOrNull { it.id == id } }
            AccessReviewSummary(
                connectionName = target?.name.orEmpty(),
                accessLevel = level?.name,
                replaces = target?.let { "The current sign-in of ${it.name}" },
                permissions = target?.let {
                    AccessAuthorizationForm.describing(it.grant.rules, overview, publishedPolicyOnly = false)
                } ?: form,
                // The replaced connection is one of the level's own connections.
                otherConnections = ((level?.connectionCount ?: 1) - 1).coerceAtLeast(0),
            )
        }
    }
}
