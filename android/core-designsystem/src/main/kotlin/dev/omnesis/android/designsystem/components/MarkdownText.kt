// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * A lightweight Markdown renderer for agent/assistant text. Supports the subset the
 * harness actually emits — headings, bold/italic, inline code + fenced code blocks,
 * bullet/ordered lists, blockquotes, horizontal rules, and links — without pulling in a
 * heavyweight multiplatform parser. Block parsing is memoised on the source string so
 * streaming re-composition stays cheap.
 *
 * The inline scanner ([parseInline]) and block splitter ([parseMarkdownBlocks]) are pure
 * and unit-tested; only the rendering is Compose.
 */
@Composable
fun MarkdownText(
    markdown: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    style: TextStyle = LocalTextStyle.current,
    /**
     * The face headings are set in. Headings size themselves off their level
     * rather than off [style], so a caller setting the body in a non-default
     * face passes the face here too and the block reads as one rather than
     * splitting into two typefaces at every heading.
     */
    headingFontFamily: FontFamily? = null,
) {
    val blocks = remember(markdown) { parseMarkdownBlocks(markdown) }
    val linkColor = MaterialTheme.colorScheme.primary
    Column(modifier) {
        blocks.forEachIndexed { i, block ->
            if (i > 0) Spacer(Modifier.padding(top = blockGap(block)))
            when (block) {
                is MdBlock.Heading -> Text(
                    text = parseInline(block.text, linkColor),
                    style = headingStyle(block.level).let {
                        if (headingFontFamily == null) it else it.copy(fontFamily = headingFontFamily)
                    },
                    color = color,
                )

                is MdBlock.Paragraph -> Text(
                    text = parseInline(block.text, linkColor),
                    style = style,
                    color = color,
                )

                is MdBlock.ListItem -> Row(Modifier.fillMaxWidth()) {
                    Spacer(Modifier.width((12 * block.indent).dp))
                    Text(block.marker, style = style, color = OmTheme.colors.textMuted)
                    Spacer(Modifier.width(6.dp))
                    Text(parseInline(block.text, linkColor), style = style, color = color)
                }

                is MdBlock.Code -> Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = block.code,
                        style = style.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.padding(10.dp),
                    )
                }

                is MdBlock.Quote -> Row(Modifier.fillMaxWidth()) {
                    Surface(
                        color = OmTheme.colors.borderLight,
                        modifier = Modifier.width(3.dp).padding(end = 0.dp),
                    ) { Spacer(Modifier.width(3.dp)) }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = parseInline(block.text, linkColor),
                        style = style.copy(fontStyle = FontStyle.Italic),
                        color = OmTheme.colors.textSecondary,
                    )
                }

                is MdBlock.Table -> MarkdownTable(block, style, color, linkColor)

                MdBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 2.dp))
            }
        }
    }
}

/**
 * A GFM table rendered as a fixed-column grid wrapped in a horizontal scroll, so a wide
 * table clips to the viewport rather than widening the whole transcript (the iOS
 * SQL-card approach). The header row is emphasised; rows are separated by hairlines.
 */
@Composable
private fun MarkdownTable(table: MdBlock.Table, baseStyle: TextStyle, color: Color, linkColor: Color) {
    val cols = maxOf(table.headers.size, table.rows.maxOfOrNull { it.size } ?: 0).coerceAtLeast(1)
    val border = MaterialTheme.colorScheme.outlineVariant
    Column(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, border, RoundedCornerShape(8.dp))
            .horizontalScroll(rememberScrollState()),
    ) {
        TableRowView(table.headers, cols, baseStyle.copy(fontWeight = FontWeight.SemiBold), color, linkColor, MaterialTheme.colorScheme.surfaceVariant)
        table.rows.forEach { row ->
            HorizontalDivider(color = border)
            TableRowView(row, cols, baseStyle, color, linkColor, Color.Transparent)
        }
    }
}

