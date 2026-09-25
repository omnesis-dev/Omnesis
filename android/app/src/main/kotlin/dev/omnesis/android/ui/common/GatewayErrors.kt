// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import dev.omnesis.android.designsystem.theme.OmnesisColors
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.GatewayConnectionProblem
import dev.omnesis.android.transport.gatewayConnectionAdvice
import dev.omnesis.android.transport.gatewayConnectionProblem

/**
 * The gateway's own sentence about why it refused, or null when it did not give
 * one. That sentence is often the only text that tells the operator what to
 * change — the generic status-code copy cannot. The transport already unwrapped
 * it from the error envelope, so this only decides whether there is one.
 */
fun gatewayErrorDetail(t: Throwable): String? =
    (t as? GatewayException.ServerError)?.body?.trim()?.takeIf { it.isNotEmpty() }

/** Turns a transport throwable into user-facing copy. Mirrors the iOS error classifier. */
fun classifyGatewayError(t: Throwable): String = when (t) {
    is GatewayException.Unauthorized ->
        "This device isn't authorized anymore. Re-pair with your gateway."
    is GatewayException.Forbidden ->
        "This device doesn't have permission to do that."
    is GatewayException.NotFound ->
        "Not found on the gateway."
    is GatewayException.Network ->
        gatewayConnectionAdvice(gatewayConnectionProblem(t) ?: GatewayConnectionProblem.UNREACHABLE)
    is GatewayException.ServerError ->
        "The gateway returned an error (${t.status})."
    is GatewayException.Decoding, is GatewayException.InvalidResponse ->
        "The gateway sent an unexpected response."
    else -> t.message ?: "Something went wrong."
}

/**
 * Short, cache-aware one-liner for an inline refresh-failure banner shown when stale
 * cached content is still visible (e.g. the Sources list after a failed refresh). Routes
 * through the same [gatewayErrorKind] classifier the full-screen view uses so the
 * vocabulary stays consistent, but returns a tighter "showing cached …" line per kind
 * rather than the full-screen explanatory copy. Mirrors the iOS
 * `SourcesView.inlineRefreshErrorText`.
 */
fun inlineRefreshErrorText(t: Throwable): String = when (val kind = gatewayErrorKind(t)) {
    GatewayErrorKind.Unreachable -> "Couldn't reach the gateway — showing cached sources."
    GatewayErrorKind.Certificate -> "Gateway certificate could not be verified — showing cached sources."
    GatewayErrorKind.Unauthorized -> "Authentication failed — re-pair from Settings."
    GatewayErrorKind.Forbidden -> "This device lacks the scope needed to refresh sources."
    GatewayErrorKind.AgentNotConfigured -> "Agent isn't configured — showing cached sources."
    is GatewayErrorKind.Server -> "Gateway returned ${kind.status} while refreshing."
    is GatewayErrorKind.Unknown -> kind.message
}

/**
 * Friendly buckets every thrown error maps into, carrying the icon / tint / title / detail
 * needed by [GatewayErrorView]. Ported from the iOS `GatewayErrorView.Kind`. Keeping the
 * typed kind (rather than only a string) lets the view pick an icon, tint, and
 * secondary-action vocabulary that match the failure.
 */
sealed interface GatewayErrorKind {
    object Unreachable : GatewayErrorKind
    object Certificate : GatewayErrorKind
    object Unauthorized : GatewayErrorKind
    object Forbidden : GatewayErrorKind
    object AgentNotConfigured : GatewayErrorKind
    data class Server(val status: Int, val body: String) : GatewayErrorKind
    data class Unknown(val message: String) : GatewayErrorKind

    /** Material Outlined icon echoing the iOS SF Symbol for this kind. */
    val icon: ImageVector
        get() = when (this) {
            Unreachable -> Icons.Outlined.WifiOff
            Certificate -> Icons.Outlined.GppMaybe
            // GppMaybe keeps the shield silhouette of iOS's `lock.shield` and preserves the
            // padlock/security motif a plain outline shield drops.
            Unauthorized, Forbidden -> Icons.Outlined.GppMaybe
            AgentNotConfigured -> Icons.Outlined.AutoAwesome
            is Server, is Unknown -> Icons.Outlined.WarningAmber
        }

