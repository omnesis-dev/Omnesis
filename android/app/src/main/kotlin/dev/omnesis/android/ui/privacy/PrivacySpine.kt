// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmFailureDetailLine
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.ui.common.TimeFormat

/**
 * One exchange, told as a spine: who asked, what Omnesis drafted, what the
 * privacy check decided.
 *
 * The trust boundary is drawn rather than described. Each band of the story owns
 * one unbroken vertical rail at the same x, so the left edge alone reads as a
 * single line: dashed outside the machine, a labelled hairline at the edge,
 * solid and accent-coloured alongside the cards inside, then — only when
 * something actually left — a second hairline and dashed again. Inside/outside
 * is the whole point of this screen, and it can be seen without reading a word.
 */

private val RAIL_X = 7.dp
private val RAIL_GUTTER = 22.dp

/**
 * The band a crossing occupies, with its rule centred in it. No rail is drawn
 * inside this band at all, so every rail stops half this height clear of the
 * rule it runs into: a crossing is a mark of its own and keeps clear air on
 * both sides rather than being run into. The clearance is several times the gap
 * between two dashes, which is what makes the stop read as deliberate instead
 * of as a stutter in the pattern.
 */
private val BOUNDARY_HEIGHT = 30.dp

/**
 * One width for every band. The reader is meant to compare a dash pattern
 * against a solid line, and a muted grey against the accent — not a thin line
 * against a thick one, which reads as one of them mattering more.
 */
private val RAIL_WIDTH = 3.dp

private data class PrivacyRail(val color: Color, val dashed: Boolean)

@Composable
private fun outsideRail(): PrivacyRail = PrivacyRail(privacyTones().rail, dashed = true)

@Composable
private fun insideRail(): PrivacyRail = PrivacyRail(privacyTones().railInside, dashed = false)

private fun DrawScope.drawPrivacyRail(rail: PrivacyRail) {
    val x = RAIL_X.toPx()
    val width = RAIL_WIDTH.toPx()
    drawLine(
        color = rail.color,
        start = Offset(x, 0f),
        end = Offset(x, size.height),
        strokeWidth = width,
        // A round cap on a dash would swell each one into a lozenge and close
        // the gaps the pattern exists to show.
        cap = StrokeCap.Butt,
        pathEffect = if (rail.dashed) {
            PathEffect.dashPathEffect(floatArrayOf(width * 2f, width * 2.2f))
        } else {
            null
        },
    )
}

/**
 * One band of the story, carrying the stretch of rail beside it. The line is
 * drawn on the band rather than between the cards, so it cannot break in a gap.
 */
@Composable
private fun PrivacyZone(
    rail: PrivacyRail,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .drawBehind { drawPrivacyRail(rail) }
            .padding(start = RAIL_GUTTER),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        content = content,
    )
}

/** The edge itself: a labelled rule, with the spine stopping clear either side of it. */
@Composable
private fun PrivacyBoundaryLine(label: String) {
    val c = OmTheme.colors
    val hairline = privacyTones().hairline
    Box(
        Modifier
            .fillMaxWidth()
            .height(BOUNDARY_HEIGHT),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            HorizontalDivider(Modifier.weight(1f), color = hairline)
            Text(
                label.uppercase(),
                style = MaterialTheme.typography.labelSmall.copy(
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 1.sp,
                ),
                color = c.textMuted,
                // The all-caps rendering is typographic. Read aloud it becomes
                // an initialism, so the boundary is announced as written.
                modifier = Modifier.semantics { contentDescription = label },
            )
            HorizontalDivider(Modifier.weight(1f), color = hairline)
        }
    }
}

/**
 * A dashed rounded outline. The card outside the boundary is drawn the way its
 * rail is — provisionally — so the two agree about which side it is on.
 */
private fun Modifier.dashedOutline(color: Color) = drawBehind {
    val radius = CornerRadius(OmRadius.large.toPx())
    val stroke = 1.dp.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset(stroke / 2f, stroke / 2f),
        size = Size(size.width - stroke, size.height - stroke),
        cornerRadius = radius,
        style = Stroke(
            width = stroke,
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
        ),
    )
}

@Composable
private fun PrivacyCardHead(
    kind: PrivacyActorKind,
    label: String,
    at: Long?,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        PrivacyActor(kind, label, Modifier.weight(1f))
        if (at != null && at > 0) {
            Text(
                TimeFormat.relative(at),
                style = MaterialTheme.typography.labelSmall,
                color = OmTheme.colors.textMuted,
                maxLines = 1,
            )
        }
    }
}

