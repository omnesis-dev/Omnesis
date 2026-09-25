// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmFailureDetailLine
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog

/**
 * One stable, live researcher row. The detailed document working set belongs to
 * [ResearchWorkspace]; this transcript location only answers who is working, what
 * sources they have reached, and their reported usage.
 *
 * Laid out as the portal `.agent-subagent` and the iOS `AgentSubAgentCard` are: a
 * header row whose title takes only the space the fixed-width metadata cluster
 * (working dots, status, token counter) leaves it and ellipsizes into it, then the
 * failure lines, then the reached-source icons on their own wrapping row. Everything
 * but the title is measured at its intrinsic width, so a wordy researcher title can
 * never push the status, counter, or source icons off the card.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgentSubAgentCard(
    card: AgentSubagentCard,
    catalog: SourceCatalog = SourceCatalog(),
) {
    val running = card.status == null
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
            .background(OmTheme.colors.bgTertiary.copy(alpha = 0.5f))
            .border(1.dp, if (running) OmTheme.colors.accent.copy(alpha = 0.5f) else OmTheme.colors.border, RoundedCornerShape(10.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Group, null, tint = OmTheme.colors.accent, modifier = Modifier.size(13.dp))
            // The ONLY flexible cell on the row: it absorbs whatever the metadata
            // cluster leaves and ellipsizes, so the cluster is never squeezed out.
            Text(
                card.title.ifBlank { card.specialist },
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = OmTheme.colors.accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (running) AgentWaveDots(dotSize = 3.dp, spacing = 2.dp)
            Text(
                statusLabel(card),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                color = statusColor(card.status),
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${formatTokenCount(card.tokens)} tok",
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = OmTheme.colors.textMuted,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // A worker that ended badly explains itself under the header, at the same quiet
        // weight the transcript uses: the humanized sentence first, then the terminal
        // code — and the provider's disposition when one came back.
        card.failureDetail()?.let { detail ->
            Text(
                detail,
                style = MaterialTheme.typography.labelSmall,
                color = OmTheme.colors.danger,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (!running && card.status != "complete") {
            OmFailureDetailLine(card.failureCode, card.failureProviderDetail)
        }
        // The sources this researcher actually reached, each icon badged with how many
        // documents came from it. Their own wrapping row, so a reader that reaches more
        // sources than fit across the card wraps rather than clipping the tail off it.
        val sources = sourceCounts(card)
        if (sources.isNotEmpty()) {
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                sources.forEach { (sourceId, count) ->
                    Box(
                        // Room for the badge, which overhangs the icon's top-right corner.
                        Modifier.padding(top = 5.dp, end = 6.dp),
                        contentAlignment = Alignment.TopEnd,
                    ) {
                        SourceIcon(catalog.iconModel(sourceId), size = 16.dp)
                        Text(
                            formatSourceCount(count),
                            style = MaterialTheme.typography.labelSmall.copy(fontSize = 8.sp),
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            maxLines = 1,
                            modifier = Modifier
                                .offset(x = 6.dp, y = (-5).dp)
                                .clip(RoundedCornerShape(percent = 50))
                                .background(Color.Black)
                                .padding(horizontal = 3.dp, vertical = 1.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun sourceCounts(card: AgentSubagentCard): List<Pair<String, Int>> {
    val counts = linkedMapOf<String, Int>()
    card.docs.filter { it.sourceId.isNotBlank() }.forEach { doc -> counts[doc.sourceId] = (counts[doc.sourceId] ?: 0) + 1 }
    return counts.toList()
}

private fun statusLabel(card: AgentSubagentCard): String = when (card.status) {
    "complete" -> "Done"
    "failed" -> if (card.hasPartialResult) "Partial result" else "Couldn't finish"
    "budget_exhausted" -> "Stopped"
    else -> "Searching"
}
private fun AgentSubagentCard.failureDetail(): String? =
    summary?.takeIf { status != null && status != "complete" && !hasPartialResult && it.isNotBlank() }
@Composable private fun statusColor(status: String?) = when (status) {
    "complete" -> OmTheme.colors.success; "failed", "budget_exhausted" -> OmTheme.colors.danger; else -> OmTheme.colors.textMuted
}
private fun formatTokenCount(n: Int): String = if (n >= 1000) "%.1fk".format(n / 1000.0) else n.toString()

/** Keeps a prolific reader's per-source count one cell wide. Mirrors the portal `formatSourceCount`. */
internal fun formatSourceCount(count: Int): String = if (count > 99) "99+" else count.toString()
