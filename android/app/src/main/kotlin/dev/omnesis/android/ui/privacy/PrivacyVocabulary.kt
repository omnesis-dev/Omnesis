// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import android.text.format.DateFormat as AndroidDateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.R
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.common.TimeFormat
import dev.omnesis.android.transport.dto.DirectAuditEvent
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyAuditStatusDisplay
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.transport.dto.PrivacyFinding
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The vocabulary every Privacy surface shares: the closed status maps, the
 * plain-language decision copy, the three fixed actor glyphs, and the palette
 * the spine is drawn from.
 *
 * The glyphs are deliberately abstract. An exchange has exactly three actors —
 * the external agent that asked, Omnesis which drafted, and the privacy check
 * which decided — and each gets one fixed mark. The caller's display name is
 * self-asserted, so a per-vendor logo would dress that claim up as verified
 * identity; and the reviewer is a function of Omnesis rather than a product, so
 * it gets a padlock rather than anything logo-shaped. Every glyph is tinted
 * monochrome and sits at lower visual weight than the text label beside it, so
 * the design survives being read without colour.
 */

/* ── Palette ──────────────────────────────────────────────────────────────── */

/**
 * Privacy has its own tones, ported from the portal. One question decides the
 * colour: did an answer reach the caller? Green says yes — with or without
 * details removed — and amber says no, whether the exchange is waiting on a
 * decision or was refused outright. A reader scanning the list is asking that
 * question and nothing else, so the two answers are the two colours and the
 * label carries the nuance between "shared" and "shared with details removed".
 * States that have not reached an outcome at all are grey rather than a third
 * answer, and a check that failed keeps the red every other failure wears.
 *
 * Green and amber are close in lightness, and under red-green colour blindness
 * they converge — so colour is the redundant channel here, never the only one.
 * Every chip is labelled in words that say the outcome outright, and the light
 * values are chosen dark enough to clear 4.5:1 against their own tint at the
 * chip's text size, which is what stops the amber reading as beige.
 */
data class PrivacyTonePalette(
    val released: Color,
    val releasedBg: Color,
    val reduced: Color,
    val reducedBg: Color,
    val review: Color,
    val reviewBg: Color,
    val kept: Color,
    val keptBg: Color,
    val waiting: Color,
    val waitingBg: Color,
    val failed: Color,
    val failedBg: Color,
    val hairline: Color,
    val rail: Color,
    val railInside: Color,
    /**
     * The answer comparison's own pair, deliberately outside the outcome
     * family. Text the release dropped is neutral — it never left this machine
     * — and text the release carries is marked in violet, a hue no outcome chip
     * wears, so a changed run reads as "this is the wording that went" rather
     * than as a status. The pair differs in saturation as well as hue, so it
     * survives every form of colour blindness, and the gutter marks and the
     * strike/underline carry the whole meaning with no colour at all.
     */
    val diffRemoved: Color,
    val diffRemovedBg: Color,
    val diffAdded: Color,
    val diffAddedBg: Color,
    /**
     * The surface every verbatim quotation is drawn on. Deliberately a
     * translucent lift rather than a fixed colour: the same quote is drawn on
     * the page background, on a card, and over the held-answer tint, and an
     * opaque token would vanish against one of them. Compositing keeps the lift
     * equal wherever it lands, and it is slight by design — the panel has only
     * to raise the quote off what it sits on, and anything stronger makes a
     * screen of stacked quotations read as a screen of boxes.
     */
    val quoteFill: Color,
    val quoteBorder: Color,
)

internal fun privacyExchangeNeedsPolling(exchange: PrivacyExchangePresentation?): Boolean =
    exchange?.status == "running"

internal fun privacyDraftActorLabel(exchange: PrivacyExchangePresentation): String =
    if (privacyAnswerGenerationFailed(exchange)) {
        "Omnesis could not draft an answer"
    } else if (privacyExchangeNeedsPolling(exchange) &&
        exchange.draftAnswer.isNullOrBlank() &&
        exchange.pendingCandidate.isNullOrBlank() &&
        exchange.sharedAnswer.isNullOrBlank()
    ) {
        "Omnesis is drafting an answer"
    } else {
        "Omnesis drafted an answer"
    }

internal fun privacyUnavailableDraftCopy(exchange: PrivacyExchangePresentation): String =
    if (privacyExchangeNeedsPolling(exchange)) {
        "No draft has been recorded yet. Nothing has left this machine."
    } else {
        "The draft is not available. Nothing about it left this machine."
    }

internal fun privacyDisplayedAnswer(exchange: PrivacyExchangePresentation): String? =
    (exchange.draftAnswer ?: exchange.pendingCandidate ?: exchange.sharedAnswer)
        ?.takeIf { it.isNotBlank() }

internal fun privacyAnswerGenerationFailed(exchange: PrivacyExchangePresentation): Boolean {
    if (exchange.outcome != "failed") return false
    when (exchange.failure?.stage) {
        "answer_generation" -> return true
        "privacy_check" -> return false
    }
    return privacyDisplayedAnswer(exchange) == null && !privacyTechnicalReviewFailed(exchange)
}

internal fun privacyReviewFailed(exchange: PrivacyExchangePresentation): Boolean {
    if (exchange.outcome == "failed") {
        when (exchange.failure?.stage) {
            "answer_generation" -> return false
            "privacy_check" -> return true
        }
    }
    return privacyTechnicalReviewFailed(exchange) ||
        (exchange.outcome == "failed" && privacyDisplayedAnswer(exchange) != null)
}

