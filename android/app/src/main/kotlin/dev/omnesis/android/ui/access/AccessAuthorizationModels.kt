// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AccessAnswerRelease
import dev.omnesis.android.transport.dto.AccessAnswerReleaseMode
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessConnectionProposal
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessReconnectProposal
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceMode
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

/**
 * The three capabilities, always in this order.
 *
 * A capability keeps its slot wherever capabilities are listed, so "which of these reads raw
 * records" is answered by position rather than by reading every label.
 */
enum class AccessCapabilitySlot(val label: String) { ANSWER("Answer"), DIRECT("Direct"), NOTES("Notes") }

/**
 * How one capability is coloured. A capability has one colour everywhere it appears, and a
 * granted capability is never the withheld grey — grey would read as the one capability this
 * connection does not hold.
 *
 * Unreviewed answer release is [WARNING], never [RAW]: danger belongs to Direct alone, and two
 * dangers on one row means neither is read as one.
 */
enum class AccessCapabilityTone { REVIEWED, RAW, WRITE, WARNING, WITHHELD }

/**
 * The tone one capability carries, given whether it is granted and — for Answer — whether its
 * answers are released without a privacy review.
 */
fun capabilityTone(
    capability: AccessCapabilitySlot,
    granted: Boolean,
    unreviewed: Boolean = false,
): AccessCapabilityTone = when {
    !granted -> AccessCapabilityTone.WITHHELD
    capability == AccessCapabilitySlot.ANSWER && unreviewed -> AccessCapabilityTone.WARNING
    capability == AccessCapabilitySlot.ANSWER -> AccessCapabilityTone.REVIEWED
    capability == AccessCapabilitySlot.DIRECT -> AccessCapabilityTone.RAW
    else -> AccessCapabilityTone.WRITE
}

/**
 * The capabilities one source list governs. A shared list stands for two capabilities, so a
 * refusal it earns has to name both: "Select at least one source for Direct" in front of a list
 * the owner chose for Answer and Direct together describes a boundary that is not there.
 */
enum class AccessSourceScope(val label: String) {
    ANSWER("Answer"),
    DIRECT("Direct"),
    SHARED("Answer and Direct"),
}
enum class AccessAnswerReleaseChoice { REVIEWED, UNREVIEWED }
enum class AccessAuthorizationStep(val title: String, val shortTitle: String) {
    CONNECTION("Connection", "Connection"),
    PERMISSIONS("Permissions", "Permissions"),

    /**
     * The short form is what still fits when the steps share one narrow phone
     * width. The full title stays the accessible name and the step's own
     * heading, so nothing is lost by shortening the chip.
     */
    DATA("Data & privacy", "Data"),
    REVIEW("Review", "Review"),
}

/**
 * The steps this request actually asks for.
 *
 * A gateway that proposes connections opens on the Connection step. An existing access level
 * or a replaced connection brings its permissions with it, so those two paths go straight to
 * Review; only a new access level asks for permissions. Data & privacy asks which sources a capability may read and how its answers are
 * released; a grant that only writes notes has neither question, so the step is skipped
 * rather than shown empty. iOS and the portal derive the same lists; they must agree,
 * because the step chips show the reader a number per step.
 */
internal fun authorizationSteps(
    form: AccessAuthorizationForm,
    requiresAnswer: Boolean,
): List<AccessAuthorizationStep> {
    val connection = form.connection
    if (connection != null && connection.path != AccessConnectionPath.NEW_LEVEL) {
        return listOf(AccessAuthorizationStep.CONNECTION, AccessAuthorizationStep.REVIEW)
    }
    val readsSources = form.directEnabled || form.answerEnabled || requiresAnswer
    val permissions = if (readsSources) {
        listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.DATA, AccessAuthorizationStep.REVIEW)
    } else {
        listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.REVIEW)
    }
    return if (connection == null) permissions else listOf(AccessAuthorizationStep.CONNECTION) + permissions
}

/**
 * What to say when an access call failed for a reason nothing else named.
 *
 * A single "try again" tells the owner nothing about whether the phone is off
 * the network, cannot see the gateway, does not trust it, or is talking to a
 * gateway too new to understand — and those need four different actions. The
 * transport wraps the underlying failure in [GatewayException.Network], so the
 * cause is what carries the answer. iOS classifies `URLError` into the same
 * sentences; the two must stay worded alike.
 */