/** One fact the caller states about itself, label beside value. */
@Composable
private fun PrivacyFact(label: String, value: String) {
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = c.textMuted,
            modifier = Modifier.width(96.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.labelSmall,
            color = c.textSecondary,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun modelLine(event: PrivacyAuditEventSummary?): String? =
    listOfNotNull(event?.display?.provider, event?.display?.model)
        .filter { it.isNotBlank() }
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" / ")

private fun firstEventOfKind(events: List<PrivacyAuditEventSummary>, kind: String) =
    events.firstOrNull { it.kind == kind }

private val SHARED_OUTCOMES = setOf("shared", "shared_with_reductions")

/**
 * The whole exchange as one column of moments, in ledger order.
 *
 * [events] is the exchange's own slice of the audit ledger. It supplies the
 * order, the instants, the models, and every step that is not one of the three
 * landmarks — so this composable decides prominence and zone, and nothing else.
 *
 * The portal puts each instant in a gutter to the left of the rail, where the
 * times line up as a scale. A phone has no room for a column beside the rail
 * without taking a quarter of the line length off every card, so here the
 * instant sits above the thing it stamps.
 */
@Composable
internal fun PrivacyExchangeSpine(
    exchange: PrivacyExchangePresentation,
    events: List<PrivacyAuditEventSummary>,
    modifier: Modifier = Modifier,
    busy: String? = null,
    actionError: String? = null,
    onApprove: () -> Unit = {},
    onDeny: () -> Unit = {},
    onOpenPolicy: PrivacyPolicyOpener? = null,
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (canonicalId: String, name: String?) -> Unit = { _, _ -> },
    onOpenUrl: (String) -> Unit = {},
    catalog: SourceCatalog = SourceCatalog(),
) {
    val c = OmTheme.colors
    val agentName = externalAgentNarrativeName(exchange.externalAgent)
    val shared = exchange.outcome in SHARED_OUTCOMES
    val order = remember(exchange, events) { privacySpineOrder(exchange, events) }
    val receivedAt = order.released?.createdAt ?: exchange.sharedAt
    // Whether anything crossed back out: an answer that was released, one that
    // was collected, or a step recorded after the release. The crossing is
    // drawn when the ledger says something crossed — an answer the operator
    // approved but the caller has not collected has a release step and no
    // receipt, and dropping the whole band on that state would take the
    // release, and every step after it, off the one screen that accounts for
    // what left.
    val released = shared || order.released != null || order.afterRelease.isNotEmpty()

    // The instant a card carries when no step recorded one. Only the decision
    // card has a second source for it.
    fun momentAt(moment: PrivacySpineMoment): Long? = moment.event?.createdAt
        ?: (exchange.resolvedAt.takeIf { moment is PrivacySpineMoment.Check })

    val dayBreaks = remember(order, receivedAt) {
        privacyDayBreaks(
            buildList {
                add("asked" to order.askedAt)
                order.inside.forEach { add(it.key to momentAt(it)) }
                if (released) add("received" to receivedAt)
                order.afterRelease.forEach { add(it.id to it.createdAt) }
            },
        )
    }

    Column(modifier.fillMaxWidth()) {
        PrivacyZone(rail = outsideRail()) {
            PrivacyMoment(at = order.askedAt, showsDay = "asked" in dayBreaks) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .dashedOutline(c.border)
                        .padding(OmSpacing.md),
                    verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                ) {
                    // No instant on the head: the moment above already states
                    // it, and a second copy of the same time reads as two
                    // events rather than one.
                    PrivacyCardHead(PrivacyActorKind.EXTERNAL, "$agentName asked", null)
                    if (exchange.question.isNotBlank()) {
                        PrivacyQuote(
                            exchange.question,
                            role = "question",
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    } else {
                        // Omnesis saying it has nothing to show is not the
                        // caller's words, so it stays prose.
                        Text(
                            "No question was recorded.",
                            style = MaterialTheme.typography.bodyLarge,
                            color = c.textMuted,
                        )
                    }
                    // The caller's own account of itself, under a rule that
                    // separates its claims from the question above them.
                    HorizontalDivider(color = c.borderLight)
                    // The full name, registry slug and all — the story above
                    // says "Atlas", and this answers "Atlas which?".
                    val principal = exchange.externalAgent.source == "principal"
                    PrivacyFact(
                        if (principal) "Principal" else "Caller",
                        externalAgentName(exchange.externalAgent),
                    )
                    exchange.externalAgent.connectionName?.trim()?.takeIf { it.isNotEmpty() }?.let {
                        PrivacyFact("Connection", it)
                    }
                    PrivacyFact("Workflow", exchange.workflow.name.ifBlank { "Unnamed workflow" })
                    PrivacyFact(
                        "Stated purpose",
                        exchange.workflow.purpose.ifBlank { "None supplied." },
                    )
                }
            }
            Spacer(Modifier.height(OmSpacing.xs))
        }

        PrivacyBoundaryLine("your machine")

        // The moments inside the machine stand on the page, not in a container
        // of their own. What holds them together is the band: the hairline that
        // opens it and the solid rail beside it. A tinted panel around them
        // would say the same thing a second time, and cost a level of nesting
        // to say it.
        PrivacyZone(rail = insideRail()) {
            Spacer(Modifier.height(OmSpacing.xs))
            order.inside.forEach { moment ->
                PrivacyMoment(at = momentAt(moment), showsDay = moment.key in dayBreaks) {
                    when (moment) {
                        is PrivacySpineMoment.Draft -> {
                            PrivacyDraftCard(exchange, moment.event)
                            // Local generation activity sits under the draft
                            // it produced — the portal's PrivacyAgentTranscripts
                            // placement. Renders nothing on old gateways.
                            PrivacyAgentTranscripts(
                                traces = exchange.agentTraces,
                                omittedAttempts = exchange.agentTraceOmittedAttempts,
                                onOpenDocument = onOpenDocument,
                                onOpenPerson = onOpenPerson,
                                onOpenUrl = onOpenUrl,
                                catalog = catalog,
                            )
                        }
                        is PrivacySpineMoment.Check -> PrivacyDecisionCard(
                            exchange = exchange,
                            reviewEvent = moment.event ?: firstEventOfKind(events, "privacy_review"),
                            busy = busy,
                            actionError = actionError,
                            onApprove = onApprove,
                            onDeny = onDeny,
                            onOpenPolicy = onOpenPolicy,
                        )
                        is PrivacySpineMoment.Step -> PrivacyLedgerStep(moment.step)
                    }
                }
                Spacer(Modifier.height(OmSpacing.md))
            }
        }

        if (released) {
            PrivacyBoundaryLine("left your machine")
            PrivacyZone(rail = outsideRail()) {
                Spacer(Modifier.height(OmSpacing.xs))
                PrivacyMoment(at = receivedAt, showsDay = "received" in dayBreaks) {
                    // The release, then the receipt it led to: a caller cannot
                    // have received an answer before it was let go.
                    order.released?.let { PrivacyLedgerStep(it) }
                    // Only when it was actually collected. A released answer
                    // the caller has not come back for has crossed the boundary
                    // without anyone receiving it, and the release step above
                    // says so.
                    if (shared) {
                        Text(
                            buildString {
                                append(agentName)
                                append(" received this answer")
                                exchange.sharedAt?.takeIf { it > 0 }?.let {
                                    append(" ${TimeFormat.relative(it)}")
                                }
                                append(".")
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = c.textSecondary,
                        )
                    }
                }
                order.afterRelease.forEach { event ->
                    Spacer(Modifier.height(OmSpacing.md))
                    PrivacyMoment(at = event.createdAt, showsDay = event.id in dayBreaks) {
                        PrivacyLedgerStep(event)
                    }
                }
            }
        }
    }
}

/**
 * One moment: when it happened, then what happened.
 *
 * The time is on every moment; the date only on the one that opens a new day,
 * so a reader scanning a column of instants sees the number that is moving.
 */
@Composable
private fun PrivacyMoment(
    at: Long?,
    showsDay: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = OmTheme.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        if (at != null && at > 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                if (showsDay) {
                    Text(
                        TimeFormat.day(at),
                        style = MaterialTheme.typography.labelSmall.copy(
                            fontWeight = FontWeight.SemiBold,
                        ),
                        color = c.textSecondary,
                    )
                }
                Text(
                    TimeFormat.clock(at),
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textMuted,
                )
            }
        }
        content()
    }
}

