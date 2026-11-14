// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessConnectionProposal
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
 * How one capability is coloured. A capability has one colour everywhere it appears, and a
 * granted capability is never the withheld grey — grey would read as the one capability this
 * connection does not hold.
 */
enum class AccessCapabilityTone { REVIEWED, RAW, WRITE, WITHHELD }

/** The tone one capability carries, given whether it is granted. */
fun capabilityTone(capability: AccessCapability, granted: Boolean): AccessCapabilityTone = when {
    !granted -> AccessCapabilityTone.WITHHELD
    capability == AccessCapability.ANSWER -> AccessCapabilityTone.REVIEWED
    capability == AccessCapability.DIRECT -> AccessCapabilityTone.RAW
    else -> AccessCapabilityTone.WRITE
}

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
 * released, one decision per screen ([authorizationPositions]); a grant that only writes notes has
 * neither question, so the step is skipped rather than shown empty. iOS and the portal derive the same lists; they must agree,
 * because the step chips show the reader a number per step.
 */
internal fun authorizationSteps(form: AccessAuthorizationForm): List<AccessAuthorizationStep> {
    if (!form.decidesPermissions) return listOf(AccessAuthorizationStep.CONNECTION, AccessAuthorizationStep.REVIEW)
    val permissions = if (form.level.readingCapabilities.isNotEmpty()) {
        listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.DATA, AccessAuthorizationStep.REVIEW)
    } else {
        listOf(AccessAuthorizationStep.PERMISSIONS, AccessAuthorizationStep.REVIEW)
    }
    return if (form.connection == null) permissions else listOf(AccessAuthorizationStep.CONNECTION) + permissions
}

/** One screen of the approval: a step, and within Data & privacy the one decision it asks. */
internal data class AccessAuthorizationPosition(val step: AccessAuthorizationStep, val dataPage: AccessLevelPage? = null)

/**
 * Every screen this approval walks through, in order. Data & privacy asks the decisions the level editor asks of a
 * new level, one per screen: Answer's sources, Direct's sources, new sources, then how answers are released, each
 * only where it applies.
 */
internal fun authorizationPositions(form: AccessAuthorizationForm): List<AccessAuthorizationPosition> =
    authorizationSteps(form).flatMap { step ->
        if (step != AccessAuthorizationStep.DATA) listOf(AccessAuthorizationPosition(step))
        else form.level.createPages().filter { it != AccessLevelPage.PERMISSIONS && it != AccessLevelPage.REVIEW }.map { AccessAuthorizationPosition(step, it) }
    }

/** Where [step] and [dataPage] are in [positions]. A step entered without a decision, or with one it no longer asks, is at its first screen. */
internal fun authorizationPositionIndex(positions: List<AccessAuthorizationPosition>, step: AccessAuthorizationStep, dataPage: AccessLevelPage?): Int =
    positions.indexOf(AccessAuthorizationPosition(step, dataPage.takeIf { step == AccessAuthorizationStep.DATA })).takeIf { it >= 0 }
        ?: positions.indexOfFirst { it.step == step }.coerceAtLeast(0)

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

/** Whether a boundary of this mode takes in a source connected later: every mode but a list of the allowed ones. */
internal val AccessSourceMode.admitsNewSources: Boolean get() = this != AccessSourceMode.ALLOWLIST

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
    val futureSourcesAllowed: Boolean get() = mode.admitsNewSources

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

/** What stands in place of an approval while filters cannot be authored and the new level would carry some. */
internal const val FILTERS_UNAVAILABLE_MESSAGE = "New access with filters is unavailable. Choose an existing level or change the allowed capabilities."

/**
 * What an approval decides. [level] is the draft of the access level the approval creates, the same draft the
 * level editor edits, carrying the new level's name; on a gateway that predates connections it holds the client's
 * own permissions. [connection] is the Connection step's answers, or null on such a gateway, where the wizard opens
 * on Permissions and approves with a `connect` selection.
 */
data class AccessAuthorizationForm(val level: AccessLevelDraft, val connection: AccessConnectionChoice? = null) {
    /** Whether this approval decides permissions itself, and does not take an existing level's or a replaced connection's. */
    val decidesPermissions: Boolean get() = connection == null || connection.path == AccessConnectionPath.NEW_LEVEL

    /** Whether the permissions this approval decides carry filters while the gateway cannot author any. */
    fun filtersUnavailable(overview: AccessOverview): Boolean =
        decidesPermissions && overview.sourceFilters?.enabled != true && level.serializedRules.any { it.scopePolicies.isNotEmpty() }

    /** Why the permissions this approval decides cannot be granted, or null when they can. The new level's name is the Connection step's to judge. */
    fun permissionsError(overview: AccessOverview): String? =
        level.permissionsError(overview) ?: FILTERS_UNAVAILABLE_MESSAGE.takeIf { filtersUnavailable(overview) }

    /**
     * The decision this form describes, or null while it is not one the gateway would accept.
     * A gateway that predates connections receives a `connect` selection labelled with the
     * client's own name; any other gateway receives the path the Connection step chose. The
     * rules sent are the draft's as the level editor saves them.
     */
    fun selection(
        request: AccessAuthorizationRequest,
        overview: AccessOverview,
    ): AccessAuthorizationSelection? {
        connection?.let { return it.selection(request, overview, this) }
        if (permissionsError(overview) != null) return null
        return AccessAuthorizationSelection.Connect(rules = level.serializedRules, credentialLabel = credentialLabel(request))
    }

    companion object {
        /**
         * The form as the wizard opens it.
         *
         * On a gateway that proposes connections, the Connection step is preselected from the
         * proposal, and when the gateway matched a live connection from the same app a new
         * access level's permissions start as a copy of that connection's. On a gateway that
         * predates connections, a client it already knows starts from the rules its grant
         * holds today. Anything else starts as the level editor's new level does. An agent that
         * cannot work without Answer always starts with it.
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
            val prefill = if (choice == null) reconnect?.grant?.rules else connection?.match?.grant?.rules
            val permissions = prefill?.let { AccessLevelDraft.copying(it, overview) } ?: AccessLevelDraft.opening(null, overview)
            val level = (if (request.requiresAnswer) permissions.enabled(AccessCapability.ANSWER, true, overview) else permissions)
                .copy(name = connection?.let { AccessConnectionChoice.defaultLevelName(request, it) }.orEmpty())
            return AccessAuthorizationForm(level, choice)
        }

        /** The credential's label is the client's name, cut to what the gateway accepts. */
        internal fun credentialLabel(request: AccessAuthorizationRequest): String =
            utf16Prefix(request.clientName, 160)
    }
}