internal fun accessAuthorizationUnmappedMessage(error: Throwable): String {
    val cause = (error as? GatewayException.Network)?.cause ?: error
    return when {
        cause is SSLException || cause is CertificateException ->
            "The connection to your gateway is not trusted. Re-pair this phone from Settings."
        cause is UnknownHostException || cause is ConnectException ||
            cause is SocketTimeoutException || cause is NoRouteToHostException ->
            "Could not reach your Omnesis gateway. Check that this phone is on the same " +
                "network as it, then try again."
        error is GatewayException.Network ->
            "Could not reach your Omnesis gateway (${cause.javaClass.simpleName}). Try again."
        error is GatewayException.Decoding || error is GatewayException.InvalidResponse ->
            "This gateway replied in a form this app version cannot read. Update Omnesis on " +
                "both, then try again."
        error is GatewayException.ServerError ->
            "The gateway refused the request (HTTP ${error.status}). Try again."
        else -> null
    } ?: "The authorization request could not be loaded or updated. Try again."
}

internal const val MAX_ACCESS_SOURCE_IDS = 256

internal fun utf16Prefix(value: String, maxLength: Int): String {
    if (value.length <= maxLength) return value
    val prefix = value.take(maxLength)
    return if (prefix.lastOrNull()?.isHighSurrogate() == true) prefix.dropLast(1) else prefix
}

internal fun authorizationDeadlineText(expiresAt: Long, nowMillis: Long): String {
    val remaining = expiresAt - nowMillis
    if (remaining <= 0) return "This request has expired."
    val minutes = ((remaining + 59_999) / 60_000).coerceAtLeast(1)
    return "Expires in $minutes minute${if (minutes == 1L) "" else "s"}."
}

/** Checked rows always mean allowed, independent of the compact wire representation. */
data class AccessSourceSelectionState(
    val mode: AccessSourceMode = AccessSourceMode.ALLOWLIST,
    val allowedSourceIds: Set<String> = emptySet(),
    val unavailableReferencedIds: Set<String> = emptySet(),
    val explicitlyDeniedIds: Set<String> = emptySet(),
) {
    fun setMode(next: AccessSourceMode, known: Set<String>): AccessSourceSelectionState = when (next) {
        AccessSourceMode.ALL -> copy(
            mode = next,
            allowedSourceIds = allowedSourceIds + known,
            explicitlyDeniedIds = explicitlyDeniedIds - known,
        )
        AccessSourceMode.ALLOWLIST -> copy(mode = next)
        AccessSourceMode.DENYLIST -> copy(
            mode = next,
            explicitlyDeniedIds = (known - allowedSourceIds) + unavailableReferencedIds,
        )
    }

    /**
     * Uncheck a source under "all sources" and the boundary becomes a denylist naming it: the
     * row is the control, so a checkbox that clears itself and changes nothing would be a lie.
     */
    fun setAllowed(sourceId: String, allowed: Boolean): AccessSourceSelectionState = if (allowed) {
        copy(
            allowedSourceIds = allowedSourceIds + sourceId,
            explicitlyDeniedIds = explicitlyDeniedIds - sourceId,
            unavailableReferencedIds = unavailableReferencedIds - sourceId,
        )
    } else if (mode == AccessSourceMode.ALL) {
        copy(
            mode = AccessSourceMode.DENYLIST,
            allowedSourceIds = allowedSourceIds - sourceId,
            explicitlyDeniedIds = explicitlyDeniedIds + sourceId,
        )
    } else {
        copy(
            allowedSourceIds = allowedSourceIds - sourceId,
            explicitlyDeniedIds = if (mode == AccessSourceMode.DENYLIST) {
                explicitlyDeniedIds + sourceId
            } else {
                explicitlyDeniedIds
            },
        )
    }

    /** Whether a source connected after this decision inherits the access. */
    val futureSourcesAllowed: Boolean get() = mode != AccessSourceMode.ALLOWLIST

    /**
     * Change only whether sources connected later inherit the access, never which of the
     * sources on screen are allowed.
     */
    fun setFutureSourcesAllowed(allowed: Boolean, known: Set<String>): AccessSourceSelectionState = when {
        !allowed -> setMode(AccessSourceMode.ALLOWLIST, known)
        known.all(allowedSourceIds::contains) -> copy(
            mode = AccessSourceMode.ALL,
            explicitlyDeniedIds = explicitlyDeniedIds - known,
        )
        else -> setMode(AccessSourceMode.DENYLIST, known)
    }

    fun allowAll(known: Set<String>) = copy(
        allowedSourceIds = allowedSourceIds + known,
        explicitlyDeniedIds = explicitlyDeniedIds - known,
        unavailableReferencedIds = unavailableReferencedIds - known,
    )

    /**
     * Blocking everything must stay blocked when a source is connected later. It also makes the
     * wizard require a deliberate next selection instead of approving the surprising
     * "none now, all later" combination.
     */
    fun blockAll(known: Set<String>) = copy(
        mode = AccessSourceMode.ALLOWLIST,
        allowedSourceIds = allowedSourceIds - known,
        explicitlyDeniedIds = emptySet(),
    )

    /** Whether two boundaries describe the same access, and so can be edited as one list. */
    fun sameAccessAs(other: AccessSourceSelectionState): Boolean =
        mode == other.mode && allowedSourceIds == other.allowedSourceIds

    /** Whether one source is allowed under this boundary, the way its checkbox reads. */
    fun allows(sourceId: String): Boolean =
        mode == AccessSourceMode.ALL || sourceId in allowedSourceIds

    fun permitsAnyKnownSource(known: Set<String>): Boolean = when (mode) {
        AccessSourceMode.ALL -> known.isNotEmpty()
        AccessSourceMode.ALLOWLIST, AccessSourceMode.DENYLIST -> allowedSourceIds.any(known::contains)
    }

    fun boundary(known: Set<String>): AccessSourceBoundary {
        val ids = when (mode) {
            AccessSourceMode.ALL -> emptySet()
            AccessSourceMode.ALLOWLIST -> allowedSourceIds
            AccessSourceMode.DENYLIST -> explicitlyDeniedIds + unavailableReferencedIds
        }
        return AccessSourceBoundary(mode, ids.sorted())
    }

    companion object {
        fun from(boundary: AccessSourceBoundary, known: Set<String>): AccessSourceSelectionState {
            val referenced = boundary.sourceIds.toSet()
            return AccessSourceSelectionState(
                mode = boundary.mode,
                allowedSourceIds = when (boundary.mode) {
                    AccessSourceMode.ALL -> known
                    AccessSourceMode.ALLOWLIST -> referenced
                    AccessSourceMode.DENYLIST -> known - referenced
                },
                unavailableReferencedIds = referenced - known,
                explicitlyDeniedIds = if (boundary.mode == AccessSourceMode.DENYLIST) referenced else emptySet(),
            )
        }
    }
}

