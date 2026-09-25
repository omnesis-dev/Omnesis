// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefPageDto
import dev.omnesis.android.transport.dto.BriefsCountDto
import dev.omnesis.android.transport.dto.DismissBriefBody
import dev.omnesis.android.transport.dto.OpenBriefThreadDto
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.getJson
import dev.omnesis.android.transport.http.postEmptySegments
import dev.omnesis.android.transport.http.postJsonSegmentsDiscarding
import dev.omnesis.android.transport.http.postSegments

/**
 * Omnesis Briefs — the proactive awareness feed, maintained server-side by the Cognition
 * Steward. The Android port of the iOS `BriefsClient`.
 *
 * Every route 404s unless the gateway reports the feature active (experimental mode AND a
 * background-agent model assigned). Callers treat that as "the feature is off" rather
 * than as a failure worth putting on screen.
 *
 * Brief ids come from the gateway and go back in the path, so every id-bearing call uses
 * the segment-encoding helpers — the id is one path segment, encoded exactly once.
 */
class BriefsClient(private val http: GatewayHttp) {

    /**
     * `GET /briefs/feed` — the ranked feed, first entry on top.
     *
     * An empty page is the "nothing to show" state and is never padded: the feed is
     * finite and it is explicitly fine for it to end.
     */
    suspend fun feed(limit: Int = 30, cursor: String? = null): BriefPageDto = http.getJson(
        "briefs/feed",
        buildMap {
            put("limit", limit.toString())
            cursor?.let { put("cursor", it) }
        },
    )

    /**
     * `GET /briefs/count` — the number of showable unread briefs, for the menu badge.
     *
     * A cheap counterpart to [feed]: it never returns the briefs themselves, so the badge
     * renders without fetching the feed.
     */
    suspend fun unreadCount(): Int = http.getJson<BriefsCountDto>("briefs/count").unread

    /**
     * `POST /briefs/:id/read` — mark a brief seen, so read briefs sort last on a return
     * visit. Idempotent on an already-read brief; a dismissed one answers 409.
     */
    suspend fun markRead(briefId: String) {
        http.postSegments(listOf("briefs", briefId, "read"))
    }

    /**
     * `POST /briefs/:id/dismiss` — flip the brief into its dismissed state and enqueue the
     * feedback run the Steward reacts with.
     *
     * [snoozeUntil] is only valid with [BriefDismissReasonDto.SNOOZED]; omitted there it
     * means "the agent decides when to bring this back".
     */
    suspend fun dismiss(
        briefId: String,
        reason: BriefDismissReasonDto,
        feedback: String? = null,
        snoozeUntil: String? = null,
    ) {
        http.postJsonSegmentsDiscarding(
            listOf("briefs", briefId, "dismiss"),
            DismissBriefBody(
                reason = reason.wire,
                feedback = feedback?.takeIf { it.isNotBlank() },
                snoozeUntil = snoozeUntil,
            ),
        )
    }

    /**
     * `POST /briefs/:id/thread` — open (or return) the brief's talk-back thread: a
     * conversation seeded with the transcript of the loop-agent run that produced the
     * brief. Idempotent — one thread per brief — and the returned conversation id feeds
     * the normal agent resume flow.
     */
    suspend fun openThread(briefId: String): OpenBriefThreadDto =
        http.postEmptySegments(listOf("briefs", briefId, "thread"))
}
