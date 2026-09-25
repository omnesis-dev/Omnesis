// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure-parser tests for the lightweight Markdown renderer (no Compose runtime needed). */
class MarkdownTest {

    @Test
    fun headings_paragraphs_and_blank_separation() {
        val blocks = parseMarkdownBlocks("# Title\n\nA paragraph line\nwrapped soft.")
        assertEquals(2, blocks.size)
        assertEquals(MdBlock.Heading(1, "Title"), blocks[0])
        assertTrue(blocks[1] is MdBlock.Paragraph)
        assertEquals("A paragraph line\nwrapped soft.", (blocks[1] as MdBlock.Paragraph).text)
    }

    @Test
    fun bullet_and_ordered_lists() {
        val blocks = parseMarkdownBlocks("- one\n- two\n\n1. first\n2. second")
        assertEquals(4, blocks.size)
        assertEquals(MdBlock.ListItem(false, "•", "one", 0), blocks[0])
        assertEquals(MdBlock.ListItem(true, "1.", "first", 0), blocks[2])
        assertEquals(MdBlock.ListItem(true, "2.", "second", 0), blocks[3])
    }

    @Test
    fun fenced_code_block_is_captured_verbatim() {
        val blocks = parseMarkdownBlocks("before\n\n```\nval x = 1\nval y = 2\n```\n\nafter")
        val code = blocks.filterIsInstance<MdBlock.Code>().single()
        assertEquals("val x = 1\nval y = 2", code.code)
    }

    @Test
    fun rule_and_blockquote() {
        val blocks = parseMarkdownBlocks("> quoted\n\n---")
        assertEquals(MdBlock.Quote("quoted"), blocks[0])
        assertEquals(MdBlock.Rule, blocks[1])
    }

    @Test
    fun inline_strips_markers_in_plain_text() {
        assertEquals("bold and italic and code", parseInline("**bold** and *italic* and `code`").text)
        assertEquals("link", parseInline("[link](https://example.com)").text)
    }

    @Test
    fun unmatched_markers_are_literal() {
        assertEquals("a * b", parseInline("a * b").text)
        assertEquals("trailing `", parseInline("trailing `").text)
    }
}
