// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * The model provider's own disposition for a failed request, as the gateway vetted and
 * forwarded it: the transport [status], the provider's error [type] / [code] taxonomy, the
 * offending request [param], and the provider-side [requestId] to quote in a support thread.
 *
 * Every field is optional and the whole object is absent from a gateway that predates it, so
 * a client must render the humanized failure sentence with or without it. Mirrors the wire
 * `provider` object on `agent.error`, `agent.message.end`'s `failure`, and the durable
 * `AgentTerminalFailure` / `AgentConversationTerminalFailure` records.
 */
@Serializable
data class AgentProviderFailureDetail(
    val status: Int? = null,
    val type: String? = null,
    val code: String? = null,
    val param: String? = null,
    val requestId: String? = null,
)

/**
 * Render the provider disposition as one machine-readable line — `HTTP 404 · NOT_FOUND ·
 * param=model` — in a fixed order (status, the provider's own code or, failing that, its error
 * type, the offending parameter, the provider request id) so the same failure always reads the
 * same way. Absent or blank fields drop out; `null` when nothing at all is carried, which is the
 * signal for a renderer to omit the line entirely.
 */
fun AgentProviderFailureDetail.formatLine(): String? {
    val parts = buildList {
        status?.let { add("HTTP $it") }
        (code?.takeIf { it.isNotBlank() } ?: type?.takeIf { it.isNotBlank() })?.let { add(it) }
        param?.takeIf { it.isNotBlank() }?.let { add("param=$it") }
        requestId?.takeIf { it.isNotBlank() }?.let { add("request $it") }
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}