/** What Omnesis drafted, or that it is still drafting. */
@Composable
private fun PrivacyDraftCard(
    exchange: PrivacyExchangePresentation,
    event: PrivacyAuditEventSummary?,
) {
    val c = OmTheme.colors
    val tones = privacyTones()
    val shared = exchange.outcome in SHARED_OUTCOMES
    val answer = privacyDisplayedAnswer(exchange)
    val generationFailed = privacyAnswerGenerationFailed(exchange)
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (generationFailed) tones.failedBg else c.bgSecondary,
                RoundedCornerShape(OmRadius.large),
            )
            .border(
                1.dp,
                if (generationFailed) tones.failed else c.border,
                RoundedCornerShape(OmRadius.large),
            )
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        PrivacyCardHead(PrivacyActorKind.OMNESIS, privacyDraftActorLabel(exchange), null)
        if (!answer.isNullOrBlank()) {
            PrivacyAnswerBlock(
                answer,
                // Prefer the recovered local draft, then a pending candidate or
                // the recorded release, and tell a listener which kind this
                // block contains.
                role = if (exchange.draftAnswer != null || exchange.pendingCandidate != null) {
                    "draft answer"
                } else {
                    "answer that was shared"
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            if (!shared) {
                Text(
                    "This draft has not left this machine.",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textSecondary,
                )
            }
        } else {
            Text(
                privacyUnavailableDraftCopy(exchange),
                style = MaterialTheme.typography.bodyMedium,
                color = c.textMuted,
            )
        }
        if (generationFailed) {
            exchange.failure?.message?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontWeight = FontWeight.SemiBold,
                    ),
                    color = tones.failed,
                )
            }
            // The sentence says what went wrong; this names the condition in the vocabulary
            // the model provider and the gateway logs use.
            OmFailureDetailLine(exchange.failure?.code, exchange.failure?.detail)
        }
        modelLine(event)?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = c.textMuted)
        }
    }
}

