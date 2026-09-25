// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.PrivacyAnswerComparison
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffLine
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffOp

/**
 * The released answer set against the draft it came from, inside the technical
 * record.
 *
 * Which side a line is on is carried three ways at once — a gutter mark, a
 * typeface decoration on the runs that actually changed, and a tone — because
 * this reads on a phone, in monochrome, and aloud. The gutter is the primary
 * channel: `−` for the draft, `+` for what was shared, so nothing depends on
 * telling two tints apart. Struck-through and underlined runs then show the edit
 * inside a line, which is also what makes a change to whitespace alone visible:
 * the decoration is drawn over the spaces themselves.
 *
 * The tints are the comparison's own pair, [PrivacyTonePalette.diffRemoved] and
 * [PrivacyTonePalette.diffAdded] — a neutral against a violet. They sit outside
 * the outcome family on purpose: an outcome colour here would read as a verdict
 * on a line rather than as which text went, and the red/green a diff usually
 * wears is the one pair a red-green colour-blind reader cannot separate.
 *
 * It is quoted text, so the lines sit on the section's shared quotation surface
 * and this block reads as one of the exchange's own texts rather than as a
 * widget of its own. Only the markers, the per-line tints and the monospace
 * grid belong to it; the panel under them is the one the request and the
 * answers are drawn on. Here the fixed-width face is also load-bearing: the
 * marker column and the spans inside a line stay aligned only if every
 * character occupies the same width, so these rows set their own size rather
 * than stepping down from the prose around them.
 */
@Composable
internal fun PrivacyAnswerComparisonBlock(
    comparison: PrivacyAnswerComparison,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    when (comparison) {
        // The gateway leaves the release step no body of its own in this case,
        // so this line is the whole statement rather than a second printing of
        // an answer the record already carries.
        PrivacyAnswerComparison.Identical -> Text(
            "This went out exactly as drafted.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            modifier = modifier,
        )

        is PrivacyAnswerComparison.NoDiff -> Text(
            noDiffNote(comparison.reason),
            style = MaterialTheme.typography.labelSmall,
            color = c.textMuted,
            modifier = modifier,
        )

        is PrivacyAnswerComparison.Diff -> Column(
            modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        ) {
            Text(
                "Compared with the draft",
                style = MaterialTheme.typography.labelMedium,
                color = c.textPrimary,
                // A listener meets this heading before the rows below it, and
                // it is where they are told the rows are a quotation — the
                // surface under them says so only to someone who can see it.
                modifier = Modifier.semantics {
                    contentDescription = "Quoted comparison of the draft and what was shared"
                },
            )
            Text(
                "−  draft only        +  shared answer",
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = c.textMuted,
                // The marks are typographic. Spelled out, the legend still says
                // what each one means to a reader who never sees them.
                modifier = Modifier.semantics {
                    contentDescription =
                        "Lines marked minus were in the draft only. " +
                        "Lines marked plus are in the shared answer."
                },
            )
            // Both sides of the comparison are text the machine produced,
            // quoted line by line — so it wears the same panel as every other
            // quotation here, with its rows left free to run to the edges.
            Column(Modifier.privacyQuoteSurface(insets = PrivacyQuoteStyle.bleedInsets)) {
                comparison.lines.forEach { PrivacyAnswerDiffRow(it) }
            }
        }
    }
}

/**
 * One compared line. The whole row is a single node to a screen reader, so the
 * side is announced before the text instead of being left in the gutter mark and
 * the tint, which a reader listening to the record never receives.
 */