@Composable
private fun TableRowView(cells: List<String>, cols: Int, style: TextStyle, color: Color, linkColor: Color, bg: Color) {
    Row(Modifier.background(bg)) {
        for (c in 0 until cols) {
            Text(
                text = parseInline(cells.getOrElse(c) { "" }, linkColor),
                style = style,
                color = color,
                modifier = Modifier.width(TableCellWidth).padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
    }
}

private val TableCellWidth: Dp = 124.dp

@Composable
private fun headingStyle(level: Int): TextStyle = when (level) {
    1 -> MaterialTheme.typography.titleLarge
    2 -> MaterialTheme.typography.titleMedium
    else -> MaterialTheme.typography.titleSmall
}.copy(fontWeight = FontWeight.SemiBold)

private fun blockGap(block: MdBlock) = when (block) {
    // iOS renders a list as one block with VStack(spacing: 4) between items;
    // here each item is its own block, so the gap between consecutive items is 4.dp.
    is MdBlock.ListItem -> 4.dp
    // iOS MarkdownView stacks blocks with VStack(spacing: 10).
    else -> 10.dp
}

// --- pure parsing (unit-tested) ---

sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class ListItem(val ordered: Boolean, val marker: String, val text: String, val indent: Int) : MdBlock
    data class Code(val code: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
    data object Rule : MdBlock
}

private val ORDERED = Regex("""^(\s*)(\d+)[.)]\s+(.*)$""")
private val BULLET = Regex("""^(\s*)[-*+]\s+(.*)$""")
private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")
private val TABLE_SEP_CELL = Regex("""^:?-+:?$""")

/** A GFM table separator row: pipe-delimited cells of dashes (with optional `:` alignment). */
private fun isTableSeparator(line: String): Boolean {
    val t = line.trim()
    if (!t.contains("|") || !t.contains("-")) return false
    val cells = splitTableRow(line)
    return cells.isNotEmpty() && cells.all { TABLE_SEP_CELL.matches(it.replace(" ", "")) }
}

/** Split a GFM table row into trimmed cells, dropping the optional leading/trailing pipes. */
private fun splitTableRow(line: String): List<String> {
    var s = line.trim()
    if (s.startsWith("|")) s = s.substring(1)
    if (s.endsWith("|")) s = s.dropLast(1)
    return s.split("|").map { it.trim() }
}

/** Split a Markdown source into block-level elements. Soft-wraps inside a paragraph are preserved. */
fun parseMarkdownBlocks(md: String): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val lines = md.replace("\r\n", "\n").split("\n")
    val paragraph = StringBuilder()

    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            out.add(MdBlock.Paragraph(paragraph.toString().trimEnd('\n')))
            paragraph.clear()
        }
    }

    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()

        // Fenced code block
        if (trimmed.startsWith("```")) {
            flushParagraph()
            val body = StringBuilder()
            i++
            while (i < lines.size && !lines[i].trim().startsWith("```")) {
                if (body.isNotEmpty()) body.append('\n')
                body.append(lines[i])
                i++
            }
            i++ // consume closing fence (if present)
            out.add(MdBlock.Code(body.toString()))
            continue
        }

        if (trimmed.isEmpty()) {
            flushParagraph()
            i++
            continue
        }

        if (trimmed == "---" || trimmed == "***" || trimmed == "___") {
            flushParagraph()
            out.add(MdBlock.Rule)
            i++
            continue
        }

        val heading = HEADING.matchEntire(line)
        if (heading != null) {
            flushParagraph()
            out.add(MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2].trim()))
            i++
            continue
        }

        val bullet = BULLET.matchEntire(line)
        if (bullet != null) {
            flushParagraph()
            val indent = bullet.groupValues[1].length / 2
            out.add(MdBlock.ListItem(ordered = false, marker = "•", text = bullet.groupValues[2].trim(), indent = indent))
            i++
            continue
        }

        val ordered = ORDERED.matchEntire(line)
        if (ordered != null) {
            flushParagraph()
            val indent = ordered.groupValues[1].length / 2
            out.add(MdBlock.ListItem(ordered = true, marker = "${ordered.groupValues[2]}.", text = ordered.groupValues[3].trim(), indent = indent))
            i++
            continue
        }

        if (trimmed.startsWith(">")) {
            flushParagraph()
            out.add(MdBlock.Quote(trimmed.removePrefix(">").trim()))
            i++
            continue
        }

        // GFM table: a pipe-bearing header row immediately followed by a `---|---`
        // separator row. Subsequent pipe rows are the body until a blank/non-pipe line.
        if (trimmed.contains("|") && i + 1 < lines.size && isTableSeparator(lines[i + 1])) {
            flushParagraph()
            val headers = splitTableRow(line)
            i += 2 // consume header + separator
            val rows = mutableListOf<List<String>>()
            while (i < lines.size && lines[i].trim().isNotEmpty() && lines[i].contains("|")) {
                rows.add(splitTableRow(lines[i]))
                i++
            }
            out.add(MdBlock.Table(headers, rows))
            continue
        }

        if (paragraph.isNotEmpty()) paragraph.append('\n')
        paragraph.append(trimmed)
        i++
    }
    flushParagraph()
    return out
}

private val INLINE_LINK = Regex("""\[([^\]]+)]\(([^)\s]+)\)""")

/**
 * Render inline Markdown spans (bold, italic, inline code, links) into an [AnnotatedString].
 * A single left-to-right pass; unmatched markers are emitted literally so partial streamed
 * tokens never throw.
 */
fun parseInline(text: String, linkColor: Color = Color.Unspecified): AnnotatedString = buildAnnotatedString {
    var i = 0
    val n = text.length
    while (i < n) {
        val c = text[i]
        when {
            c == '`' -> {
                val end = text.indexOf('`', i + 1)
                if (end > i) {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = CodeBg)) {
                        append(text.substring(i + 1, end))
                    }
                    i = end + 1
                } else {
                    append(c); i++
                }
            }

            c == '*' && i + 1 < n && text[i + 1] == '*' -> {
                val end = text.indexOf("**", i + 2)
                if (end > i) {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(parseInline(text.substring(i + 2, end), linkColor)) }
                    i = end + 2
                } else {
                    append(c); i++
                }
            }

            (c == '*' || c == '_') -> {
                val end = text.indexOf(c, i + 1)
                if (end > i && end != i + 1) {
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(text.substring(i + 1, end)) }
                    i = end + 1
                } else {
                    append(c); i++
                }
            }

            c == '[' -> {
                val m = INLINE_LINK.matchAt(text, i)
                if (m != null) {
                    val label = m.groupValues[1]
                    val url = m.groupValues[2]
                    withLink(LinkAnnotation.Url(url)) {
                        withStyle(SpanStyle(color = linkColor, fontWeight = FontWeight.Medium)) { append(label) }
                    }
                    i = m.range.last + 1
                } else {
                    append(c); i++
                }
            }

            else -> {
                append(c); i++
            }
        }
    }
}

private val CodeBg = Color(0x1F808080)