/** What the privacy check decided, and the decision it still wants. */
@Composable
private fun PrivacyDecisionCard(
    exchange: PrivacyExchangePresentation,
    reviewEvent: PrivacyAuditEventSummary?,
    busy: String?,
    actionError: String?,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onOpenPolicy: PrivacyPolicyOpener?,
) {
    val c = OmTheme.colors
    val tones = privacyTones()
    val reviewFailed = privacyReviewFailed(exchange)
    val pending = exchange.outcome == "needs_review" && exchange.approval?.status == "pending"
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (reviewFailed) tones.failedBg else c.bgSecondary,
                RoundedCornerShape(OmRadius.large),
            )
            .border(
                1.dp,
                if (reviewFailed) tones.failed else c.border,
                RoundedCornerShape(OmRadius.large),
            )
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        PrivacyCardHead(PrivacyActorKind.CHECK, "Privacy check", null)
        Text(
            exchangeDecisionCopy(exchange),
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
            color = c.textPrimary,
        )
        if (reviewFailed) {
            exchange.failure?.message?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                    color = tones.failed,
                )
            }
            OmFailureDetailLine(exchange.failure?.code, exchange.failure?.detail)
        }
        // The sentence above is Omnesis's own account of the outcome; this is
        // the reviewer's, in its words. The record carries a rationale and the
        // ledger step carries the sentence the reviewer wrote; they are usually
        // the same words, and an exchange whose record kept no rationale still
        // has the step.
        val rationale = exchange.review?.rationale?.takeIf { it.isNotBlank() }
            ?: reviewEvent?.display?.text?.takeIf { it.isNotBlank() }
        rationale?.let {
            PrivacyQuote(it, role = "privacy check summary", style = MaterialTheme.typography.bodySmall)
        }
        PrivacyFindingChips(reviewFindings(exchange.review))
        if (exchange.reductions.isNotEmpty()) {
            Text(
                "Details removed before sharing",
                style = MaterialTheme.typography.labelMedium,
                color = c.textPrimary,
            )
            exchange.reductions.forEach {
                Text("• $it", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
            }
        }
        modelLine(reviewEvent)?.let {
            Text(
                "Checked by $it.",
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
            )
        }
        PrivacyReviewedUnderPolicyRow(exchange.review, onOpenPolicy)
        actionError?.let { PrivacyBanner(it, PrivacyBannerKind.ERROR) }
        if (pending) {
            PrivacyDecisionButtons(
                busy = busy,
                canShare = !exchange.pendingCandidate.isNullOrBlank(),
                shareLabel = "Share once",
                onApprove = onApprove,
                onDeny = onDeny,
            )
        }
    }
}