    /** Per-kind tint, resolved from the active palette. */
    fun tint(c: OmnesisColors): Color = when (this) {
        Unreachable -> c.textMuted
        Certificate -> c.warning
        AgentNotConfigured -> c.accent
        Unauthorized, Forbidden, is Server, is Unknown -> c.warning
    }

    /** Short, plain-English title. Copy ported verbatim from iOS. */
    fun title(): String = when (this) {
        Unreachable -> "Couldn't connect to gateway"
        Certificate -> "Gateway certificate problem"
        Unauthorized -> "Authentication failed"
        Forbidden -> "Permission denied"
        AgentNotConfigured -> "Set up your agent"
        is Server -> "Gateway error"
        is Unknown -> "Something went wrong"
    }

    /**
     * Friendly explanation. `context` is a short verb-phrase describing what failed ("load
     * triggers", "start the agent") used to fill in the copy. Ported verbatim from iOS.
     */
    fun detail(context: String): String = when (this) {
        Unreachable -> gatewayConnectionAdvice(GatewayConnectionProblem.UNREACHABLE)
        Certificate -> gatewayConnectionAdvice(GatewayConnectionProblem.CERTIFICATE)
        Unauthorized ->
            "The gateway rejected this device's pairing. Re-pair from Settings to continue."
        Forbidden ->
            "This device's token lacks the scope needed to $context. Re-pair from Settings."
        AgentNotConfigured ->
            "No model is assigned to the agent yet. Open Models from the menu and pick a model for the Agent capability to start chatting."
        is Server -> serverDetail(status, body, context)
        is Unknown ->
            message.ifEmpty {
                "Something went wrong trying to $context. Retry, or open Settings to repair the connection."
            }
    }
}

/**
 * [body] is the `error` message the transport unwrapped from the gateway's error envelope — an
 * operator-curated string ("Anthropic API key not configured.", …), never the raw JSON. It is
 * surfaced verbatim, dropping the status-code preamble, because it says more than the status
 * does. Empty bodies fall back to the status so the user still has something to act on.
 */
private fun serverDetail(status: Int, body: String, context: String): String {
    val trimmed = body.trim()
    if (trimmed.isEmpty()) {
        return "The gateway returned status $status while trying to $context."
    }
    return trimmed
}

/**
 * Whether a 503 body text indicates the agent harness is not configured (no model assigned,
 * disabled, missing API key, or missing fixture). The gateway phrases the "no model assigned
 * to the agent capability" case as `Agent disabled. Set inference.assignments.agent …` — the
 * common first-run state before any agent model is picked. Matching is restricted to 503 by
 * [gatewayErrorKind] so a 500 that happens to contain the same text isn't misclassified.
 */
private fun isAgentNotConfigured(body: String): Boolean {
    val lower = body.lowercase()
    return lower.contains("agent harness disabled") ||
        lower.contains("agent disabled") ||
        lower.contains("anthropic api key not configured") ||
        lower.contains("replay backend selected but no fixture")
}

/**
 * Map any throwable into one of the friendly [GatewayErrorKind]s. Mirrors the iOS
 * `GatewayErrorView.classify`. A null/[GatewayException.Network] folds to [Unreachable] —
 * the user-visible cause is always "the gateway didn't answer".
 */
fun gatewayErrorKind(t: Throwable): GatewayErrorKind = when (t) {
    is GatewayException.Network -> when (gatewayConnectionProblem(t)) {
        GatewayConnectionProblem.CERTIFICATE -> GatewayErrorKind.Certificate
        else -> GatewayErrorKind.Unreachable
    }
    is GatewayException.Unauthorized -> GatewayErrorKind.Unauthorized
    is GatewayException.Forbidden -> GatewayErrorKind.Forbidden
    is GatewayException.ServerError -> {
        val body = t.body.orEmpty()
        if (t.status == 503 && isAgentNotConfigured(body)) {
            GatewayErrorKind.AgentNotConfigured
        } else {
            GatewayErrorKind.Server(t.status, body)
        }
    }
    is GatewayException.NotFound -> GatewayErrorKind.Unknown("Not found.")
    is GatewayException.Decoding, is GatewayException.InvalidResponse ->
        GatewayErrorKind.Unknown("The gateway returned an invalid response.")
    else -> GatewayErrorKind.Unknown(t.message ?: "Something went wrong.")
}
