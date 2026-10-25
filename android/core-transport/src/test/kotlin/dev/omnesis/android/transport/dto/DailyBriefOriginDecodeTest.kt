// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Morning brief conversation's origin on the wire. All fixture data is invented. */
class DailyBriefOriginDecodeTest {

    @Test
    fun a_messages_page_carries_the_full_brief_index_newest_last() {
        val page = OmnesisJson.decodeFromString<ConversationMessagePage>(
            """{"messages":[],"messageCount":7,
               "origin":{"kind":"daily_brief","runId":"run_example","briefs":[
                 {"day":"2026-10-11","messageIndex":0,"messageId":"mb_one"},
                 {"day":"2026-10-12","messageIndex":4,"messageId":"mb_two"}]}}""",
        )
        val origin = page.origin!!
        assertTrue(origin.isDailyBrief)
        assertEquals("run_example", origin.runId)
        assertEquals(2, origin.briefs.size)
        assertEquals(DailyBriefMessageRef("2026-10-12", 4, "mb_two"), origin.latestDailyBrief)
    }

    @Test
    fun a_malformed_brief_entry_is_dropped_without_losing_the_conversation() {
        val origin = OmnesisJson.decodeFromString<ConversationOrigin>(
            """{"kind":"daily_brief","runId":"run_example","briefs":[
                 {"day":"2026-10-10","messageIndex":0,"messageId":"mb_ok"},
                 "not-an-object",
                 {"day":"2026-10-11","messageIndex":"2","messageId":"mb_string_index"},
                 {"day":"2026-10-12","messageIndex":-1,"messageId":"mb_negative"},
                 {"messageIndex":3,"messageId":"mb_no_day"}]}""",
        )
        assertEquals(listOf("mb_ok"), origin.briefs.map { it.messageId })
        assertEquals(0, origin.latestDailyBrief?.messageIndex)
    }

    @Test
    fun a_brief_index_that_is_not_a_list_reads_as_empty() {
        val origin = OmnesisJson.decodeFromString<ConversationOrigin>(
            """{"kind":"daily_brief","runId":"run_example","briefs":{"oops":true}}""",
        )
        assertTrue(origin.briefs.isEmpty())
        assertNull(origin.latestDailyBrief)
    }

    /** Summaries carry only the anchor, which is all the list needs to withhold Delete. */
    @Test
    fun the_morning_brief_summary_is_not_deletable_and_other_threads_are() {
        val page = OmnesisJson.decodeFromString<ConversationsResponse>(
            """{"conversations":[
                 {"id":"conv_brief","title":"Morning brief","pinned":true,
                  "origin":{"kind":"daily_brief","runId":"run_example","briefs":[]}},
                 {"id":"conv_watch","title":"Deposit cleared",
                  "origin":{"kind":"watch_firing","firingId":"f1","runId":"f1","watchId":"w1"}},
                 {"id":"conv_plain","title":"Q4 budget recap"}]}""",
        )
        assertEquals(listOf(false, true, true), page.conversations.map { it.deletable })
    }

    /** A kind this build has never heard of is just a conversation: nothing hidden, nothing withheld. */
    @Test
    fun an_unknown_origin_kind_decodes_as_an_ordinary_thread() {
        val origin = OmnesisJson.decodeFromString<ConversationOrigin>(
            """{"kind":"something_later","runId":"run_example","briefs":[{"day":"2026-10-12","messageIndex":1,"messageId":"m"}],
               "extra":{"nested":[1,2,3]}}""",
        )
        assertFalse(origin.isDailyBrief)
        assertNull(origin.latestDailyBrief)
    }

    /** `sentAt` is optional: present it is kept, absent or malformed it reads as null. */
    @Test
    fun a_brief_entry_keeps_its_send_time_when_it_has_one() {
        val origin = OmnesisJson.decodeFromString<ConversationOrigin>(
            """{"kind":"daily_brief","runId":"run_example","briefs":[
                 {"day":"2026-10-12","messageIndex":0,"messageId":"mb_old"},
                 {"day":"2026-10-13","messageIndex":3,"messageId":"mb_odd","sentAt":42},
                 {"day":"2026-10-14","messageIndex":6,"messageId":"mb_new","sentAt":"2026-10-14T06:02:00.000Z"}]}""",
        )
        assertEquals(listOf(null, null, "2026-10-14T06:02:00.000Z"), origin.briefs.map { it.sentAt })
        assertEquals("mb_new", origin.latestDailyBrief?.messageId)
    }
}