private fun privacyTechnicalReviewFailed(exchange: PrivacyExchangePresentation): Boolean =
    exchange.review?.fallbackCause in PRIVACY_REVIEW_FAILURES

/** The one amber both withheld tones wear, per theme. */
private val PrivacyDarkAmber = Color(0xFFE3B341)
private val PrivacyLightAmber = Color(0xFF8A5D00)

private val PrivacyDarkTones = PrivacyTonePalette(
    released = Color(0xFF3FB950),
    releasedBg = Color(0xFF3FB950).copy(alpha = 0.15f),
    reduced = Color(0xFF56D364),
    reducedBg = Color(0xFF56D364).copy(alpha = 0.13f),
    review = PrivacyDarkAmber,
    reviewBg = PrivacyDarkAmber.copy(alpha = 0.16f),
    // Waiting on you and refused are the same answer to the question the
    // palette asks — nothing reached the caller — so they are one amber, and
    // the label says which of the two it is.
    kept = PrivacyDarkAmber,
    keptBg = PrivacyDarkAmber.copy(alpha = 0.16f),
    waiting = Color(0xFF8B949E),
    waitingBg = Color(0xFF8B949E).copy(alpha = 0.09f),
    failed = Color(0xFFF85149),
    failedBg = Color(0xFFF85149).copy(alpha = 0.14f),
    hairline = Color(0xFF30363D),
    rail = Color(0xFF8B949E),
    railInside = Color(0xFF58A6FF),
    diffRemoved = Color(0xFFB7C0CB),
    diffRemovedBg = Color(0xFF8B949E).copy(alpha = 0.14f),
    diffAdded = Color(0xFFD2A8FF),
    diffAddedBg = Color(0xFFD2A8FF).copy(alpha = 0.18f),
    quoteFill = Color(0xFFFFFFFF).copy(alpha = 0.025f),
    quoteBorder = Color(0xFFFFFFFF).copy(alpha = 0.055f),
)

private val PrivacyLightTones = PrivacyTonePalette(
    released = Color(0xFF116329),
    releasedBg = Color(0xFF116329).copy(alpha = 0.10f),
    reduced = Color(0xFF15702F),
    reducedBg = Color(0xFF15702F).copy(alpha = 0.09f),
    review = PrivacyLightAmber,
    reviewBg = PrivacyLightAmber.copy(alpha = 0.13f),
    kept = PrivacyLightAmber,
    keptBg = PrivacyLightAmber.copy(alpha = 0.13f),
    waiting = Color(0xFF57606A),
    waitingBg = Color(0xFF57606A).copy(alpha = 0.08f),
    failed = Color(0xFFCF222E),
    failedBg = Color(0xFFCF222E).copy(alpha = 0.10f),
    hairline = Color(0xFFD0D7DE),
    rail = Color(0xFF6E7781),
    railInside = Color(0xFF0969DA),
    diffRemoved = Color(0xFF4B535C),
    diffRemovedBg = Color(0xFF57606A).copy(alpha = 0.11f),
    diffAdded = Color(0xFF8250DF),
    diffAddedBg = Color(0xFF8250DF).copy(alpha = 0.14f),
    quoteFill = Color(0xFF1B1F23).copy(alpha = 0.022f),
    quoteBorder = Color(0xFF1B1F23).copy(alpha = 0.06f),
)

@Composable
@ReadOnlyComposable
internal fun privacyTones(): PrivacyTonePalette =
    if (OmTheme.colors.isDark) PrivacyDarkTones else PrivacyLightTones

internal enum class PrivacyTone { RELEASED, REDUCED, REVIEW, KEPT, WAITING, FAILED }

internal data class PrivacyChipColors(val foreground: Color, val background: Color, val border: Color)

@Composable
@ReadOnlyComposable
internal fun privacyChipColors(tone: PrivacyTone): PrivacyChipColors {
    val t = privacyTones()
    return when (tone) {
        PrivacyTone.RELEASED -> PrivacyChipColors(t.released, t.releasedBg, t.released)
        PrivacyTone.REDUCED -> PrivacyChipColors(t.reduced, t.reducedBg, t.reduced)
        PrivacyTone.REVIEW -> PrivacyChipColors(t.review, t.reviewBg, t.review)
        PrivacyTone.KEPT -> PrivacyChipColors(t.kept, t.keptBg, t.kept)
        PrivacyTone.WAITING -> PrivacyChipColors(t.waiting, t.waitingBg, t.hairline)
        PrivacyTone.FAILED -> PrivacyChipColors(t.failed, t.failedBg, t.failed)
    }
}

/* ── Outcomes ─────────────────────────────────────────────────────────────── */

internal data class PrivacyOutcomeDisplay(val tone: PrivacyTone, val label: String)

