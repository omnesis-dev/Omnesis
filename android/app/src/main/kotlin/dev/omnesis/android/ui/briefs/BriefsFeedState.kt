// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import dev.omnesis.android.transport.dto.BriefReadStateDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The feed as the screen holds it: the ranked briefs, plus which of them the user has
 * actually looked at during this visit.
 *
 * Unread-ness is tracked here rather than read off [BriefRecordDto.state] because opening
 * a brief marks it read on the server, and the row should stop shouting the moment it is
 * opened — not on the next fetch. A brief already `read` when it arrived is never unread
 * again.
 *
 * Pure data: no Compose, no client, so the whole thing is exercised in the JVM lane.
 * Port of the iOS `BriefsFeedState`.
 */
data class BriefsFeedState(
    val briefs: List<BriefRecordDto> = emptyList(),
    /** Ids marked seen during this visit, on top of whatever the server said. */
    private val viewed: Set<String> = emptySet(),
) {
    val isEmpty: Boolean get() = briefs.isEmpty()

    /** Unread briefs that are still showing — what the menu badge would count. */
    val unreadCount: Int get() = briefs.count { isUnread(it.id) }

    fun isUnread(id: String): Boolean {
        if (id in viewed) return false
        return briefs.firstOrNull { it.id == id }?.state == BriefReadStateDto.UNREAD
    }

    /** Replace the feed wholesale — a first load or a pull-to-refresh. */
    fun replacing(briefs: List<BriefRecordDto>): BriefsFeedState =
        copy(briefs = briefs, viewed = viewed.intersect(briefs.map { it.id }.toSet()))

    /** Append a page, dropping any id already held so a re-fetch cannot duplicate a row. */
    fun appending(more: List<BriefRecordDto>): BriefsFeedState {
        val known = briefs.map { it.id }.toSet()
        return copy(briefs = briefs + more.filterNot { it.id in known })
    }

    /**
     * Mark a brief seen. Returns null when it was already seen, so the caller can skip a
     * redundant mark-read POST.
     */
    fun markingViewed(id: String): BriefsFeedState? =
        if (id in viewed || !isUnread(id)) null else copy(viewed = viewed + id)

    /**
     * Take a brief out of the feed, returning the removed record so a failed dismiss can
     * put it back where it was. Null when the id was not in the feed.
     */
    fun removing(id: String): Pair<BriefsFeedState, RemovedBrief>? {
        val index = briefs.indexOfFirst { it.id == id }
        if (index < 0) return null
        val record = briefs[index]
        return copy(briefs = briefs.toMutableList().also { it.removeAt(index) }) to
            RemovedBrief(record = record, index = index)
    }

    /**
     * Put a removed brief back at the position it held, so a failed dismiss does not
     * silently reorder the feed under the user.
     */
    fun restoring(removed: RemovedBrief): BriefsFeedState {
        if (briefs.any { it.id == removed.record.id }) return this
        val index = removed.index.coerceIn(0, briefs.size)
        return copy(briefs = briefs.toMutableList().also { it.add(index, removed.record) })
    }

    /** A brief lifted out of the feed, with where it was. */
    data class RemovedBrief(val record: BriefRecordDto, val index: Int)
}

/**
 * A refresh may remove the row that owns the microphone. Compute the feed replacement and
 * whether that recording became orphaned together so callers cannot update one without
 * handling the other.
 */
internal data class BriefRefreshTransition(
    val feed: BriefsFeedState,
    val retainedDictatingBriefId: String?,
    val discardedDictation: Boolean,
)

internal fun replaceBriefFeed(
    current: BriefsFeedState,
    incoming: List<BriefRecordDto>,
    dictatingBriefId: String?,
): BriefRefreshTransition {
    val next = current.replacing(incoming)
    val retainedDictatingBriefId =
        dictatingBriefId?.takeIf { id -> next.briefs.any { it.id == id } }
    return BriefRefreshTransition(
        feed = next,
        retainedDictatingBriefId = retainedDictatingBriefId,
        discardedDictation = dictatingBriefId != null && retainedDictatingBriefId == null,
    )
}

/** Row copy stays plain while the detail view renders the original Markdown. */
internal fun briefRowPlainDescription(markdown: String): String =
    markdown.replace("**", "").replace("__", "")

/** The same four snooze choices the iOS Briefs surface offers. */
internal enum class BriefSnoozeChoice {
    LATER_TODAY,
    TOMORROW,
    PICK_A_TIME,
    AGENT_DECIDES,
}

/**
 * Resolve a snooze choice to the instant sent to the gateway. "Later today" is three
 * hours from now; "Tomorrow" is 09:00 in the user's current time zone. Letting the
 * agent decide deliberately sends no timestamp.
 */
internal fun resolveBriefSnooze(
    choice: BriefSnoozeChoice,
    now: Instant,
    zone: ZoneId,
    pickedTime: Instant? = null,
): Instant? = when (choice) {
    BriefSnoozeChoice.LATER_TODAY -> now.plusSeconds(3 * 60 * 60L)
    BriefSnoozeChoice.TOMORROW -> ZonedDateTime.ofInstant(now, zone)
        .toLocalDate()
        .plusDays(1)
        .atTime(9, 0)
        .atZone(zone)
        .toInstant()
    BriefSnoozeChoice.PICK_A_TIME -> pickedTime
    BriefSnoozeChoice.AGENT_DECIDES -> null
}

/** A picked reminder must still be in the future when the user confirms the form. */
internal fun isBriefSnoozeValid(
    choice: BriefSnoozeChoice,
    now: Instant,
    pickedTime: Instant?,
): Boolean = choice != BriefSnoozeChoice.PICK_A_TIME || pickedTime?.isAfter(now) == true
