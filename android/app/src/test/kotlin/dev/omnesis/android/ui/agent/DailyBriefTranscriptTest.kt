// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.DailyBriefItemDto
import dev.omnesis.android.transport.dto.DailyBriefItemsDto
import dev.omnesis.android.transport.dto.DailyBriefMessageRef
import dev.omnesis.android.transport.dto.UserPart
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Morning brief conversation's grouping, wording and fold state. All fixture data is invented. */
class DailyBriefTranscriptTest {

    private val london = ZoneId.of("Europe/London")

    private fun brief(text: String) = ChatMessage.Assistant(listOf(AssistantPart.Text(text)))
    private fun user(text: String) = ChatMessage.User(listOf(UserPart.Text(text)))

    private val monday = DailyBriefMessageRef("2026-10-12", 0, "mb_mon", "2026-10-12T06:02:00.000Z")
    private val tuesday = DailyBriefMessageRef("2026-10-13", 3, "mb_tue")
    private val wednesday = DailyBriefMessageRef("2026-10-14", 4, "mb_wed", "2026-10-14T06:05:00.000Z")
    private val origin = ConversationOrigin(
        kind = ConversationOrigin.DAILY_BRIEF_KIND,
        runId = "run_example",
        briefs = listOf(monday, tuesday, wednesday),
    )

    /** Monday's brief and a reply with its answer; Tuesday's brief straight after Monday's answer; Wednesday's. */
    private val messages = listOf(
        brief("Monday's brief"),
        user("What about the venue?"),
        brief("The venue confirmed."),
        brief("Tuesday's brief"),
        brief("Wednesday's brief"),
        user("Thanks"),
        brief("You're welcome."),
    )

    private fun turns(startIndex: Int = 0, page: List<ChatMessage> = messages) =
        AgentTurnBuilder.turns(page, breakBefore = AgentTurnBuilder.briefTurnBreaks(origin, startIndex))

    // --- Turn breaks ---------------------------------------------------------------------------

    /** A brief straight after the previous day's answer still starts a turn of its own. */
    @Test
    fun each_brief_opens_its_own_turn_with_a_stable_id() {
        val built = turns()
        assertEquals(
            listOf("brief-mb_mon", "u-1", "a-2", "brief-mb_tue", "brief-mb_wed", "u-5", "a-6"),
            built.map { it.id },
        )
        assertEquals(
            listOf(AgentPart.Text("Tuesday's brief")),
            (built[3] as AgentTurn.Assistant).parts,
        )
    }

    @Test
    fun breaks_are_placed_by_counting_from_the_first_loaded_message() {
        val tail = messages.drop(3)
        val built = turns(startIndex = 3, page = tail)
        assertEquals("brief-mb_tue", built[0].id)
        assertEquals("brief-mb_wed", built[1].id)
        assertTrue(AgentTurnBuilder.briefTurnBreaks(null, 0).isEmpty())
    }

    // --- Grouping ------------------------------------------------------------------------------

    @Test
    fun turns_group_under_the_brief_that_opened_each_day() {
        val transcript = DailyBriefTranscript.of(turns(), origin.briefs)
        assertTrue(transcript.leading.isEmpty())
        assertEquals(listOf("mb_mon", "mb_tue", "mb_wed"), transcript.days.map { it.brief.messageId })
        assertEquals(listOf(3, 1, 3), transcript.days.map { it.turns.size })
        assertEquals(listOf(1, 0, 1), transcript.days.map { it.replyCount })
        assertEquals("mb_wed", transcript.latest?.brief?.messageId)
    }

    /** A page that starts mid-day keeps the turns before its first brief as the leading run. */
    @Test
    fun turns_before_the_first_loaded_brief_lead_the_list() {
        val tail = messages.drop(1)
        val transcript = DailyBriefTranscript.of(turns(startIndex = 1, page = tail), origin.briefs)
        assertEquals(2, transcript.leading.size)
        assertEquals(listOf("mb_tue", "mb_wed"), transcript.days.map { it.brief.messageId })
    }

