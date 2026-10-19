// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `GET /agent/conversations/:id/briefs/:day` on the wire. All fixture data is invented. */
class DailyBriefItemsDecodeTest {

    @Test
    fun a_brief_reads_with_its_ranked_items_sources_and_tasks() {
        val page = OmnesisJson.decodeFromString<DailyBriefItemsDto>(
            """{"day":"2026-10-14","messageId":"mb_today","sentAt":"2026-10-14T06:02:00.000Z",
               "items":[
                 {"rank":1,"observationId":"obs_a","summary":"The venue deposit is due Friday.",
                  "sources":[{"id":"doc_quote","title":"Venue quote","sourceType":"mail","createdAt":"2026-10-12T09:00:00Z"}],
                  "tasks":[{"id":"task_deposit","title":"Pay the venue deposit","state":"open"}]},
                 {"rank":2,"observationId":"obs_b","summary":"The tuner confirmed Thursday.",
                  "sources":[{"id":"doc_reply","title":null,"sourceType":null,"createdAt":null}],
                  "tasks":[{"id":"task_tuner","title":"Book the piano tuner","state":"done"}]}]}""",
        )
        assertEquals("2026-10-14", page.day)
        assertEquals("mb_today", page.messageId)
        assertEquals("2026-10-14T06:02:00.000Z", page.sentAt)
        assertEquals(listOf(1, 2), page.items.map { it.rank })
        val first = page.items[0]
        assertEquals("Venue quote", first.sources.single().title)
        assertEquals("mail", first.sources.single().sourceType)
        assertFalse(first.tasks.single().isResolved)
        val second = page.items[1]
        assertNull(second.sources.single().title)
        assertNull(second.sources.single().sourceType)
        assertTrue(second.tasks.single().isResolved)
    }

    @Test
    fun the_send_time_is_optional() {
        val page = OmnesisJson.decodeFromString<DailyBriefItemsDto>(
            """{"day":"2026-10-13","messageId":"mb_old","items":[]}""",
        )
        assertNull(page.sentAt)
        assertTrue(page.items.isEmpty())
    }

    /** One entry this build cannot read costs only itself; the rest of the brief still shows. */
    @Test
    fun malformed_entries_are_dropped_one_at_a_time() {
        val page = OmnesisJson.decodeFromString<DailyBriefItemsDto>(
            """{"day":"2026-10-14","messageId":"mb_today","futureField":{"x":1},
               "items":[
                 "not-an-item",
                 {"rank":1,"summary":"No observation id"},
                 {"observationId":"obs_ok","summary":"Kept with a default rank",
                  "sources":[{"title":"No id"},{"id":"doc_ok"},7],
                  "tasks":[{"id":"task_untitled","title":null,"state":null},{"title":"No id"}]},
                 {"rank":3,"observationId":"obs_bad_lists","summary":"Lists that are not lists",
                  "sources":{"oops":true},"tasks":"nope"}]}""",
        )
        assertEquals(listOf("obs_ok", "obs_bad_lists"), page.items.map { it.observationId })
        val kept = page.items[0]
        assertEquals(0, kept.rank)
        assertEquals(listOf("doc_ok"), kept.sources.map { it.id })
        val untitled = kept.tasks.single()
        assertEquals("", untitled.label)
        assertFalse(untitled.isResolved)
        assertTrue(page.items[1].sources.isEmpty())
        assertTrue(page.items[1].tasks.isEmpty())
    }

    /** A reaction rides on its item; an item without one reads as unreacted. */
    @Test
    fun a_reaction_reads_with_its_kind_note_and_time() {
        val page = OmnesisJson.decodeFromString<DailyBriefItemsDto>(
            """{"day":"2026-10-14","messageId":"mb_today","items":[
                 {"rank":1,"observationId":"obs_up","summary":"Liked.",
                  "reaction":{"kind":"up","at":"2026-10-14T08:00:00.000Z"}},
                 {"rank":2,"observationId":"obs_wrong","summary":"Disputed.",
                  "reaction":{"kind":"factual_error","note":"The tuner comes Friday.","at":"2026-10-14T08:01:00.000Z"}},
                 {"rank":3,"observationId":"obs_plain","summary":"Nothing said."}]}""",
        )
        val up = page.items[0].reaction!!
        assertEquals(DailyBriefReactionKind.UP, up.kindOrNull)
        assertNull(up.note)
        assertEquals("2026-10-14T08:00:00.000Z", up.at)
        val wrong = page.items[1].reaction!!
        assertEquals(DailyBriefReactionKind.FACTUAL_ERROR, wrong.kindOrNull)
        assertEquals("The tuner comes Friday.", wrong.note)
        assertNull(page.items[2].reaction)
    }

    /** A kind this build does not know keeps the item and its reaction's words; only the kind reads as unknown. */
    @Test
    fun an_unknown_reaction_kind_keeps_the_item() {
        val page = OmnesisJson.decodeFromString<DailyBriefItemsDto>(
            """{"day":"2026-10-14","messageId":"mb_today","items":[
                 {"rank":1,"observationId":"obs_new","summary":"Reacted in a way this build has not met.",
                  "reaction":{"kind":"shrug","note":"Hm.","at":"2026-10-14T08:00:00.000Z","futureField":1}}]}""",
        )
        val reaction = page.items.single().reaction!!
        assertEquals("shrug", reaction.kind)
        assertNull(reaction.kindOrNull)
        assertEquals("Hm.", reaction.note)
    }

    /** The receipt a reaction PUT answers with, with and without a reaction left standing. */
    @Test
    fun a_reaction_receipt_reads_as_the_item_reaction() {
        val set = OmnesisJson.decodeFromString<DailyBriefReactionReceiptDto>(
            """{"observationId":"obs_a","reaction":"not_interested","note":"Not my department.","at":"2026-10-14T08:00:00.000Z"}""",
        )
        assertEquals("obs_a", set.observationId)
        assertEquals(DailyBriefReactionDto("not_interested", "Not my department.", "2026-10-14T08:00:00.000Z"), set.asReaction)
        val cleared = OmnesisJson.decodeFromString<DailyBriefReactionReceiptDto>("""{"observationId":"obs_a","reaction":null}""")
        assertNull(cleared.asReaction)
    }

    @Test
    fun items_that_are_not_a_list_read_as_empty() {
        val page = OmnesisJson.decodeFromString<DailyBriefItemsDto>(
            """{"day":"2026-10-14","messageId":"mb_today","items":{"oops":true}}""",
        )
        assertTrue(page.items.isEmpty())
    }
}