@Composable
private fun PrivacyAnswerDiffRow(line: PrivacyAnswerDiffLine) {
    val c = OmTheme.colors
    val tones = privacyTones()
    val mark = when (line.op) {
        PrivacyAnswerDiffOp.EQUAL -> " "
        PrivacyAnswerDiffOp.REMOVED -> "−"
        PrivacyAnswerDiffOp.ADDED -> "+"
    }
    val tone = when (line.op) {
        PrivacyAnswerDiffOp.EQUAL -> c.textSecondary
        PrivacyAnswerDiffOp.REMOVED -> tones.diffRemoved
        PrivacyAnswerDiffOp.ADDED -> tones.diffAdded
    }
    val rowBackground = when (line.op) {
        PrivacyAnswerDiffOp.EQUAL -> Color.Transparent
        PrivacyAnswerDiffOp.REMOVED -> tones.diffRemovedBg
        PrivacyAnswerDiffOp.ADDED -> tones.diffAddedBg
    }
    Row(
        Modifier
            .fillMaxWidth()
            .background(rowBackground)
            .padding(horizontal = OmSpacing.sm, vertical = 1.dp)
            .clearAndSetSemantics { contentDescription = answerDiffLineDescription(line) },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        Text(
            mark,
            style = MaterialTheme.typography.bodySmall.copy(
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
            ),
            color = tone,
            modifier = Modifier.width(10.dp),
        )
        Text(
            answerDiffLineText(line, tone),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = tone,
            // No maxLines: a long line wraps into the gutter's column rather
            // than running off the side of a phone.
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * The line as drawn: whole when it has no counterpart, and otherwise with the
 * runs that changed struck through (gone from the draft) or underlined (new in
 * the shared answer).
 */
private fun answerDiffLineText(line: PrivacyAnswerDiffLine, tone: Color) = buildAnnotatedString {
    val spans = line.spans
    if (spans == null) {
        append(line.text)
        return@buildAnnotatedString
    }
    val decoration = if (line.op == PrivacyAnswerDiffOp.REMOVED) {
        TextDecoration.LineThrough
    } else {
        TextDecoration.Underline
    }
    spans.forEach { span ->
        if (span.op == PrivacyAnswerDiffOp.EQUAL) {
            append(span.text)
        } else {
            withStyle(
                SpanStyle(
                    color = tone,
                    // The wash is what gives a run of changed whitespace a
                    // shape; the decoration over it is what survives losing the
                    // colour.
                    background = tone.copy(alpha = 0.18f),
                    fontWeight = FontWeight.Bold,
                    textDecoration = decoration,
                ),
            ) {
                append(span.text)
            }
        }
    }
}

/**
 * What a screen reader hears for one line. The side comes first, then the line,
 * then the runs that changed — spoken as "spacing" when they hold no words, so a
 * reduction that removed only whitespace is still announced as a change instead
 * of two identical-sounding lines.
 */
internal fun answerDiffLineDescription(line: PrivacyAnswerDiffLine): String {
    val lead = when (line.op) {
        PrivacyAnswerDiffOp.EQUAL -> "Unchanged"
        PrivacyAnswerDiffOp.REMOVED -> "Removed from the draft"
        PrivacyAnswerDiffOp.ADDED -> "Added in the shared answer"
    }
    val changed = line.spans.orEmpty().filter { it.op != PrivacyAnswerDiffOp.EQUAL }
    val head = "$lead: ${spokenLine(line.text)}"
    if (changed.isEmpty()) return head
    // A line usually ends in its own punctuation; a second full stop after it
    // is read as an extra pause.
    val separator = if (head.last() in SENTENCE_ENDINGS) " " else ". "
    return head + separator + "Changed: " + changed.joinToString("; ") { spokenChange(it.text) }
}

private const val SENTENCE_ENDINGS = ".?!:;,"

private fun spokenLine(text: String): String = when {
    text.isEmpty() -> "blank line"
    text.isBlank() -> "spacing only"
    else -> text
}

/** Surrounding spaces belong to the line, not to what changed inside it. */
private fun spokenChange(text: String): String = text.trim().ifEmpty { "spacing" }

/**
 * Why there is no line-by-line comparison. Both reasons are facts about what
 * Omnesis compared, not about what the answer said — a comparison it declined to
 * draw is not a finding about the content.
 */
internal fun noDiffNote(reason: PrivacyAnswerComparison.NoDiff.Reason): String = when (reason) {
    PrivacyAnswerComparison.NoDiff.Reason.DISSIMILAR ->
        "Omnesis did not present this as an edit of the draft, so there is no line-by-line comparison here."
    PrivacyAnswerComparison.NoDiff.Reason.TOO_LARGE ->
        "These answers were too long to compare, so there is no line-by-line comparison here."
}

/**
 * True when the comparison already carries the released text line by line, so a
 * step printing its own copy of it would show the same words twice.
 */
internal fun answerComparisonReplacesStepText(comparison: PrivacyAnswerComparison?): Boolean =
    comparison is PrivacyAnswerComparison.Diff
