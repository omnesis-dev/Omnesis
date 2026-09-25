// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.AnnotationDependent
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.OffsetDateTime
import kotlin.math.roundToInt

/**
 * The agent's durable LLM-derived observations, rendered as a flat section. Person
 * annotations (about a person) and document annotations (grounded on a document) share the
 * same wire shape — claimType / claimText / confidence / evidenceQuote — so one section
 * serves both surfaces (the person detail + the document inspector). [title] is a full
 * sentence supplied by the caller ("Enriched by Omnesis", "Profile", or "What Omnesis has
 * learned about <name>"). Confidence is surfaced verbatim: these are defeasible
 * observations, not hard facts. Renders nothing when [annotations] is empty and
 * there is no pending page; an empty cursor-bearing page keeps only its sentinel
 * so pagination can make progress.
 *
 * The header is bespoke (sparkle + sentence-case title) rather than the shared
 * uppercase-rule `PeopleSectionHeader`/`FlatSectionHeader`: uppercasing a sentence title
 * like "What Omnesis has learned about Maya Reeves" mangles it. Matches the iOS
 * `AnnotationsSection` and the portal `AnnotationList` so the three clients read alike.
 */
fun LazyListScope.annotationsSectionItems(
    listState: LazyListState,
    keyPrefix: String,
    title: String,
    annotations: List<Annotation>,
    paging: CursorPagingState = CursorPagingState(),
    onLoadMore: () -> Unit = {},
    dependents: Map<String, AnnotationDependentsUi> = emptyMap(),
    onToggleDependents: (Annotation) -> Unit = {},
    onLoadMoreDependents: (Annotation) -> Unit = {},
) {
    if (
        annotations.isEmpty() &&
        !paging.canLoadMore &&
        !paging.isLoadingMore &&
        paging.paginationError == null &&
        paging.refreshError == null
    ) {
        return
    }
    if (annotations.isNotEmpty()) {
        item("$keyPrefix:header") {
            AnnotationsHeader(title)
        }
        annotations.forEachIndexed { index, annotation ->
            item("$keyPrefix:annotation:${annotation.id}") {
                AnnotationRow(
                    annotation = annotation,
                    dependents = dependents[annotation.id],
                    onToggleDependents = { onToggleDependents(annotation) },
                )
            }
            val dependentState = dependents[annotation.id]
            if (dependentState?.expanded == true) {
                items(
                    dependentState.items,
                    key = { "$keyPrefix:dependent:${annotation.id}:${it.kind}:${it.id}" },
                ) { dependent ->
                    AnnotationDependentRow(dependent)
                }
                item("$keyPrefix:dependents-footer:${annotation.id}") {
                    val boundaryKey = "$keyPrefix:dependents-footer:${annotation.id}"
                    if (dependentState.shouldRetryFirstPage) {
                        AutomaticPagingBoundary(
                            listState = listState,
                            boundaryKey = boundaryKey,
                            loadToken = null,
                            isLoading = false,
                            errorMessage = "Couldn't load uses.",
                            retryLabel = "Retry loading uses",
                            onLoadMore = { onLoadMoreDependents(annotation) },
                        )
                    } else {
                        ListPagingFooter(
                            listState = listState,
                            boundaryKey = boundaryKey,
                            paging = dependentState.paging,
                            onLoadMore = { onLoadMoreDependents(annotation) },
                            loadAction = "more uses",
                        )
                    }
                }
            }
            if (index < annotations.lastIndex) {
                item("$keyPrefix:divider:${annotation.id}") {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(1.dp)
                            .background(OmTheme.colors.borderLight),
                    )
                }
            }
        }
    }
    item("$keyPrefix:paging") {
        ListPagingFooter(
            listState = listState,
            boundaryKey = "$keyPrefix:paging",
            paging = paging,
            onLoadMore = onLoadMore,
            loadAction = "more observations",
        )
    }
}

data class AnnotationDependentsUi(
    val expanded: Boolean = false,
    val loading: Boolean = false,
    val items: List<AnnotationDependent> = emptyList(),
    val paging: CursorPagingState = CursorPagingState(),
) {
    val shouldRetryFirstPage: Boolean
        get() = items.isEmpty() && paging.refreshError != null
}