    // --- Rows and folding ----------------------------------------------------------------------

    private fun view() = DailyBriefViewState().observeLatest(origin.latestDailyBrief)

    @Test
    fun the_latest_day_is_open_with_its_list_and_earlier_days_fold_to_one_line() {
        val rows = DailyBriefRow.of(DailyBriefTranscript.of(turns(), origin.briefs), view())
        assertEquals(
            listOf(
                "Separator", "Folded",
                "Separator", "Folded",
                "Separator", "Brief", "Footer", "Turn", "Turn",
            ),
            rows.map { it::class.simpleName },
        )
        val latest = rows[4] as DailyBriefRow.Separator
        assertFalse(latest.foldable)
        assertTrue((rows[0] as DailyBriefRow.Separator).foldable)
        assertTrue(view().isFooterOpen(wednesday))
        assertFalse(view().isFooterOpen(monday))
        // The folded line stands in for the day's first turn, keyed by it.
        assertEquals("brief-mb_mon", rows[1].key)
    }

    @Test
    fun opening_an_earlier_day_shows_it_with_its_list_closed() {
        val opened = view().toggleDay(monday)
        assertTrue(opened.isOpen(monday))
        assertFalse(opened.isFooterOpen(monday))
        val rows = DailyBriefRow.of(DailyBriefTranscript.of(turns(), origin.briefs), opened)
        assertEquals(listOf("Separator", "Brief", "Footer", "Turn", "Turn"), rows.take(5).map { it::class.simpleName })
        assertFalse(opened.toggleDay(monday).isOpen(monday))
        // The latest day does not fold.
        assertTrue(opened.toggleDay(wednesday).isOpen(wednesday))
    }

    @Test
    fun a_footer_toggle_flips_its_default() {
        val view = view()
        assertFalse(view.toggleFooter(wednesday).isFooterOpen(wednesday))
        assertTrue(view.toggleFooter(monday).isFooterOpen(monday))
    }

    /** A newer brief arriving folds the day that was latest, as if the conversation had just opened. */
    @Test
    fun a_new_brief_folds_the_previous_latest_day() {
        val thursday = DailyBriefMessageRef("2026-10-15", 7, "mb_thu")
        val before = view().toggleFooter(wednesday)
        val after = before.observeLatest(thursday)
        assertEquals("mb_thu", after.latestId)
        assertFalse(after.isOpen(wednesday))
        assertFalse(after.isFooterOpen(wednesday))
        assertTrue(after.isOpen(thursday))
    }

    @Test
    fun items_are_fetched_once_and_a_failure_waits_for_retry() {
        val page = DailyBriefItemsDto(
            day = "2026-10-14",
            messageId = "mb_wed",
            sentAt = "2026-10-14T06:05:00.000Z",
            items = listOf(DailyBriefItemDto(rank = 1, observationId = "o", summary = "S")),
        )
        val view = view()
        assertTrue(view.needsFetch("2026-10-14"))
        val loading = view.withItems("2026-10-14", DailyBriefItemsState.Loading)
        assertFalse(loading.needsFetch("2026-10-14"))
        assertNull(loading.itemCount("2026-10-14"))
        val loaded = loading.withItems("2026-10-14", DailyBriefItemsState.Loaded(page))
        assertEquals(1, loaded.itemCount("2026-10-14"))
        assertEquals("2026-10-14T06:05:00.000Z", loaded.sentAt("2026-10-14"))
        assertFalse(view.withItems("2026-10-13", DailyBriefItemsState.Failed).needsFetch("2026-10-13"))
    }

    // --- Wording -----------------------------------------------------------------------------------