/** What a capability badge reads out: the word, then whether this connection holds it. */
internal fun capabilityBadgeDescription(
    capability: AccessCapabilitySlot,
    granted: Boolean,
    unreviewed: Boolean = false,
): String = buildString {
    append(capability.label)
    append(if (granted) " granted" else " not granted")
    if (granted && unreviewed) append(", released without privacy review")
}

/**
 * One source list, as the review states it: the whole corpus, how many sources are kept in,
 * or how many are kept out. A list that lets newly connected sources in is described by what
 * it blocks, so a count never stands for an open boundary. iOS and the portal word it the
 * same way.
 */
internal fun sourceSummary(selection: AccessSourceSelectionState, overview: AccessOverview): String {
    val available = overview.sources.filter { it.available }.mapTo(mutableSetOf()) { it.id }
    return when (selection.mode) {
        AccessSourceMode.ALL -> "All sources"
        AccessSourceMode.ALLOWLIST -> {
            val count = selection.allowedSourceIds.count(available::contains)
            "$count selected source${if (count == 1) "" else "s"}"
        }
        AccessSourceMode.DENYLIST -> {
            val blocked = available.count { it !in selection.allowedSourceIds }
            if (blocked == 0) "All sources" else "All except $blocked blocked"
        }
    }
}

/**
 * What is wrong with one source list, worded for the list that owns it and named for every
 * capability that list governs. The refusal belongs beside the checkboxes that fix it, not at
 * the foot of the step.
 */
internal fun sourceBoundaryError(
    state: AccessSourceSelectionState,
    known: Set<String>,
    scope: AccessSourceScope,
): String? = when {
    known.isEmpty() -> "No sources are connected. Connect a source before approving this access."
    state.boundary(known).sourceIds.size > MAX_ACCESS_SOURCE_IDS ->
        "${scope.label} can record at most $MAX_ACCESS_SOURCE_IDS source selections."
    !state.permitsAnyKnownSource(known) -> "Select at least one source for ${scope.label}."
    else -> null
}

