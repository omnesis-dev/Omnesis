// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.DailyBriefItemsDto
import dev.omnesis.android.transport.dto.DailyBriefMessageRef
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.util.Locale

/** One day of the Morning brief conversation: the brief, then the conversation that followed it until the next brief. */
data class DailyBriefDay(
    val brief: DailyBriefMessageRef,
    /** The brief's own turn first, then every turn after it that day. */
    val turns: List<AgentTurn>,
) {
    /** The user's messages that day. */
    val replyCount: Int get() = turns.count { it is AgentTurn.User }
}

/**
 * The Morning brief conversation's turns grouped by the brief that opened each day. A brief's
 * turn is found by its id ([AgentTurnBuilder.briefTurnId]), which the turn builder gives it
 * when the brief index places it in the loaded messages.
 */
data class DailyBriefTranscript(
    /** Turns before the first loaded brief: the end of a day whose brief is on a page not loaded yet. */
    val leading: List<AgentTurn>,
    /** Oldest first. */
    val days: List<DailyBriefDay>,
) {
    /** The day the conversation is about now. It is always shown open. */
    val latest: DailyBriefDay? get() = days.lastOrNull()

    companion object {
        fun of(turns: List<AgentTurn>, briefs: List<DailyBriefMessageRef>): DailyBriefTranscript {
            val briefByTurnId = briefs.associateBy(AgentTurnBuilder::briefTurnId)
            val leading = mutableListOf<AgentTurn>()
            val days = mutableListOf<Pair<DailyBriefMessageRef, MutableList<AgentTurn>>>()
            for (turn in turns) {
                val brief = briefByTurnId[turn.id]
                when {
                    brief != null -> days += brief to mutableListOf(turn)
                    days.isEmpty() -> leading += turn
                    else -> days.last().second += turn
                }
            }
            return DailyBriefTranscript(leading, days.map { (brief, dayTurns) -> DailyBriefDay(brief, dayTurns) })
        }
    }
}

/** The words and dates of the Morning brief conversation, in the phone's own calendar. */
object DailyBriefCopy {
    const val TITLE = "Morning brief"
    const val COMPOSER_PROMPT = "Reply about today's brief…"
    const val DEFAULT_COMPOSER_PROMPT = "Ask Omnesis"

    /** What the composer says while idle in a conversation with this origin. */
    fun composerPrompt(origin: ConversationOrigin?): String =
        if (origin?.isDailyBrief == true) COMPOSER_PROMPT else DEFAULT_COMPOSER_PROMPT

    /**
     * "Today", "Yesterday" or a short date ("Tue 13 Oct") for a local `YYYY-MM-DD` [day], as
     * seen at [now] in [zone]. Whole calendar days between the two dates, so a day that is 23
     * or 25 hours long across a clock change still counts as one. Null when [day] is not a date.
     */
    fun dayLabel(day: String, now: Instant, zone: ZoneId, locale: Locale = Locale.getDefault()): String? =
        label(day, now, zone, DateTimeFormatter.ofPattern("EEE d MMM", locale))

    /** The same day spelled out for TalkBack ("Tuesday 13 October"). */
    fun spokenDayLabel(day: String, now: Instant, zone: ZoneId, locale: Locale = Locale.getDefault()): String? =
        label(day, now, zone, DateTimeFormatter.ofPattern("EEEE d MMMM", locale))

    /** The local time a brief was sent ("07:02"), or null when nothing says. */
    fun sentTime(sentAt: String?, zone: ZoneId, locale: Locale = Locale.getDefault()): String? {
        val instant = sentAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return null
        return DateTimeFormatter.ofPattern("HH:mm", locale).format(instant.atZone(zone))
    }

    /** "Based on 5 things". */
    fun basedOn(count: Int): String = "Based on ${things(count)}"

    /**
     * The one line a folded day shows: "Morning brief · 5 things · 2 replies". The count of
     * things is left out until it is known, and nothing is said about a count of zero.
     */
    fun foldedSummary(itemCount: Int?, replyCount: Int): String = buildList {
        add(TITLE)
        if (itemCount != null && itemCount > 0) add(things(itemCount))
        if (replyCount > 0) add(if (replyCount == 1) "1 reply" else "$replyCount replies")
    }.joinToString(" · ")

    fun things(count: Int): String = if (count == 1) "1 thing" else "$count things"

    private fun label(day: String, now: Instant, zone: ZoneId, format: DateTimeFormatter): String? {
        val date = try {
            LocalDate.parse(day)
        } catch (_: DateTimeParseException) {
            return null
        }
        return when (ChronoUnit.DAYS.between(date, now.atZone(zone).toLocalDate())) {
            0L -> "Today"
            1L -> "Yesterday"
            else -> format.format(date)
        }
    }
}

/** Where one brief's items stand. */
sealed interface DailyBriefItemsState {
    data object Loading : DailyBriefItemsState
    data class Loaded(val page: DailyBriefItemsDto) : DailyBriefItemsState
    data object Failed : DailyBriefItemsState
}