private val OUTCOME_DISPLAY = mapOf(
    "checking" to PrivacyOutcomeDisplay(PrivacyTone.WAITING, "Checking"),
    "needs_review" to PrivacyOutcomeDisplay(PrivacyTone.REVIEW, "Needs your review"),
    "ready" to PrivacyOutcomeDisplay(PrivacyTone.WAITING, "Approved, waiting for agent"),
    "shared" to PrivacyOutcomeDisplay(PrivacyTone.RELEASED, "Shared with the agent"),
    "shared_with_reductions" to PrivacyOutcomeDisplay(PrivacyTone.REDUCED, "Shared with details removed"),
    "not_shared" to PrivacyOutcomeDisplay(PrivacyTone.KEPT, "Not shared"),
    "failed" to PrivacyOutcomeDisplay(PrivacyTone.FAILED, "Nothing shared; check failed"),
    "canceled" to PrivacyOutcomeDisplay(PrivacyTone.KEPT, "Canceled"),
)

/** The closed set a feed row or a spine may render. Anything else reads as unknown. */
internal fun privacyOutcomeDisplay(outcome: String): PrivacyOutcomeDisplay =
    OUTCOME_DISPLAY[outcome] ?: PrivacyOutcomeDisplay(PrivacyTone.WAITING, "Checking")

internal fun privacyExchangeOutcomeDisplay(
    exchange: PrivacyExchangePresentation,
): PrivacyOutcomeDisplay {
    val display = privacyOutcomeDisplay(exchange.outcome)
    val recipient = externalAgentRecipient(exchange.externalAgent)
    when (exchange.outcome) {
        "ready" -> return display.copy(label = "Approved, waiting for $recipient")
        "shared" -> return display.copy(label = "Shared with $recipient")
        "shared_with_reductions" -> return display.copy(label = "Shared with $recipient, details removed")
    }
    if (exchange.outcome != "failed") return display
    return display.copy(
        label = if (privacyAnswerGenerationFailed(exchange)) {
            "Nothing shared; answer failed"
        } else {
            "Nothing shared; privacy check failed"
        },
    )
}

/* ── Feed outcomes and filters ────────────────────────────────────────────── */

enum class PrivacyFeedFilter(val label: String) {
    ALL("All"),
    SHARED("Shared"),
    NOT_SHARED("Not shared"),
    FAILED("Failed"),
    WAITING("Waiting"),
}

private val PRIVACY_FEED_FILTER_BY_OUTCOME = mapOf(
    "shared" to PrivacyFeedFilter.SHARED,
    "shared_with_reductions" to PrivacyFeedFilter.SHARED,
    "not_shared" to PrivacyFeedFilter.NOT_SHARED,
    "canceled" to PrivacyFeedFilter.NOT_SHARED,
    "failed" to PrivacyFeedFilter.FAILED,
    "checking" to PrivacyFeedFilter.WAITING,
    "ready" to PrivacyFeedFilter.WAITING,
    "needs_review" to PrivacyFeedFilter.WAITING,
)

/**
 * Unknown outcomes pass every filter. A newer gateway must not be able to make
 * an audit row disappear merely because this app cannot classify it yet.
 */
internal fun privacyFeedFilterMatches(
    filter: PrivacyFeedFilter,
    exchange: PrivacyExchangePresentation,
): Boolean {
    if (filter == PrivacyFeedFilter.ALL) return true
    return PRIVACY_FEED_FILTER_BY_OUTCOME[exchange.outcome]?.let { it == filter } ?: true
}

internal fun privacyFeedFilterCounts(
    exchanges: List<PrivacyExchangePresentation>,
): Map<PrivacyFeedFilter, Int> = PrivacyFeedFilter.entries.associateWith { filter ->
    exchanges.count { privacyFeedFilterMatches(filter, it) }
}

internal data class PrivacyFeedOutcomeDisplay(
    val outcome: PrivacyOutcomeDisplay,
    val quiet: Boolean,
)

private val QUIET_PRIVACY_FEED_TONES = setOf(
    PrivacyTone.RELEASED,
    PrivacyTone.REDUCED,
    PrivacyTone.KEPT,
    PrivacyTone.WAITING,
)

/** Feed labels do not repeat the caller named at the start of the row. */
internal fun privacyFeedOutcomeDisplay(
    exchange: PrivacyExchangePresentation,
): PrivacyFeedOutcomeDisplay {
    if (exchange.outcome !in OUTCOME_DISPLAY) {
        return PrivacyFeedOutcomeDisplay(
            outcome = PrivacyOutcomeDisplay(PrivacyTone.WAITING, "Outcome not recognised"),
            quiet = false,
        )
    }
    val display = privacyExchangeOutcomeDisplay(exchange)
    val shortened = when (exchange.outcome) {
        "ready" -> display.copy(label = "Approved, waiting")
        "shared" -> display.copy(label = "Shared")
        "shared_with_reductions" -> display.copy(label = "Shared, details removed")
        else -> display
    }
    return PrivacyFeedOutcomeDisplay(
        outcome = shortened,
        quiet = shortened.tone in QUIET_PRIVACY_FEED_TONES,
    )
}

internal fun privacyFeedInstant(exchange: PrivacyExchangePresentation): Long? =
    (exchange.sharedAt ?: exchange.resolvedAt ?: exchange.createdAt).takeIf { it > 0 }

internal data class PrivacyFeedDay(
    val key: String,
    val heading: String,
    val exchanges: List<PrivacyExchangePresentation>,
)