data class AccessAuthorizationForm(
    val answerEnabled: Boolean = true,
    val directEnabled: Boolean = false,
    val notesEnabled: Boolean = false,
    val answerSources: AccessSourceSelectionState = AccessSourceSelectionState(),
    val directSources: AccessSourceSelectionState = AccessSourceSelectionState(),
    val answerRelease: AccessAnswerReleaseChoice = AccessAnswerReleaseChoice.REVIEWED,
    val policyFamilyId: String = "",
    /** Whether one source list stands for both Answer and Direct. */
    val linkedSources: Boolean = true,
    /**
     * The Connection step's answers, or null on a gateway that predates connections, where
     * the wizard opens on Permissions and approves with a `connect` selection.
     */
    val connection: AccessConnectionChoice? = null,
) {
    /**
     * The list Direct actually uses. While the two are linked there is one list, and deriving it
     * here rather than mirroring every edit into [directSources] means the two cannot drift.
     */
    fun directBoundary(answerOn: Boolean): AccessSourceSelectionState =
        if (linkedSources && answerOn) answerSources else directSources

    /**
     * Split the two lists, or join them. Unlinking materializes the shared list as Direct's own,
     * so the two editors that appear next start from the boundary that was in force.
     */
    fun withLinkedSources(linked: Boolean, answerOn: Boolean): AccessAuthorizationForm =
        if (linked) copy(linkedSources = true) else copy(linkedSources = false, directSources = directBoundary(answerOn))

    /**
     * Decide, as the second reading capability is switched on, whether one list can stand for
     * both. It can only if the two already agree — otherwise a boundary chosen for one
     * capability would silently become the other's.
     */
    fun relinkSources(answerOn: Boolean, directOn: Boolean): AccessAuthorizationForm =
        if (answerOn && directOn) copy(linkedSources = answerSources.sameAccessAs(directSources)) else this

    /**
     * The source lists the review states, one row each, in the order the Data & privacy step
     * asked for them: one shared list while Answer and Direct are linked, otherwise one per
     * capability that reads sources. A grant that only writes notes has none.
     */
    fun sourceScopes(answerOn: Boolean): List<AccessSourceScope> = when {
        answerOn && directEnabled -> if (linkedSources) {
            listOf(AccessSourceScope.SHARED)
        } else {
            listOf(AccessSourceScope.ANSWER, AccessSourceScope.DIRECT)
        }
        answerOn -> listOf(AccessSourceScope.ANSWER)
        directEnabled -> listOf(AccessSourceScope.DIRECT)
        else -> emptyList()
    }

    /** The list one scope stands for. The shared list is Answer's, as [directBoundary] reads it. */
    fun sources(scope: AccessSourceScope): AccessSourceSelectionState =
        if (scope == AccessSourceScope.DIRECT) directSources else answerSources

    /** How answers are released, as the review states it: the policy that reviews them, or none. */
    fun answerPrivacySummary(overview: AccessOverview): String = when (answerRelease) {
        AccessAnswerReleaseChoice.REVIEWED ->
            overview.policyFamilies.firstOrNull { it.id == policyFamilyId }?.name ?: "Privacy policy"
        AccessAnswerReleaseChoice.UNREVIEWED -> "No privacy review"
    }

    /**
     * The decision this form describes, or null while it is not one the gateway would accept.
     * A gateway that predates connections receives a `connect` selection labelled with the
     * client's own name; any other gateway receives the path the Connection step chose.
     */
    fun selection(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
    ): AccessAuthorizationSelection? {
        connection?.let { return it.selection(request, overview, this) }
        val rules = ownRules(request, overview) ?: return null
        return AccessAuthorizationSelection.Connect(rules = rules, credentialLabel = credentialLabel(request))
    }

    /**
     * The permissions the Permissions and Data & privacy steps describe — a new access level's
     * on a gateway that proposes connections — or null while they are invalid.
     */
    internal fun ownRules(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
    ): List<AccessGrantRule>? {
        val known = overview.sources.filter { it.available }.mapTo(mutableSetOf()) { it.id }
        val answerOn = answerEnabled || request.requiresAnswer
        if (!answerOn && !directEnabled && !notesEnabled) return null
        val result = mutableListOf<AccessGrantRule>()
        if (notesEnabled) result += AccessGrantRule.notes()
        if (answerOn) {
            if (!answerSources.permitsAnyKnownSource(known)) return null
            val boundary = answerSources.boundary(known)
            if (boundary.sourceIds.size > MAX_ACCESS_SOURCE_IDS) return null
            val release = when (answerRelease) {
                AccessAnswerReleaseChoice.REVIEWED -> policyFamilyId.takeIf(String::isNotEmpty)?.let {
                    AccessAnswerRelease.reviewed(it)
                } ?: return null
                AccessAnswerReleaseChoice.UNREVIEWED -> AccessAnswerRelease.unreviewed()
            }
            result += AccessGrantRule.answer(boundary, release)
        }
        if (directEnabled) {
            val direct = directBoundary(answerOn)
            if (!direct.permitsAnyKnownSource(known)) return null
            val boundary = direct.boundary(known)
            if (boundary.sourceIds.size > MAX_ACCESS_SOURCE_IDS) return null
            result += AccessGrantRule.direct(boundary)
        }
        return result
    }

    companion object {
        /**
         * The form as the wizard opens it.
         *
         * On a gateway that proposes connections, the Connection step is preselected from the
         * proposal, and when the gateway matched a live connection from the same app a new
         * access level's permissions start as a copy of that connection's. On a gateway that
         * predates connections, a client it already knows starts from the rules its grant
         * holds today. Anything else starts with Answer on, reviewed by the default policy.
         * [nowMillis] decides which connections are still live enough to preselect.
         */
        fun initial(
            request: AccessAuthorizationRequest,
            overview: AccessOverview,
            connection: AccessConnectionProposal? = null,
            reconnect: AccessReconnectProposal? = null,
            nowMillis: Long = System.currentTimeMillis(),
        ): AccessAuthorizationForm {
            val choice = connection?.let { AccessConnectionChoice.initial(request, overview, it, nowMillis) }
            val prefill = if (choice == null) {
                reconnect?.grant?.rules
            } else {
                connection?.match?.grant?.rules
            }
            val form = prefill?.let { describing(it, overview, publishedPolicyOnly = true) }
                ?: AccessAuthorizationForm(policyFamilyId = defaultPolicy(overview))
            return form.copy(connection = choice)
        }

        /**
         * Existing rules as a form, so they can be edited or reviewed the way new ones are.
         *
         * With [publishedPolicyOnly], a policy that is no longer published is replaced by the
         * default one: the Data & privacy step offers only published policies, so an
         * unpublished one could be neither seen nor sent. Without it, the rules keep the policy
         * they name, so a review states what they hold.
         */
        internal fun describing(
            rules: List<AccessGrantRule>,
            overview: AccessOverview,
            publishedPolicyOnly: Boolean,
        ): AccessAuthorizationForm {
            val defaultPolicy = defaultPolicy(overview)
            val known = overview.sources.filter { it.available }.mapTo(mutableSetOf()) { it.id }
            val answer = rules.firstOrNull { it.capability == AccessCapability.ANSWER }
            val direct = rules.firstOrNull { it.capability == AccessCapability.DIRECT }
            val answerSources = answer?.let { AccessSourceSelectionState.from(it.sources, known) }
                ?: AccessSourceSelectionState()
            val directSources = direct?.let { AccessSourceSelectionState.from(it.sources, known) }
                ?: AccessSourceSelectionState()
            return AccessAuthorizationForm(
                answerEnabled = answer != null,
                directEnabled = direct != null,
                notesEnabled = rules.any { it.capability == AccessCapability.NOTES },
                answerSources = answerSources,
                directSources = directSources,
                answerRelease = if (answer?.release?.mode == AccessAnswerReleaseMode.UNREVIEWED) {
                    AccessAnswerReleaseChoice.UNREVIEWED
                } else {
                    AccessAnswerReleaseChoice.REVIEWED
                },
                policyFamilyId = answer?.release?.policyFamilyId
                    ?.takeIf { id -> !publishedPolicyOnly || overview.policyFamilies.any { it.id == id } }
                    ?: defaultPolicy,
                linkedSources = answer == null || direct == null || answerSources.sameAccessAs(directSources),
            )
        }

        private fun defaultPolicy(overview: AccessOverview): String =
            overview.defaultPolicyFamilyId ?: overview.policyFamilies.firstOrNull()?.id.orEmpty()

        /** The credential's label is the client's name, cut to what the gateway accepts. */
        internal fun credentialLabel(request: AccessAuthorizationRequest): String =
            utf16Prefix(request.clientName, 160)
    }
}