/**
 * What the Morning brief conversation remembers while it is on screen: which days are open,
 * which "Based on" lists are open, and the items each day's brief was based on.
 *
 * The latest brief's day is always open with its list showing — what it was based on is what a
 * reader most wants to check. Every earlier day starts folded to one line, and its list starts
 * closed when the day is opened. Mirrors the iOS `DailyBriefModel`.
 */
data class DailyBriefViewState(
    /** Items by brief day. */
    val items: Map<String, DailyBriefItemsState> = emptyMap(),
    /** Earlier days the reader opened, by brief message id. */
    val openedDays: Set<String> = emptySet(),
    /**
     * "Based on" lists whose open state the reader changed, by brief message id. A list is open
     * by default for the latest brief and closed for earlier ones; a toggle flips it.
     */
    val toggledFooters: Set<String> = emptySet(),
    /** The latest brief seen, by message id. */
    val latestId: String? = null,
) {
    fun isOpen(brief: DailyBriefMessageRef): Boolean = brief.messageId == latestId || brief.messageId in openedDays

    fun isFooterOpen(brief: DailyBriefMessageRef): Boolean =
        (brief.messageId == latestId) != (brief.messageId in toggledFooters)

    /** How many things a day's brief was based on, once known. */
    fun itemCount(day: String): Int? = (items[day] as? DailyBriefItemsState.Loaded)?.page?.items?.size

    /** When a day's brief was sent, as its items read says. */
    fun sentAt(day: String): String? = (items[day] as? DailyBriefItemsState.Loaded)?.page?.sentAt

    /** Note the latest brief. A newer brief arriving folds the day that was latest. */
    fun observeLatest(latest: DailyBriefMessageRef?): DailyBriefViewState {
        if (latest == null || latest.messageId == latestId) return this
        val previous = latestId
        return copy(
            latestId = latest.messageId,
            openedDays = if (previous == null) openedDays else openedDays - previous,
            toggledFooters = if (previous == null) toggledFooters else toggledFooters - previous,
        )
    }

    /** Open or fold an earlier day. The latest day does not fold. */
    fun toggleDay(brief: DailyBriefMessageRef): DailyBriefViewState = when {
        brief.messageId == latestId -> this
        brief.messageId in openedDays -> copy(openedDays = openedDays - brief.messageId)
        else -> copy(openedDays = openedDays + brief.messageId)
    }

    fun toggleFooter(brief: DailyBriefMessageRef): DailyBriefViewState = copy(
        toggledFooters = if (brief.messageId in toggledFooters) {
            toggledFooters - brief.messageId
        } else {
            toggledFooters + brief.messageId
        },
    )

    /** Whether a day's items should be fetched now: never asked for, and not on their way. */
    fun needsFetch(day: String): Boolean = items[day] == null

    fun withItems(day: String, state: DailyBriefItemsState): DailyBriefViewState = copy(items = items + (day to state))
}

/** One line of the Morning brief conversation's list. Each has a [key] stable across recompositions. */
sealed interface DailyBriefRow {
    val key: String

    /** A turn shown as an ordinary bubble. */
    data class Turn(val turn: AgentTurn) : DailyBriefRow {
        override val key: String get() = turn.id
    }

    /** The thin rule and centred day name above a brief. [foldable] is false for the latest day. */
    data class Separator(val brief: DailyBriefMessageRef, val foldable: Boolean, val open: Boolean) : DailyBriefRow {
        override val key: String get() = separatorKey(brief)
    }

    /**
     * An earlier day folded to one line. Keyed by the day's first turn, which it stands in for,
     * so an earlier page prepended above keeps the reader's place on it.
     */
    data class Folded(val day: DailyBriefDay) : DailyBriefRow {
        override val key: String get() = day.turns.first().id
    }

    /** The brief itself under its header. */
    data class Brief(val brief: DailyBriefMessageRef, val turn: AgentTurn) : DailyBriefRow {
        override val key: String get() = turn.id
    }

    /** "Based on N things" under a brief. */
    data class Footer(val brief: DailyBriefMessageRef) : DailyBriefRow {
        override val key: String get() = "daily-brief-footer-${brief.messageId}"
    }

    companion object {
        fun separatorKey(brief: DailyBriefMessageRef) = "daily-brief-separator-${brief.messageId}"

        /** The conversation as the list draws it: each day's separator, then the day open or folded. */
        fun of(transcript: DailyBriefTranscript, view: DailyBriefViewState): List<DailyBriefRow> = buildList {
            transcript.leading.forEach { add(Turn(it)) }
            for (day in transcript.days) {
                val latest = day.brief.messageId == view.latestId
                val open = view.isOpen(day.brief)
                add(Separator(day.brief, foldable = !latest, open = open))
                if (open) {
                    add(Brief(day.brief, day.turns.first()))
                    add(Footer(day.brief))
                    day.turns.drop(1).forEach { add(Turn(it)) }
                } else {
                    add(Folded(day))
                }
            }
        }
    }
}
