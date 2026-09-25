// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmFonts
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog

// ─── Verified-report artifact ─────────────────────────────────────
//
// The polished final-report enrichment at the end of a Deep Research run — the
// Android twin of the portal `ReportArtifact` and the iOS `ReportArtifactView`. The
// report PROSE (with its section headers) already streamed as ordinary
// `agent.text.delta` and renders in the assistant bubble above; this artifact is the
// structured layer that hangs below it:
//
//   - a verification badge ("N/N quotes verified") driven by the REAL tally on the
//     `agent.deep_research.summary` event (never a hardcoded "verified");
//   - the honest, rendered `stoppedReason`;
//   - inline citation markers — one numbered chip per merged citation that opens the
//     in-app document page through `onOpenDocument` (the single source-exit; Android
//     deep-links never go to an external URL);
//   - a report footer with the whole-tree token total from `treeUsage`.
//
// Strictly additive: the host renders it only when the turn carries `reportArtifact`
// (folded on by the reducer from the summary event). An older run / a resumed
// transcript that never carried the event has no `reportArtifact`, so this view never
// mounts and the bubble degrades to plain prose.
//
// Source encapsulation: each marker carries its source's glyph via
// `SourceCatalog.iconModel` keyed off the citation ref's `sourceId` — NEVER by branching
// on a source name. Rows are flat — the numbered index badge uses the app's single theme
// accent and the row sits directly on the card with no per-row fill or border (matching
// the portal), so the list reads clean and every source reads consistently regardless of
// how dark a source's brand accent is.

/**
 * The badge state the verification tally produces. Computed from the REAL
 * `{quotesChecked, quotesVerified}` counts — never hardcoded. A pure value type so it
 * unit-tests without Compose. Mirrors the iOS `ReportVerificationBadge`.
 */
data class ReportVerificationBadge(val kind: Kind, val text: String) {
    enum class Kind { NEUTRAL, OK, PARTIAL }

    companion object {
        fun of(verification: dev.omnesis.android.transport.dto.DeepResearchVerification): ReportVerificationBadge {
            val checked = verification.quotesChecked
            val verified = verification.quotesVerified
            return when {
                checked == 0 -> ReportVerificationBadge(Kind.NEUTRAL, "No quotes to verify")
                verified == checked -> ReportVerificationBadge(Kind.OK, "$verified/$checked quotes verified")
                else -> ReportVerificationBadge(Kind.PARTIAL, "$verified/$checked quotes verified")
            }
        }
    }
}

/**
 * The IN-APP deep-link target for one inline citation marker: the citation's own
 * `documentId`, opened through `onOpenDocument` → the in-app document page (the single
 * source-exit). Never an external URL. A pure helper so the deep-link target is asserted
 * directly in a unit test — a Roborazzi snapshot can't drive the marker tap/nav. Mirrors
 * the iOS marker target (the citation's `ref.documentId`).
 */
fun reportCitationTarget(citation: AgentCitation): String = citation.documentId

/**
 * Human label for an honest Deep Research terminal reason. Mirrors the portal
 * `STOPPED_REASON_LABEL` and the iOS `deepResearchStoppedReasonLabel`. An unknown reason
 * (forward-compat) falls back to the raw string rather than hiding it.
 */
fun deepResearchStoppedReasonLabel(reason: String): String = when (reason) {
    "answer_complete" -> "Answer complete"
    "no_results" -> "No verifiable findings"
    "budget_exhausted" -> "Sub-agent token budget exhausted"
    "depth_or_concurrency_capped" -> "Fan-out hit a structural cap"
    else -> reason
}

/**
 * The report-artifact panel rendered at the bottom of a Deep Research assistant turn.
 * [citations] is the parent turn's single merged citation set (no per-sub-agent
 * attribution — a frozen constraint); the host passes `state.chat.citations`.
 */
@Composable
fun ReportArtifact(
    artifact: AgentReportArtifact,
    citations: List<AgentCitation>,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    val badge = ReportVerificationBadge.of(artifact.verification)
    val treeTokens = artifact.treeUsage?.total ?: 0

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(OmTheme.colors.accent.copy(alpha = 0.05f))
            .border(1.dp, OmTheme.colors.accent.copy(alpha = 0.18f), RoundedCornerShape(OmRadius.large))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Header(badge, artifact.stoppedReason)
        if (treeTokens > 0) Footer(treeTokens)
    }
}

@Composable
private fun Header(badge: ReportVerificationBadge, stoppedReason: String) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val tint = badgeColor(badge.kind)
        Row(
            Modifier
                .clip(CircleShape)
                .background(tint.copy(alpha = 0.12f))
                .padding(horizontal = 7.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(badgeIcon(badge.kind), contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))
            Text(
                badge.text,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = tint,
            )
        }
        Text(
            deepResearchStoppedReasonLabel(stoppedReason),
            style = MaterialTheme.typography.labelSmall,
            color = OmTheme.colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun badgeIcon(kind: ReportVerificationBadge.Kind): ImageVector = when (kind) {
    ReportVerificationBadge.Kind.OK -> Icons.Filled.CheckCircle
    ReportVerificationBadge.Kind.PARTIAL -> Icons.Filled.Warning
    ReportVerificationBadge.Kind.NEUTRAL -> Icons.Outlined.Search
}

@Composable
private fun badgeColor(kind: ReportVerificationBadge.Kind): Color = when (kind) {
    ReportVerificationBadge.Kind.OK -> OmTheme.colors.success
    ReportVerificationBadge.Kind.PARTIAL -> OmTheme.colors.warning
    ReportVerificationBadge.Kind.NEUTRAL -> OmTheme.colors.textMuted
}

@Composable
private fun CitationList(
    citations: List<AgentCitation>,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        val noun = if (citations.size == 1) "SOURCE" else "SOURCES"
        Text(
            "${citations.size} $noun",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = OmTheme.colors.textMuted,
        )
        citations.forEachIndexed { idx, citation ->
            CitationMarker(idx + 1, citation, catalog, onOpenDocument)
        }
    }
}

/**
 * One numbered inline citation marker. Tappable — opens the in-app document page via
 * [onOpenDocument] (the single source-exit). The index badge uses the single theme accent
 * (consistent across sources, matching the portal); only the source glyph — resolved from
 * the source registry ([catalog]) by `sourceId` — conveys per-source identity.
 */
@Composable
private fun CitationMarker(
    index: Int,
    citation: AgentCitation,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    val title = citation.ref.title?.takeIf { it.isNotBlank() } ?: citation.documentId
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpenDocument(reportCitationTarget(citation)) }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier.size(18.dp).clip(CircleShape).background(OmTheme.colors.accent.copy(alpha = 0.16f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                index.toString(),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = OmTheme.colors.accent,
            )
        }
        SourceIcon(model = catalog.iconModel(citation.ref.sourceId), size = 13.dp)
        Text(
            title,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = OmFonts.inter),
            color = OmTheme.colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun Footer(treeTokens: Int) {
    Text(
        "${formatTokenCount(treeTokens)} research tokens",
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
        color = OmTheme.colors.textMuted,
    )
}

/** Compact token count: 1234 → "1.2k", below 1000 stays exact. Matches the card / workspace. */
private fun formatTokenCount(n: Int): String =
    if (n >= 1000) "%.1fk".format(n / 1000.0) else n.toString()