@Composable
internal fun PrivacyDecisionButtons(
    busy: String?,
    canShare: Boolean,
    shareLabel: String,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Row(
        modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Button(
            onClick = onApprove,
            enabled = busy == null && canShare,
            modifier = Modifier.weight(1f),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent),
        ) {
            if (busy == "approve") {
                OmSpinner(Modifier.size(14.dp))
                Spacer(Modifier.width(OmSpacing.xs))
            }
            Text(if (busy == "approve") "Approving…" else shareLabel, maxLines = 1)
        }
        OutlinedButton(
            onClick = onDeny,
            enabled = busy == null,
            modifier = Modifier.weight(1f),
        ) {
            Text(if (busy == "deny") "Not sharing…" else "Don't share", color = c.danger, maxLines = 1)
        }
    }
}

/**
 * One recorded step, on the spine, in the band it happened in.
 *
 * Quieter than the three cards beside it, and deliberately: a reader scanning
 * this column is looking for what was asked, what was drafted and what was
 * decided, and a reduction or an agent's tool call is the detail underneath one
 * of those rather than a fourth thing of the same weight.
 *
 * A step's two paragraphs are not necessarily the same kind of text — the body
 * may be the exchange's own words where the note beside it is Omnesis's — so
 * each is drawn from the step kind's map of quoted parts rather than from the
 * step as a whole.
 *
 * The instant is not here. It is on the moment above, so every time on the
 * spine sits at the same indent.
 */
@Composable
private fun PrivacyLedgerStep(event: PrivacyAuditEventSummary) {
    val c = OmTheme.colors
    val comparison = remember(event.id) { event.answerComparison }
    val quoted = remember(event.kind) { privacyAuditQuotedParts(privacyAuditStepKind(event.kind)) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Text(
                event.display.title.ifBlank { "Step" },
                style = MaterialTheme.typography.labelLarge,
                color = c.textPrimary,
                modifier = Modifier.weight(1f, fill = false),
            )
            privacyAuditStatusDisplay(event.display.status)?.let { PrivacyChip(it) }
        }
        // A line-by-line comparison contains the released text already, so the
        // step's own copy of it would print the same words twice.
        if (!answerComparisonReplacesStepText(comparison)) {
            event.display.text?.takeIf { it.isNotBlank() }?.let {
                PrivacyLedgerParagraph(it, quoted.text)
            }
        }
        event.display.detail?.takeIf { it.isNotBlank() }?.let {
            PrivacyLedgerParagraph(it, quoted.detail)
        }
        comparison?.let { PrivacyAnswerComparisonBlock(it, Modifier.padding(top = OmSpacing.xs)) }
        modelLine(event)?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = c.textMuted)
        }
        event.display.reductions.forEach {
            Text("• $it", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }
    }
}

/**
 * One paragraph of a ledger step: quoted when it is the exchange's own words,
 * and otherwise the gateway's sentence about what happened, in prose.
 */
@Composable
private fun PrivacyLedgerParagraph(text: String, role: String?) {
    if (role == null) {
        Text(text, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textSecondary)
    } else {
        PrivacyQuote(text, role = role, style = MaterialTheme.typography.bodySmall)
    }
}

/* ── The pinned review card ───────────────────────────────────────────────── */

/**
 * A pending exchange, decided in place. It carries everything the decision needs
 * — the exact held answer, the reason Omnesis paused, and both buttons — because
 * a pending item is an exchange, and putting it behind a separate tab is what
 * hides it.
 */