    @Test
    fun days_read_as_today_yesterday_or_a_short_date() {
        val now = Instant.parse("2026-10-14T09:00:00Z")
        assertEquals("Today", DailyBriefCopy.dayLabel("2026-10-14", now, london, Locale.UK))
        assertEquals("Yesterday", DailyBriefCopy.dayLabel("2026-10-13", now, london, Locale.UK))
        assertEquals("Mon 12 Oct", DailyBriefCopy.dayLabel("2026-10-12", now, london, Locale.UK))
        assertEquals("Monday 12 October", DailyBriefCopy.spokenDayLabel("2026-10-12", now, london, Locale.UK))
        assertNull(DailyBriefCopy.dayLabel("not-a-day", now, london, Locale.UK))
    }

    /** "Today" is the phone's local day, not UTC's: just after local midnight is already tomorrow. */
    @Test
    fun the_day_is_the_local_calendar_day() {
        // 23:30 UTC on the 13th is 00:30 on the 14th in London (BST).
        val now = Instant.parse("2026-10-13T23:30:00Z")
        assertEquals("Today", DailyBriefCopy.dayLabel("2026-10-14", now, london, Locale.UK))
        assertEquals("Yesterday", DailyBriefCopy.dayLabel("2026-10-13", now, london, Locale.UK))
    }

    /** The clocks go back on Sunday 25 October 2026 in London: that day lasts 25 hours. */
    @Test
    fun day_labels_hold_across_the_clock_change() {
        val lateOnTheLongDay = Instant.parse("2026-10-25T23:30:00Z") // 23:30 GMT on the 25th
        assertEquals("Today", DailyBriefCopy.dayLabel("2026-10-25", lateOnTheLongDay, london, Locale.UK))
        assertEquals("Yesterday", DailyBriefCopy.dayLabel("2026-10-24", lateOnTheLongDay, london, Locale.UK))
        val earlyNextDay = Instant.parse("2026-10-26T00:10:00Z") // 00:10 GMT on the 26th
        assertEquals("Yesterday", DailyBriefCopy.dayLabel("2026-10-25", earlyNextDay, london, Locale.UK))
        assertEquals("Sat 24 Oct", DailyBriefCopy.dayLabel("2026-10-24", earlyNextDay, london, Locale.UK))
        val justAfterTheChange = Instant.parse("2026-10-25T01:30:00Z") // 01:30 GMT, after 02:00 BST
        assertEquals("Today", DailyBriefCopy.dayLabel("2026-10-25", justAfterTheChange, london, Locale.UK))
    }

    @Test
    fun the_send_time_is_the_local_clock_time_on_either_side_of_the_change() {
        assertEquals("07:02", DailyBriefCopy.sentTime("2026-10-24T06:02:00.000Z", london, Locale.UK))
        assertEquals("06:02", DailyBriefCopy.sentTime("2026-10-25T06:02:00Z", london, Locale.UK))
        assertNull(DailyBriefCopy.sentTime(null, london, Locale.UK))
        assertNull(DailyBriefCopy.sentTime("yesterday morning", london, Locale.UK))
    }

    @Test
    fun the_folded_line_counts_things_and_replies_once_known() {
        assertEquals("Morning brief · 5 things · 2 replies", DailyBriefCopy.foldedSummary(5, 2))
        assertEquals("Morning brief · 1 thing · 1 reply", DailyBriefCopy.foldedSummary(1, 1))
        assertEquals("Morning brief", DailyBriefCopy.foldedSummary(null, 0))
        assertEquals("Morning brief", DailyBriefCopy.foldedSummary(0, 0))
        assertEquals("Based on 3 things", DailyBriefCopy.basedOn(3))
    }

    @Test
    fun the_composer_names_the_brief_only_in_its_conversation() {
        assertEquals("Reply about today's brief…", DailyBriefCopy.composerPrompt(origin))
        assertEquals("Ask Omnesis", DailyBriefCopy.composerPrompt(null))
        assertEquals("Ask Omnesis", DailyBriefCopy.composerPrompt(ConversationOrigin(kind = "watch_firing")))
    }
}
