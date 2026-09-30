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
        assertEquals("val x = 1\nval y = 2\n", code.code)
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
    @Test
    fun copy_spans_use_commonmark_delimiters_and_whitespace() {
        val text = parseInline("Use `` A`B `` or ` 0012  34 ` and `first\nsecond`.")
        assertEquals("Use A`B or 0012  34 and first second.", text.text)
        assertEquals(listOf("A`B", "0012  34", "first second"),
            text.getStringAnnotations(CopyCodeAnnotation, 0, text.length).map { it.item })
        assertEquals("   ", parseInline("`   `").text)
        assertEquals("``unfinished`", parseInline("``unfinished`").text)
    }

    @Test
    fun copy_controls_preserve_links_and_nested_styles_and_can_be_disabled() {
        val text = parseInline("[Map](https://example.com) **`0012`** then `0012`.")
        val copied = inlineCopyText(text, true)
        assertEquals("Map 0012\uFFFC then 0012\uFFFC.", copied.text)
        assertEquals(text.getLinkAnnotations(0, 3), copied.getLinkAnnotations(0, 3))
        assertEquals(text, inlineCopyText(text, false))
        assertEquals(2, copied.getStringAnnotations(CopyCodeAnnotation, 0, copied.length).size)
    }

    @Test
    fun fences_preserve_blank_lines_spaces_and_require_a_matching_close() {
        val closed = parseMarkdownBlocks("````text\n\n42 Example Street  \n```\nExampleville\n````").single() as MdBlock.Code
        assertEquals("\n42 Example Street  \n```\nExampleville\n", closed.code)
        assertTrue(closed.closed)
        val open = parseMarkdownBlocks("~~~\n0012\n```").single() as MdBlock.Code
        assertEquals("0012\n```", open.code)
        assertEquals(false, open.closed)
    }

    @Test
    fun escaped_backticks_stay_literal_but_code_inside_emphasis_and_links_is_copyable() {
        val escaped = parseInline("\\`literal\\`")
        assertEquals("`literal`", escaped.text)
        assertTrue(escaped.getStringAnnotations(CopyCodeAnnotation, 0, escaped.length).isEmpty())
        val nested = parseInline("*`0012`* [**`A12`**](https://example.org)")
        assertEquals("0012 A12", nested.text)
        assertEquals(listOf("0012", "A12"), nested.getStringAnnotations(CopyCodeAnnotation, 0, nested.length).map { it.item })
        assertEquals(1, inlineCopyText(nested, true).getLinkAnnotations(6, 9).size)
    }

}