@Composable
internal fun PrivacyReviewCard(
    exchange: PrivacyExchangePresentation,
    modifier: Modifier = Modifier,
    busy: String? = null,
    error: String? = null,
    onApprove: () -> Unit = {},
    onDeny: () -> Unit = {},
    onOpenPolicy: PrivacyPolicyOpener? = null,
) {
    val c = OmTheme.colors
    val agentName = externalAgentNarrativeName(exchange.externalAgent)
    val candidate = exchange.pendingCandidate
    val candidateAvailable = !candidate.isNullOrBlank()
    val pause = privacyPauseCopy(exchange.review)

    Column(
        modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(OmRadius.large))
            .border(1.dp, privacyTones().review, RoundedCornerShape(OmRadius.large))
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        PrivacyCardHead(PrivacyActorKind.EXTERNAL, "$agentName asked", exchange.createdAt)

        if (exchange.question.isNotBlank()) {
            PrivacyQuote(
                exchange.question,
                role = "question",
                style = MaterialTheme.typography.bodyLarge,
            )
        } else {
            Text(
                "No question was recorded.",
                style = MaterialTheme.typography.bodyLarge,
                color = c.textMuted,
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                "Answer held inside Omnesis",
                style = MaterialTheme.typography.labelSmall,
                color = c.textMuted,
            )
            if (candidateAvailable) {
                PrivacyAnswerBlock(
                    candidate.orEmpty(),
                    role = "held answer",
                    style = MaterialTheme.typography.bodyMedium,
                    tint = privacyHeldAnswerTint(),
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "The exact answer is unavailable.",
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = c.textPrimary,
                    )
                    Text(
                        "It cannot be shared from here. You can still choose not to share it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                    )
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                pause.title,
                style = MaterialTheme.typography.labelLarge,
                color = c.textPrimary,
            )
            // The pause reads either as Omnesis explaining itself or as the
            // reviewer's own sentence, and only the second is a quotation.
            if (pause.quotesTheReviewer) {
                PrivacyQuote(
                    pause.message,
                    role = "privacy check summary",
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                Text(
                    pause.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
            }
            PrivacyFindingChips(reviewFindings(exchange.review), limit = 3)
            PrivacyReviewedUnderPolicyRow(exchange.review, onOpenPolicy)
        }

        error?.let { PrivacyBanner(it, PrivacyBannerKind.ERROR) }

        PrivacyDecisionButtons(
            busy = busy,
            canShare = candidateAvailable,
            shareLabel = "Share once",
            onApprove = onApprove,
            onDeny = onDeny,
        )
    }
}

/** Opens one policy family's document, by id and by the name the caller has for it. */
internal typealias PrivacyPolicyOpener = (familyId: String, name: String?) -> Unit

/**
 * The policy this exchange was judged under, as a row into its document. Absent when the
 * record predates policy families, and on surfaces that offer no way to open a policy —
 * a row that goes nowhere would only claim to.
 */
@Composable
private fun PrivacyReviewedUnderPolicyRow(review: PrivacyExchangeReview?, onOpenPolicy: PrivacyPolicyOpener?) {
    val familyId = review?.policyFamilyId?.trim()?.takeIf { it.isNotEmpty() } ?: return
    if (onOpenPolicy == null) return
    val name = review.policyFamilyName?.trim()?.takeIf { it.isNotEmpty() }
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .clickable(role = Role.Button) { onOpenPolicy(familyId, name) }
            .heightIn(min = 40.dp)
            .padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (name != null) "Reviewed under $name" else "See the policy it was reviewed under",
            style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium),
            color = c.accent,
            modifier = Modifier.weight(1f),
        )
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(18.dp),
        )
    }
}

/* ── Banners ──────────────────────────────────────────────────────────────── */

enum class PrivacyBannerKind { ERROR, WARNING, SUCCESS }

/**
 * A banner's kind is carried by a glyph and its label, not by the background
 * tint alone: a failed approval and a successful one must not read the same to
 * anyone who cannot resolve a 12%-alpha wash — including every screen reader.
 */
@Composable
internal fun PrivacyBanner(
    message: String,
    kind: PrivacyBannerKind,
    modifier: Modifier = Modifier,
    title: String? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val c = OmTheme.colors
    val tint = when (kind) {
        PrivacyBannerKind.ERROR -> c.danger
        PrivacyBannerKind.WARNING -> c.warning
        PrivacyBannerKind.SUCCESS -> c.success
    }
    val glyph = when (kind) {
        PrivacyBannerKind.ERROR -> Icons.Outlined.ErrorOutline
        PrivacyBannerKind.WARNING -> Icons.Outlined.WarningAmber
        PrivacyBannerKind.SUCCESS -> Icons.Outlined.CheckCircle
    }
    val kindLabel = when (kind) {
        PrivacyBannerKind.ERROR -> "Error"
        PrivacyBannerKind.WARNING -> "Warning"
        PrivacyBannerKind.SUCCESS -> "Success"
    }
    Row(
        modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.12f), RoundedCornerShape(OmRadius.medium))
            .padding(OmSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            glyph,
            contentDescription = kindLabel,
            tint = tint,
            modifier = Modifier.size(18.dp),
        )
        Column(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        ) {
            title?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelLarge,
                    color = c.textPrimary,
                )
            }
            Text(message, style = MaterialTheme.typography.bodySmall, color = c.textPrimary)
            action?.invoke()
        }
    }
}

@Composable
internal fun PrivacyEmptyState(title: String, message: String, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(OmRadius.medium))
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        Text(
            title,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            color = c.textPrimary,
        )
        Text(message, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
    }
}

@Composable
internal fun PrivacySectionHeading(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
        color = OmTheme.colors.textPrimary,
        modifier = modifier,
    )
}

@Composable
internal fun PrivacyTextLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(onClick = onClick, modifier = modifier) { Text(text) }
}
