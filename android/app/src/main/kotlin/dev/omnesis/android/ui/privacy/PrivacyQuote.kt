// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.isSpecified
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Words somebody else wrote, shown verbatim.
 *
 * A Privacy surface carries two kinds of text. Most of it is prose Omnesis wrote
 * about an exchange: labels, explanations, the sentence saying what became of an
 * answer. The rest is the exchange's own words — the request a caller made, the
 * answer the agent drafted, the reviewer's summary, the text that actually left.
 * The second kind is the evidence, and on a screen whose whole job is showing
 * what crossed the trust boundary the reader should not have to infer which is
 * which from where it sits on a card.
 *
 * So every verbatim run shares one surface and one face: an inset panel with a
 * hairline border and a small radius, holding monospaced text. Everything quoted
 * here is a recording of what some agent wrote, and one typewriter face across
 * the request, the draft, the reviewer's summary and the released text says so
 * before a word is read. The panel is deliberately not a rule down the left
 * margin: the left edge of these screens already means which side of the
 * boundary you are on, and a second vertical line there would compete with the
 * spine.
 */
internal object PrivacyQuoteStyle {
    val radius = OmRadius.small

    /**
     * Prose is inset from the panel on every side, so the quoted words sit in
     * their own air rather than against the border.
     */
    val insets = PaddingValues(OmSpacing.sm)

    /**
     * The comparison's rows carry a full-width tint that says which side of the
     * diff they belong to, so the panel gives them vertical air only and lets
     * the tint run to its edges.
     */
    val bleedInsets = PaddingValues(vertical = OmSpacing.xs)

    /**
     * How far a quote's text sits below the size its surroundings use.
     *
     * A monospaced face sets wider than the body face at the same nominal size,
     * so a quote set at parity reads heavier than the prose around it — the
     * opposite of what a quotation should do. The step gives back the weight
     * without making the words hard to read.
     */
    const val SIZE_SCALE = 0.88f
}

private fun TextUnit.steppedDown(): TextUnit =
    if (isSpecified) this * PrivacyQuoteStyle.SIZE_SCALE else this

/**
 * The face and size a quotation takes, given the prose it sits among. Line
 * height steps down with the size so the quoted paragraph keeps the leading
 * ratio of the text around it.
 */
internal fun privacyQuoteTextStyle(base: TextStyle): TextStyle = base.copy(
    fontFamily = FontFamily.Monospace,
    fontSize = base.fontSize.steppedDown(),
    lineHeight = base.lineHeight.steppedDown(),
)

/**
 * Draw this content as a quotation: text that came from outside this screen's
 * own voice, reproduced exactly.
 *
 * @param tint replaces the neutral fill. Used for an answer held pending a
 *   decision, where the wash is the hold rather than the quotation.
 */
@Composable
internal fun Modifier.privacyQuoteSurface(
    tint: Color? = null,
    insets: PaddingValues = PrivacyQuoteStyle.insets,
): Modifier {
    val tones = privacyTones()
    val shape = RoundedCornerShape(PrivacyQuoteStyle.radius)
    return this
        .fillMaxWidth()
        .background(tint ?: tones.quoteFill, shape)
        .border(1.dp, tones.quoteBorder, shape)
        .clip(shape)
        .padding(insets)
}

/**
 * One quoted sentence or paragraph: the request a caller made, the reviewer's
 * summary of what it found.
 *
 * It is short enough to be one utterance, and hearing "quoted" first is the only
 * cue a listener gets that these are not Omnesis's words — so the whole panel is
 * a single node carrying its role before its text, rather than a tint a screen
 * reader never receives.
 *
 * @param role what a listener hears this quote called before they hear the words.
 * @param style the prose this quote sits among; the quote is set a step below it.
 */
@Composable
internal fun PrivacyQuote(
    text: String,
    role: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
) {
    Text(
        text,
        style = privacyQuoteTextStyle(style),
        color = OmTheme.colors.textPrimary,
        modifier = modifier
            .privacyQuoteSurface()
            .clearAndSetSemantics { contentDescription = "Quoted $role: $text" },
    )
}

/**
 * An answer, on the surfaces allowed to show one: the draft still inside the
 * machine, the answer held pending a decision, the text that left. Rendered as
 * markdown, because that is what an agent writes an answer in — headings
 * included, which take the quote's face so an answer carrying one does not read
 * in two faces at once.
 *
 * A container announces a label of its own only when it merges what is inside
 * it, so the block is one node: a listener hears what this is a quotation of
 * before hearing any of it, instead of meeting an unattributed wall of prose.
 *
 * @param role what a listener hears this answer called before they hear it.
 * @param style the prose this answer sits among; the answer is set a step below it.
 * @param tint replaces the neutral fill, for an answer held pending a decision.
 */
@Composable
internal fun PrivacyAnswerBlock(
    answer: String,
    role: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    tint: Color? = null,
) {
    MarkdownText(
        answer,
        style = privacyQuoteTextStyle(style),
        color = OmTheme.colors.textPrimary,
        headingFontFamily = FontFamily.Monospace,
        modifier = modifier
            .privacyQuoteSurface(tint = tint)
            .semantics(mergeDescendants = true) { contentDescription = "Quoted $role: $answer" },
    )
}

/**
 * The colour an answer held pending a decision is washed in. The wash is the
 * hold, not the quotation, so it replaces the quote surface's neutral fill
 * rather than stacking on it.
 */
@Composable
internal fun privacyHeldAnswerTint(): Color = OmTheme.colors.warning.copy(alpha = 0.08f)
