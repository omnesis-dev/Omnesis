// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.sse

import org.junit.Assert.assertEquals
import org.junit.Test

class SSEFrameParserTest {

    private fun feed(parser: SSEFrameParser, s: String): List<String> =
        feedFrames(parser, s).map { it.data }

    private fun feedFrames(parser: SSEFrameParser, s: String): List<SSEFrame> {
        val out = mutableListOf<SSEFrame>()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            parser.consume(b.toInt() and 0xFF)?.let { out.add(it) }
        }
        return out
    }

    @Test
    fun single_data_line_frame() {
        assertEquals(listOf("""{"a":1}"""), feed(SSEFrameParser(), "data: {\"a\":1}\n\n"))
    }

    @Test
    fun comment_heartbeat_is_ignored() {
        assertEquals(listOf("x"), feed(SSEFrameParser(), ": hb\n\ndata: x\n\n"))
    }

    @Test
    fun multiple_data_lines_join_with_newline() {
        assertEquals(listOf("a\nb"), feed(SSEFrameParser(), "data: a\ndata: b\n\n"))
    }

    @Test
    fun crlf_line_endings_handled() {
        assertEquals(listOf("x"), feed(SSEFrameParser(), "data: x\r\n\r\n"))
    }

    @Test
    fun frame_split_across_chunks() {
        val parser = SSEFrameParser()
        val out = mutableListOf<String>()
        out += feed(parser, "data: {\"hel")
        out += feed(parser, "lo\":1}\n\n")
        assertEquals(listOf("""{"hello":1}"""), out)
    }

    @Test
    fun multibyte_utf8_not_split_on_lf() {
        // A multi-byte char's bytes never contain 0x0A, so the line decodes whole.
        assertEquals(listOf("héllo"), feed(SSEFrameParser(), "data: héllo\n\n"))
    }

    @Test
    fun id_line_is_captured_on_the_frame() {
        val frames = feedFrames(SSEFrameParser(), "id: 7\ndata: x\n\n")
        assertEquals(listOf("x"), frames.map { it.data })
        assertEquals(listOf("7"), frames.map { it.id })
    }

    @Test
    fun id_persists_across_frames_until_changed() {
        // Per the SSE spec the last `id:` carries forward to later frames that omit
        // one — so a control frame (e.g. agent.resync, no id) keeps the prior id.
        val frames = feedFrames(SSEFrameParser(), "id: 3\ndata: a\n\ndata: b\n\nid: 5\ndata: c\n\n")
        assertEquals(listOf("a", "b", "c"), frames.map { it.data })
        assertEquals(listOf("3", "3", "5"), frames.map { it.id })
    }

    @Test
    fun frame_before_any_id_has_null_id() {
        val frames = feedFrames(SSEFrameParser(), "data: x\n\n")
        assertEquals(listOf<String?>(null), frames.map { it.id })
    }
}