/** Group an already-newest-first feed by local calendar day without reordering it. */
internal fun privacyFeedDays(
    exchanges: List<PrivacyExchangePresentation>,
    nowMillis: Long = System.currentTimeMillis(),
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<PrivacyFeedDay> {
    val today = Instant.ofEpochMilli(nowMillis).atZone(zoneId).toLocalDate()
    val grouped = linkedMapOf<String, Pair<String, MutableList<PrivacyExchangePresentation>>>()
    exchanges.forEach { exchange ->
        val instant = privacyFeedInstant(exchange)
        val date = instant?.let { Instant.ofEpochMilli(it).atZone(zoneId).toLocalDate() }
        val key = date?.toString() ?: "unknown"
        val heading = privacyDayHeading(date, today, locale)
        grouped.getOrPut(key) { heading to mutableListOf() }.second += exchange
    }
    return grouped.map { (key, value) -> PrivacyFeedDay(key, value.first, value.second) }
}

/**
 * One calendar day's calls inside a transcript: "Today", "Yesterday", an
 * abbreviated weekday date, or "Date unknown" — the same wording as the
 * feed, so the transcript's top date and interleaved day separators read
 * as one system.
 */
internal fun privacyDayHeading(
    date: LocalDate?,
    today: LocalDate,
    locale: Locale = Locale.getDefault(),
): String = when (date) {
    null -> "Date unknown"
    today -> "Today"
    today.minusDays(1) -> "Yesterday"
    else -> date.format(
        DateTimeFormatter.ofPattern(
            AndroidDateFormat.getBestDateTimePattern(
                locale,
                if (date.year == today.year) "EEEMMMd" else "EEEMMMdy",
            ),
            locale,
        ),
    )
}

internal data class DirectTranscriptDay(
    val key: String,
    val heading: String,
    val events: List<DirectAuditEvent>,
)

/** Group an already-oldest-first transcript by local calendar day without reordering it. */
internal fun directTranscriptDays(
    events: List<DirectAuditEvent>,
    nowMillis: Long = System.currentTimeMillis(),
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<DirectTranscriptDay> {
    val today = Instant.ofEpochMilli(nowMillis).atZone(zoneId).toLocalDate()
    val grouped = linkedMapOf<String, Pair<String, MutableList<DirectAuditEvent>>>()
    events.forEach { event ->
        val date = event.createdAt.takeIf { it > 0 }
            ?.let { Instant.ofEpochMilli(it).atZone(zoneId).toLocalDate() }
        val key = date?.toString() ?: "unknown"
        val heading = privacyDayHeading(date, today, locale)
        grouped.getOrPut(key) { heading to mutableListOf() }.second += event
    }
    return grouped.map { (key, value) -> DirectTranscriptDay(key, value.first, value.second) }
}

internal fun formatPrivacyFeedTime(
    epochMillis: Long?,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
    use24HourClock: Boolean = true,
): String {
    if (epochMillis == null || epochMillis <= 0) return "Unknown"
    return DateTimeFormatter.ofPattern(
        AndroidDateFormat.getBestDateTimePattern(locale, if (use24HourClock) "Hm" else "hm"),
        locale,
    )
        .withZone(zoneId)
        .format(Instant.ofEpochMilli(epochMillis))
}

/** Full local context for the compact clock when accessibility services announce it. */
internal fun formatPrivacyFeedDateTime(
    epochMillis: Long?,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
    use24HourClock: Boolean = true,
): String {
    if (epochMillis == null || epochMillis <= 0) return "Unknown"
    val skeleton = "yMMMMEEEEd${if (use24HourClock) "Hm" else "hm"}"
    return DateTimeFormatter.ofPattern(
        AndroidDateFormat.getBestDateTimePattern(locale, skeleton),
        locale,
    )
        .withZone(zoneId)
        .format(Instant.ofEpochMilli(epochMillis))
}

/**
 * The four audit statuses a ledger step may render. The gateway maps every raw
 * producer token onto `{code,label}` and drops the rest, so a code outside this
 * set renders nothing at all rather than arriving styled as if it meant
 * something.
 */
internal fun privacyAuditStatusDisplay(status: PrivacyAuditStatusDisplay?): PrivacyOutcomeDisplay? {
    val tone = when (status?.code) {
        "allowed" -> PrivacyTone.RELEASED
        "reduced" -> PrivacyTone.REDUCED
        "held" -> PrivacyTone.REVIEW
        "blocked" -> PrivacyTone.KEPT
        else -> return null
    }
    val label = status.label.trim()
    return if (label.isEmpty()) null else PrivacyOutcomeDisplay(tone, label)
}

internal fun firingDeliveryStatusLabel(status: String): String = when (status) {
    "pending" -> "Queued"
    "delivered" -> "Delivered"
    "blocked" -> "Blocked"
    "failed" -> "Failed"
    else -> "Unknown"
}

/**
 * How much a firing discloses. A watch reveals only that its condition
 * occurred, which is the single value the wire carries; anything else is a
 * disclosure this client cannot describe and is not paraphrased as one.
 */
internal fun subscriptionDisclosureLabel(pushDetail: String): String =
    if (pushDetail == "existence") "Existence only" else "Unknown"

/* ── The caller's name ────────────────────────────────────────────────────── */

/**
 * A caller's display name often trails the registry slug it connected under —
 * `Atlas (openclaw)`. Only a bare lowercase token in trailing parentheses counts
 * as a slug, so a caller that genuinely names itself `Acme (support desk)` keeps
 * every word.
 */
private val AGENT_SLUG_SUFFIX = Regex("""\s*\([a-z0-9][a-z0-9._-]*\)$""")

internal fun externalAgentName(identity: PrivacyExternalAgentIdentity): String =
    identity.displayName.ifBlank { "External agent" }

/**
 * The name the narrative uses. Which integration a caller arrived through is
 * implementation detail in a plain-language story — a reader needs "Atlas
 * asked". The full name, slug included, is what the exchange states among the caller's own claims about itself.
 */
internal fun externalAgentNarrativeName(identity: PrivacyExternalAgentIdentity): String {
    identity.narrativeName?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    val name = externalAgentName(identity)
    return name.replace(AGENT_SLUG_SUFFIX, "").trim().ifEmpty { name }
}

/** A concrete recipient in a sentence, with a grammatical fallback for old or orphaned records. */
private fun externalAgentRecipient(identity: PrivacyExternalAgentIdentity): String {
    val name = externalAgentNarrativeName(identity)
    return if (name == "External agent") "the external agent" else name
}

/* ── Review copy ──────────────────────────────────────────────────────────── */

private val AUTOMATIC_CHECK_FALLBACKS = setOf(
    "not_configured",
    "request_failed",
    "invalid_output",
    "low_confidence",
)

private val PRIVACY_REVIEW_FAILURES = AUTOMATIC_CHECK_FALLBACKS + setOf(
    "context_window_exceeded",
    "output_truncated",
)

/**
 * Why Omnesis is holding an answer, in the owner's language.
 *
 * [quotesTheReviewer] says whether [message] is the reviewer's own sentence
 * rather than copy Omnesis wrote. The two are shown differently — the reviewer's
 * words are quoted — so a reader can tell whose account they are reading, and
 * Omnesis's own explanation is never dressed up as the reviewer's finding.
 */
internal data class PrivacyPauseCopy(
    val title: String,
    val message: String,
    val quotesTheReviewer: Boolean,
)

internal fun privacyPauseCopy(review: PrivacyExchangeReview?): PrivacyPauseCopy = when {
    review?.fallbackCause in AUTOMATIC_CHECK_FALLBACKS -> PrivacyPauseCopy(
        title = "Automatic privacy check unavailable",
        message = "Omnesis could not verify this answer automatically, so nothing was shared. " +
            "Review the exact answer shown above.",
        quotesTheReviewer = false,
    )
    review?.fallbackCause == "hard_stop" -> PrivacyPauseCopy(
        title = "This answer cannot be shared",
        message = "Omnesis detected information that its privacy boundary does not allow to leave.",
        quotesTheReviewer = false,
    )
    else -> {
        val rationale = review?.rationale?.takeIf { it.isNotBlank() }
        PrivacyPauseCopy(
            title = "Your privacy policy asks you to decide",
            message = rationale ?: "Nothing will be shared unless you approve this exact answer.",
            quotesTheReviewer = rationale != null,
        )
    }
}

/* ── Whose words a ledger step carries ────────────────────────────────────── */

/**
 * The step kinds the gateway records. The wire carries a bare token and gains
 * new ones over time, so anything this build has never heard of resolves to
 * [UNKNOWN] rather than being guessed at.
 */
internal enum class PrivacyAuditStepKind {
    EXTERNAL_REQUEST,
    AGENT_TRACE,
    CANDIDATE_GENERATED,
    PRIVACY_REVIEW,
    REDUCTION_GENERATED,
    APPROVAL_REQUESTED,
    APPROVAL_RESOLVED,
    RELEASED,
    DENIED,
    FAILED,
    TRUNCATED,
    EGRESS,
    UNKNOWN,
}

private val AUDIT_STEP_KINDS = mapOf(
    "external_request" to PrivacyAuditStepKind.EXTERNAL_REQUEST,
    "agent_trace" to PrivacyAuditStepKind.AGENT_TRACE,
    "candidate_generated" to PrivacyAuditStepKind.CANDIDATE_GENERATED,
    "privacy_review" to PrivacyAuditStepKind.PRIVACY_REVIEW,
    "reduction_generated" to PrivacyAuditStepKind.REDUCTION_GENERATED,
    "approval_requested" to PrivacyAuditStepKind.APPROVAL_REQUESTED,
    "approval_resolved" to PrivacyAuditStepKind.APPROVAL_RESOLVED,
    "released" to PrivacyAuditStepKind.RELEASED,
    "denied" to PrivacyAuditStepKind.DENIED,
    "failed" to PrivacyAuditStepKind.FAILED,
    "truncated" to PrivacyAuditStepKind.TRUNCATED,
    "egress" to PrivacyAuditStepKind.EGRESS,
)

internal fun privacyAuditStepKind(wire: String): PrivacyAuditStepKind =
    AUDIT_STEP_KINDS[wire] ?: PrivacyAuditStepKind.UNKNOWN

/**
 * Which of a step's two paragraphs are the exchange's own words, and what a
 * listener hears each one called before hearing it. A `null` role means the
 * paragraph is a sentence Omnesis wrote about the step and stays in prose.
 */
internal data class PrivacyQuotedParts(val text: String? = null, val detail: String? = null)

/**
 * What a ledger step quotes.
 *
 * A step's two display paragraphs are not necessarily the same kind of text: a
 * request quotes both its body — the question as it arrived — and the note
 * beside it, which is the purpose the caller stated for itself; a drafted or
 * released answer quotes only its body; an agent-activity step quotes neither,
 * because both of its paragraphs are the gateway's account of what happened.
 *
 * The mapping is exhaustive over [PrivacyAuditStepKind], so a kind added later
 * must be placed on one side or the other rather than defaulting to prose by
 * omission — and a kind this build has never heard of arrives as
 * [PrivacyAuditStepKind.UNKNOWN] and stays prose, because attributing text of
 * unknown authorship to the exchange is the claim this screen must not make.
 */
internal fun privacyAuditQuotedParts(kind: PrivacyAuditStepKind): PrivacyQuotedParts =
    when (kind) {
        PrivacyAuditStepKind.EXTERNAL_REQUEST ->
            PrivacyQuotedParts(text = "question", detail = "stated purpose")
        PrivacyAuditStepKind.CANDIDATE_GENERATED -> PrivacyQuotedParts(text = "draft answer")
        PrivacyAuditStepKind.REDUCTION_GENERATED -> PrivacyQuotedParts(text = "reduced answer")
        PrivacyAuditStepKind.PRIVACY_REVIEW -> PrivacyQuotedParts(text = "privacy check summary")
        PrivacyAuditStepKind.RELEASED -> PrivacyQuotedParts(text = "answer that was shared")
        PrivacyAuditStepKind.AGENT_TRACE,
        PrivacyAuditStepKind.APPROVAL_REQUESTED,
        PrivacyAuditStepKind.APPROVAL_RESOLVED,
        PrivacyAuditStepKind.DENIED,
        PrivacyAuditStepKind.FAILED,
        PrivacyAuditStepKind.TRUNCATED,
        PrivacyAuditStepKind.EGRESS,
        PrivacyAuditStepKind.UNKNOWN,
        -> PrivacyQuotedParts()
    }

/**
 * Findings are the category-level reasons the check paused. When the check
 * itself could not run there are none to show, and listing the categories it
 * never reached would misrepresent what happened.
 */
internal fun reviewFindings(review: PrivacyExchangeReview?): List<PrivacyFinding> =
    if (review?.fallbackCause in AUTOMATIC_CHECK_FALLBACKS) emptyList() else review?.findings.orEmpty()

/**
 * A privacy category as prose. The wire carries lowercase snake-case tokens
 * (`health_condition`), and no screen may print one raw — every surface that
 * names a category goes through here so they all name it the same way.
 */
internal fun privacyCategoryLabel(category: String): String =
    category.ifBlank { "Sensitive information" }
        .replace('_', ' ')
        .split(' ')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }

internal fun privacyFindingLabel(finding: PrivacyFinding): String {
    if (finding.subject == "other_person" || finding.subject == "multiple_people") return "Another person"
    val category = privacyCategoryLabel(finding.category)
    return if (finding.detailLevel == "exact" && !category.startsWith("Exact ")) {
        "Exact ${category.lowercase()}"
    } else {
        category
    }
}

private fun isHardStop(exchange: PrivacyExchangePresentation): Boolean =
    exchange.review?.fallbackCause == "hard_stop"

private fun isPostApprovalHardStop(exchange: PrivacyExchangePresentation): Boolean = when {
    !isHardStop(exchange) -> false
    exchange.userDecision == "approved_but_blocked" -> true
    else -> exchange.approval?.status == "approved" || exchange.approval?.status == "denied"
}

/** The decision, phrased as a full sentence for the spine's third card. */
internal fun exchangeDecisionCopy(exchange: PrivacyExchangePresentation): String {
    val recipient = externalAgentRecipient(exchange.externalAgent)
    return when {
        isHardStop(exchange) -> if (isPostApprovalHardStop(exchange)) {
            "You approved this once, but Omnesis blocked it. Nothing was shared."
        } else {
            "Omnesis blocked this answer automatically. Nothing was shared."
        }
        exchange.userDecision == "approved_but_blocked" ->
            "You approved this once, but Omnesis blocked it. Nothing was shared."
        exchange.userDecision == "approved" -> if (exchange.outcome == "ready") {
            "You approved this once. $recipient has not received it yet."
        } else {
            "You shared this once, and $recipient received it."
        }
        exchange.userDecision == "denied" -> "You chose not to share. Nothing was shared."
        exchange.userDecision == "expired" -> "The review expired. Nothing was shared."
        exchange.outcome == "not_shared" && exchange.denialReason == "approval_not_available" ->
            "The privacy check recommended approval, but this request has no approval flow. " +
                "Omnesis did not share the answer."
        exchange.outcome == "shared" ->
            "Your policy allowed this answer, and $recipient received it."
        exchange.outcome == "shared_with_reductions" ->
            "Omnesis removed details from this answer, then $recipient received the rest."
        exchange.outcome == "ready" ->
            "Omnesis approved this answer, but $recipient has not received it yet."
        exchange.outcome == "needs_review" ->
            "Omnesis is holding this answer until you decide. Nothing has been shared."
        exchange.outcome == "checking" ->
            "Omnesis is still checking this answer. Nothing has been shared."
        exchange.outcome == "failed" && exchange.review?.fallbackCause in AUTOMATIC_CHECK_FALLBACKS ->
            "Omnesis could not verify this automatically. Nothing was shared."
        exchange.outcome == "failed" && privacyAnswerGenerationFailed(exchange) ->
            "The privacy check did not run because Omnesis produced no answer. Nothing was shared."
        exchange.outcome == "failed" -> "The privacy check failed. Nothing was shared."
        exchange.outcome == "canceled" -> "The request was canceled. Nothing was shared."
        else -> "Nothing was shared."
    }
}

data class PrivacyResolutionCopy(val title: String, val message: String)

internal fun privacyResolutionCopy(
    status: String,
    reason: String?,
    externalAgent: PrivacyExternalAgentIdentity? = null,
): PrivacyResolutionCopy = when {
    status == "released" || status == "released_with_reductions" -> PrivacyResolutionCopy(
        title = "Answer approved",
        message = "The answer is ready for ${
            externalAgent?.let(::externalAgentRecipient) ?: "the external agent"
        } to collect.",
    )
    status == "denied" && reason == "hard_stop" -> PrivacyResolutionCopy(
        title = "Answer blocked",
        message = "You approved this answer once, but Omnesis blocked it before anything was shared.",
    )
    status == "denied" && reason == "expired" -> PrivacyResolutionCopy(
        title = "Approval expired",
        message = "Nothing was shared.",
    )
    // The boundary re-ran and paused again — the decision is still open, so
    // saying it was not shared would read as a closed outcome.
    status == "approval_required" -> PrivacyResolutionCopy(
        title = "Still waiting for your decision",
        message = "Nothing was shared.",
    )
    else -> PrivacyResolutionCopy(title = "Answer not shared", message = "Nothing was shared.")
}