/**
 * Accent-tinted sparkle marks the section as Omnesis-derived (agent) data, distinct from
 * source-provided fields; the sentence-case title is kept verbatim (no uppercase, no rule).
 */
@Composable
private fun AnnotationsHeader(title: String) {
    val c = OmTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Outlined.AutoAwesome,
            contentDescription = null,
            tint = c.accent,
            modifier = Modifier.size(13.dp),
        )
        Text(
            title,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textSecondary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
internal fun AnnotationRow(
    annotation: Annotation,
    dependents: AnnotationDependentsUi?,
    onToggleDependents: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        // Claim-type label + basis chip on the left; the verification marker
        // and the confidence right-aligned. The left group is a weighted inner
        // row so a long claim type still ellipsizes instead of pushing the
        // tail off screen.
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    annotation.claimType,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                val basis = annotation.claimBasis
                if (!basis.isNullOrEmpty()) {
                    Text(
                        basis,
                        fontSize = 10.sp,
                        color = c.textMuted,
                        maxLines = 1,
                        modifier = Modifier
                            .background(c.bgTertiary, RoundedCornerShape(50))
                            .padding(horizontal = 6.dp, vertical = 1.dp),
                    )
                }
            }
            val verification = verificationLabel(annotation)
            if (verification != null) {
                Text(
                    verification,
                    fontSize = 10.sp,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                "${(annotation.confidence * 100).roundToInt()}%",
                fontSize = 11.sp,
                color = c.textMuted,
                style = TextStyle(fontFeatureSettings = "tnum"),
            )
        }
        Text(annotation.claimText, fontSize = 13.sp, color = c.textPrimary)
        val quote = annotation.evidenceQuote
        if (quote != null && quote.isNotEmpty()) {
            Text(
                "“$quote”",
                fontSize = 12.sp,
                fontStyle = FontStyle.Italic,
                color = c.textMuted,
            )
        }
        if (annotation.dependentCount > 0) {
            TextButton(
                onClick = onToggleDependents,
                enabled = dependents?.loading != true,
                modifier = Modifier.padding(horizontal = 0.dp),
            ) {
                if (dependents?.loading == true) {
                    dev.omnesis.android.designsystem.components.OmSpinner(Modifier.size(14.dp))
                    Spacer(Modifier.width(OmSpacing.xs))
                    Text("Loading uses…")
                } else {
                    Text(
                        if (dependents?.expanded == true) {
                            "Hide where this was used"
                        } else {
                            "Used by ${annotation.dependentCount} " +
                                if (annotation.dependentCount == 1) "output" else "outputs"
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun AnnotationDependentRow(dependent: AnnotationDependent) {
    val c = OmTheme.colors
    Text(
        "${dependent.kind.uppercase()} · ${dependent.title.ifBlank { dependent.id }}",
        fontSize = 11.sp,
        color = c.textSecondary,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .background(c.bgTertiary, RoundedCornerShape(OmTheme.radius.small))
            .padding(horizontal = OmSpacing.sm, vertical = OmSpacing.xs),
    )
}

/**
 * Entailment-check marker: "verified · 2d ago" when the last check time is
 * known, the bare state otherwise, null when the row carries no stamp.
 */
private fun verificationLabel(annotation: Annotation): String? {
    val state = annotation.verificationState?.takeIf { it.isNotEmpty() } ?: return null
    val checkedAt = annotation.lastVerifiedAt?.let(::parseIsoToEpochMillis) ?: return state
    // Beyond the relative window, keep the marker SHORT (a bare date) — the
    // portal and iOS render a short date for old stamps, and the full
    // date-time form would crowd the claim type off a narrow row.
    val relative = TimeFormat.relative(checkedAt)
    val label = if (relative.length > 12) shortDate(checkedAt) else relative
    return "$state · $label"
}

private fun shortDate(epochMillis: Long): String =
    DateTimeFormatter.ofPattern("d MMM")
        .withZone(ZoneId.systemDefault())
        .format(Instant.ofEpochMilli(epochMillis))

/** Lenient ISO-8601 parse (instant or offset form); null when unparseable. */
private fun parseIsoToEpochMillis(iso: String): Long? =
    runCatching { Instant.parse(iso).toEpochMilli() }
        .recoverCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }
        .getOrNull()
