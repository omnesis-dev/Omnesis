// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devannotate

/**
 * The entity a developer annotation points at — the Android analogue of the
 * iOS `DevAnnotationTarget` and the portal's `deriveDevTarget` result. A shake
 * files a note against whatever the operator is looking at; when no
 * addressable entity is in focus the composer files a free-form `route` note
 * instead, so a note can always be captured.
 *
 * Framework-free (no `android.*` imports) so it stays unit-testable on the
 * plain-JVM lane. The `targetType` strings mirror the gateway's
 * `DEV_ANNOTATION_TARGET_TYPES`.
 */
data class DevAnnotationTarget(
    val targetType: String,
    val targetId: String?,
    val label: String,
    val deepLink: String?,
)

/**
 * Derive a developer-annotation target from the current nav destination.
 *
 * TODO: only document routes and `agent` resolve to addressable entities today.
 * Privacy exchanges/approvals, watch detail, briefs, and people detail all
 * carry their entity IDs in nav arguments already — teach this function to
 * read them (and add the matching gateway target types where none exist, e.g.
 * watches) so those screens file attached notes instead of free-form ones.
 *
 * @param route the current destination's route *pattern* (e.g.
 *   `document/{id}`, `agent`), as `NavDestination.route` reports it — never a
 *   filled address, so a `deepLink` is only set when it names a real address
 *   (a filled document path, a placeholder-free route) and stays null
 *   otherwise. A templated pattern must never reach the store as a deep link.
 * @param documentId the decoded `id` argument of a `document/{id}`
 *   destination, when the route carries one.
 * @param agentSessionId the agent conversation currently on screen, when the
 *   agent surface holds one — mirrors the iOS conversation target and the
 *   portal's `activeConvoId`.
 */
fun devTargetForRoute(
    route: String?,
    documentId: String?,
    agentSessionId: String?,
): DevAnnotationTarget {
    if (route?.startsWith("document/") == true && !documentId.isNullOrBlank()) {
        return DevAnnotationTarget(
            targetType = "document",
            targetId = documentId,
            label = "Document $documentId",
            deepLink = "document/$documentId",
        )
    }
    if (route == "agent" && !agentSessionId.isNullOrBlank()) {
        return DevAnnotationTarget(
            targetType = "conversation",
            targetId = agentSessionId,
            label = "Conversation $agentSessionId",
            deepLink = route,
        )
    }
    // No addressable entity in focus — a free-form note tagged with the route.
    // The label keeps the pattern for screen identity; the deep link only a
    // placeholder-free address.
    return DevAnnotationTarget(
        targetType = "route",
        targetId = null,
        label = if (route.isNullOrBlank()) "General note" else "General note — $route",
        deepLink = route?.takeIf { it.isNotBlank() && !it.contains("{") },
    )
}