/* ── The three fixed actor glyphs ─────────────────────────────────────────── */

private fun strokeGlyph(name: String, pathData: String, strokeWidth: Float = 1.6f): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).addPath(
        pathData = PathParser().parsePathString(pathData).toNodes(),
        stroke = SolidColor(Color.Black),
        strokeLineWidth = strokeWidth,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ).build()

/**
 * The external caller. One abstract mark for every caller — an arrow leaving an
 * enclosure: something outside the boundary, reaching in.
 */
internal val PrivacyExternalAgentGlyph: ImageVector = strokeGlyph(
    name = "PrivacyExternalAgent",
    pathData = "M13.5 4.5H19.5V10.5 M19.5 4.5L12.5 11.5 " +
        "M18 14.5V17.5C18 18.6 17.1 19.5 16 19.5H6.5C5.4 19.5 4.5 18.6 4.5 17.5V8C4.5 6.9 5.4 6 6.5 6H9.5",
)

/** The privacy check: a closed padlock, monochrome and deliberately not logo-shaped. */
internal val PrivacyCheckGlyph: ImageVector = strokeGlyph(
    name = "PrivacyCheck",
    pathData = "M6.75 10.25H17.25A2 2 0 0 1 19.25 12.25V17.75A2 2 0 0 1 17.25 19.75" +
        "H6.75A2 2 0 0 1 4.75 17.75V12.25A2 2 0 0 1 6.75 10.25Z " +
        "M8 10.25V7.5C8 5.29 9.79 3.5 12 3.5C14.21 3.5 16 5.29 16 7.5V10.25 " +
        "M12 13.9A1.1 1.1 0 1 1 11.99 13.9Z",
)

