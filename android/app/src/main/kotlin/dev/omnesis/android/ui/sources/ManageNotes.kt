// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.session.SessionManager
import java.net.URLEncoder

private val NOTE_DAY_RE = Regex("""^\d{4}-\d{2}-\d{2}$""")

/**
 * The gateway-internal source whose day documents the Manage-notes link
 * serves. Notes is currently the only internal source; the link (day
 * seed + Tell Omnesis destination) is Notes-specific, so callers gate on
 * this id rather than the generic internal flag — a future internal
 * sibling must not inherit a link to the wrong surface.
 */
const val NOTES_SOURCE_ID = "omnesis-notes"

/** Whether this source's documents get the Manage-notes link. */
fun isNotesSource(sourceId: String): Boolean = sourceId == NOTES_SOURCE_ID

/**
 * The day a document belongs to, for the Manage-notes link. Generated Notes
 * documents carry the day as their external id; anything else falls back to
 * the creation date. Null when neither is day-shaped.
 */
fun notesDayForDocument(externalId: String?, sourceCreatedAt: String?): String? {
    if (externalId != null && NOTE_DAY_RE.matches(externalId)) return externalId
    val day = sourceCreatedAt?.take(10)
    if (day != null && NOTE_DAY_RE.matches(day)) return day
    return null
}

/**
 * Portal Tell Omnesis URL for managing notes. With a day, the history seeds
 * at that day (a link from an old daily document still lands on relevant
 * notes); without one it opens the latest notes. The device token rides as
 * a query item for one-click sign-in — the portal strips it on arrival so
 * it never survives into reloads or shares.
 */
fun manageNotesUrl(baseUrl: String, token: String, day: String?): String {
    val query = buildList {
        if (day != null) add("day=${URLEncoder.encode(day, "UTF-8")}")
        add("token=${URLEncoder.encode(token, "UTF-8")}")
    }.joinToString("&")
    return "${baseUrl.trimEnd('/')}/portal/capture?$query"
}

/**
 * Tell Omnesis URL for the current pairing, or null when unpaired. Shared
 * by the ViewModels whose screens offer Manage notes on read-only
 * generated documents.
 */
internal fun manageNotesUrl(session: SessionManager, day: String?): String? =
    runCatching { session.requireSession().pairing }
        .getOrNull()
        ?.let { manageNotesUrl(it.url, it.token, day) }
