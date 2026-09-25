// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The conversation list's unread flag on the wire.
 *
 * All fixture data is invented.
 */
class ConversationUnreadDecodeTest {

    @Test
    fun unread_conversation_decodes_as_unread() {
        val page = OmnesisJson.decodeFromString<ConversationsResponse>(
            """{"conversations":[{"id":"conv_a","title":"Permit decision","unread":true}],""" +
                """"nextCursor":null}""",
        )
        assertEquals(1, page.conversations.size)
        assertTrue(page.conversations[0].unread)
    }

    @Test
    fun conversation_without_the_field_decodes_as_read() {
        // A gateway that predates read state omits it entirely; the phone must
        // show no dot rather than failing to decode the list at all.
        val page = OmnesisJson.decodeFromString<ConversationsResponse>(
            """{"conversations":[{"id":"conv_a","title":"Permit decision"}],"nextCursor":null}""",
        )
        assertFalse(page.conversations[0].unread)
    }

    @Test
    fun unknown_fields_do_not_break_the_list() {
        val page = OmnesisJson.decodeFromString<ConversationsResponse>(
            """{"conversations":[{"id":"conv_a","unread":true,"somethingNewer":42}],""" +
                """"nextCursor":"cursor-1"}""",
        )
        assertTrue(page.conversations[0].unread)
        assertEquals("cursor-1", page.nextCursor)
    }
}