/** A small padlock for a control the policy floor settles on the operator's behalf. */
internal val PrivacyLockGlyph: ImageVector = strokeGlyph(
    name = "PrivacyLock",
    pathData = "M7 10.5H17A2 2 0 0 1 19 12.5V17.5A2 2 0 0 1 17 19.5" +
        "H7A2 2 0 0 1 5 17.5V12.5A2 2 0 0 1 7 10.5Z " +
        "M8.25 10.5V7.75C8.25 5.68 9.93 4 12 4C14.07 4 15.75 5.68 15.75 7.75V10.5",
    strokeWidth = 1.8f,
)

internal enum class PrivacyActorKind { EXTERNAL, OMNESIS, CHECK }

/**
 * The actor line at the head of a spine card. The text carries the meaning; the
 * glyph is reinforcement, which is why it is unlabelled for accessibility and
 * drawn at a lower weight than the label beside it.
 */
@Composable
internal fun PrivacyActor(kind: PrivacyActorKind, label: String, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Row(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (kind) {
            PrivacyActorKind.OMNESIS -> Icon(
                painter = painterResource(R.drawable.omnesis_logo),
                contentDescription = null,
                tint = c.textSecondary.copy(alpha = 0.75f),
                modifier = Modifier.size(15.dp),
            )
            PrivacyActorKind.EXTERNAL -> Icon(
                imageVector = PrivacyExternalAgentGlyph,
                contentDescription = null,
                tint = c.textSecondary.copy(alpha = 0.7f),
                modifier = Modifier.size(16.dp),
            )
            PrivacyActorKind.CHECK -> Icon(
                imageVector = PrivacyCheckGlyph,
                contentDescription = null,
                tint = c.textSecondary.copy(alpha = 0.7f),
                modifier = Modifier.size(16.dp),
            )
        }
        Text(
            label,
            style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/* ── Atoms ────────────────────────────────────────────────────────────────── */

@Composable
internal fun PrivacyChip(display: PrivacyOutcomeDisplay, modifier: Modifier = Modifier) {
    val colors = privacyChipColors(display.tone)
    Text(
        display.label,
        style = MaterialTheme.typography.labelSmall.copy(
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        ),
        color = colors.foreground,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .background(colors.background, RoundedCornerShape(percent = 50))
            .border(1.dp, colors.border, RoundedCornerShape(percent = 50))
            .padding(horizontal = 9.dp, vertical = 2.dp),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PrivacyFindingChips(
    findings: List<PrivacyFinding>,
    limit: Int = 4,
    modifier: Modifier = Modifier,
) {
    val labels = findings.map(::privacyFindingLabel).distinct().take(limit)
    if (labels.isEmpty()) return
    val c = OmTheme.colors
    FlowRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        labels.forEach { label ->
            Text(
                label,
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                color = c.textSecondary,
                modifier = Modifier
                    .background(c.bgTertiary, RoundedCornerShape(OmRadius.pill))
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
    }
}

/* ── The spine's running order ────────────────────────────────────────────── */

/** Steps that are themselves a crossing of the trust boundary. */
private val PRIVACY_CROSSING_KINDS = setOf("released", "egress")

/**
 * One moment on the spine: what happened, and when.
 *
 * Three of an exchange's recorded steps are its landmarks and become cards;
 * every other step becomes a quiet row in the place the ledger put it.
 */
internal sealed interface PrivacySpineMoment {
    val event: PrivacyAuditEventSummary?

    data class Draft(override val event: PrivacyAuditEventSummary?) : PrivacySpineMoment
    data class Check(override val event: PrivacyAuditEventSummary?) : PrivacySpineMoment
    data class Step(val step: PrivacyAuditEventSummary) : PrivacySpineMoment {
        override val event: PrivacyAuditEventSummary get() = step
    }

    /**
     * Stable across a re-read of the same exchange, and distinct between the two
     * cards when neither has a recorded step to be identified by.
     */
    val key: String
        get() = event?.id ?: when (this) {
            is Draft -> "draft"
            is Check -> "check"
            is Step -> "step"
        }
}

internal data class PrivacySpineOrder(
    val askedAt: Long,
    val inside: List<PrivacySpineMoment>,
    val released: PrivacyAuditEventSummary?,
    val afterRelease: List<PrivacyAuditEventSummary>,
)

/**
 * The spine's running order, taken from the ledger rather than invented here.
 *
 * The gateway returns an exchange's steps in the order they happened, so that
 * order is the story's order and nothing on screen has to guess at it. What is
 * *not* recorded still gets a card: a draft card that is missing says Omnesis is
 * still drafting, and the decision card carries the buttons that resolve a
 * pending exchange — neither may go missing because nothing wrote a step down.
 */
internal fun privacySpineOrder(
    exchange: PrivacyExchangePresentation,
    events: List<PrivacyAuditEventSummary>,
): PrivacySpineOrder {
    val askedIndex = events.indexOfFirst { it.kind == "external_request" }
    val asked = askedIndex.takeIf { it >= 0 }?.let { events[it] }
    // Dropped by position rather than by id: a payload whose steps arrive
    // without ids would otherwise have every one of them match the request's
    // and the whole ledger would vanish.
    val rest = events.filterIndexed { index, _ -> index != askedIndex }
    // The first step that is itself a crossing ends the inside band. A release
    // and an outbound response are both things that left, and a ledger can
    // record the second without the first — putting a step titled "Outbound
    // response" under the "your machine" rail, on the one screen whose claim is
    // that its left edge can be read without reading a word.
    val crossing = rest.indexOfFirst { it.kind in PRIVACY_CROSSING_KINDS }
    val beforeRelease = if (crossing >= 0) rest.take(crossing) else rest
    val released = crossing.takeIf { it >= 0 && rest[it].kind == "released" }?.let { rest[it] }
    val afterRelease = when {
        crossing < 0 -> emptyList()
        released != null -> rest.drop(crossing + 1)
        else -> rest.drop(crossing)
    }

    val inside = mutableListOf<PrivacySpineMoment>()
    var hasDraft = false
    var hasCheck = false
    for (event in beforeRelease) {
        when {
            event.kind == "candidate_generated" && !hasDraft -> {
                hasDraft = true
                inside += PrivacySpineMoment.Draft(event)
            }
            event.kind == "privacy_review" && !hasCheck -> {
                hasCheck = true
                inside += PrivacySpineMoment.Check(event)
            }
            else -> inside += PrivacySpineMoment.Step(event)
        }
    }
    if (!hasDraft) inside.add(0, PrivacySpineMoment.Draft(null))
    if (!hasCheck) inside += PrivacySpineMoment.Check(null)

    return PrivacySpineOrder(
        askedAt = asked?.createdAt ?: exchange.createdAt,
        inside = inside,
        released = released,
        afterRelease = afterRelease,
    )
}

/**
 * Which moments open a new day.
 *
 * Every moment on the spine states its time; only the ones that begin a new day
 * state the date as well. An exchange usually happens inside one minute, so
 * repeating the same date down twelve rows would bury the only number that
 * moves; an exchange held overnight for approval spans two, and the reader has
 * to see where.
 */
internal fun privacyDayBreaks(moments: List<Pair<String, Long?>>): Set<String> {
    val breaks = mutableSetOf<String>()
    var previous: String? = null
    for ((key, at) in moments) {
        if (at == null || at <= 0) continue
        val day = TimeFormat.day(at)
        if (day != previous) {
            breaks += key
            previous = day
        }
    }
    return breaks
}
