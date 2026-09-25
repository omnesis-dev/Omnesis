// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmFonts
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog

// ─── Research working-set surface (#748) ─────────────────────────────────
//
// The bespoke multi-panel research working-set surface — the Android twin of the
// portal `ResearchWorkspace` and the iOS `ResearchWorkspaceView`. During a Deep
// Research run the agent screen shows "N researchers side by side": one panel per
// reader sub-agent, each accumulating its source-tinted documents LIVE as the run
// proceeds (reduced from the real `agent.subagent.*` stream by
// `AgentReducer.reduceChildEvent` → `AgentReducer.researchPanels`).
//
// Rendered only while `AgentReducer.isResearchWorkspaceActive` holds (a live run with
// ≥1 researcher); the host unmounts it when the run ends, so the surface "collapses
// into the report" (the written-back assistant turn).
//
// This is deliberately NOT the citation drawer re-skinned: a dedicated horizontal
// workspace with its own visual language — a framed accent band with a live pulse
// header, a horizontally-scrolling rail of researcher panels, each with a status rail
// and a flowing column of source-tinted document chips.
//
// Source encapsulation: every document is tinted by its source registry entry
// (`SourceCatalog.iconModel`/`accentColor` keyed off the ref's `sourceId`) — NEVER by
// branching on a source name. A source the registry doesn't know falls back to a
// neutral accent + the generic doc glyph, so the surface degrades gracefully.

/**
 * The multi-panel research working-set band. [panels] is [AgentReducer.researchPanels]
 * — one descriptor per sub-agent, in spawn order. Renders nothing when empty (the host
 * gates on [AgentReducer.isResearchWorkspaceActive], but the guard keeps the view
 * self-contained).
 */
@Composable
fun ResearchWorkspace(
    panels: List<AgentResearchPanel>,
) {
    if (panels.isEmpty()) return
    val complete = panels.count { it.status == "complete" }

    Column(
        Modifier
            .fillMaxWidth()
            // Bound the whole band so it stays a fixed bottom rail and never grows
            // into a full-screen overlay that covers (and blocks scrolling of) the
            // conversation above it (#890).
            // A faint accent wash + top hairline marks the band as a distinct workspace
            // region, not a transcript bubble.
            .background(OmTheme.colors.accent.copy(alpha = 0.06f))
            .padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Top hairline.
        Box(Modifier.fillMaxWidth().size(1.dp).background(OmTheme.colors.accent.copy(alpha = 0.35f)))
        Header(panels.size, complete)
        Rail(panels)
    }
}

@Composable
private fun Header(researcherCount: Int, complete: Int) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = OmTheme.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        LivePulse()
        Icon(
            Icons.Outlined.TravelExplore,
            contentDescription = null,
            tint = OmTheme.colors.accent,
            modifier = Modifier.size(13.dp),
        )
        Text(
            "Deep Research",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Bold,
            color = OmTheme.colors.accent,
        )
        Text(
            "$complete of $researcherCount complete",
            style = MaterialTheme.typography.labelSmall,
            color = OmTheme.colors.textMuted,
        )
    }
}

@Composable
private fun Rail(
    panels: List<AgentResearchPanel>,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = OmTheme.spacing.lg),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        for (panel in panels) {
            Text(
                panel.title.ifBlank { panel.specialist },
                style = MaterialTheme.typography.labelSmall,
                color = if (panel.status == "complete") OmTheme.colors.success else OmTheme.colors.textSecondary,
                maxLines = 1,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(OmTheme.colors.bgSecondary)
                    .padding(horizontal = 8.dp, vertical = 5.dp),
            )
        }
    }
}

/**
 * One researcher's panel: specialist + task header, a status rail, a live meta line, and
 * a flowing column of source-tinted document chips.
 */
@Composable
private fun ResearchPanelCard(
    panel: AgentResearchPanel,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    val running = panel.status == null
    Column(
        Modifier
            .width(232.dp)
            .clip(RoundedCornerShape(OmRadius.large))
            .background(OmTheme.colors.bgSecondary)
            .border(
                1.dp,
                if (running) OmTheme.colors.accent.copy(alpha = 0.5f) else OmTheme.colors.border,
                RoundedCornerShape(OmRadius.large),
            )
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PanelHead(panel, running)
        PanelMeta(panel)
        PanelDocs(panel, catalog, onOpenDocument)
        panel.summary?.takeIf { it.isNotEmpty() }?.let { summary ->
            Text(
                summary,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = OmFonts.inter),
                color = OmTheme.colors.textSecondary,
            )
        }
    }
}

@Composable
private fun PanelHead(panel: AgentResearchPanel, running: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(
                Icons.Outlined.PersonSearch,
                contentDescription = null,
                tint = OmTheme.colors.accent,
                modifier = Modifier.size(13.dp),
            )
            Text(
                panel.specialist,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = OmTheme.colors.accent,
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            StatusPill(panel.status, running)
        }
        Text(
            panel.task,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = OmFonts.inter),
            color = OmTheme.colors.textSecondary,
            maxLines = 2,
        )
    }
}

@Composable
private fun StatusPill(status: String?, running: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (running) OmSpinner(Modifier.size(10.dp), strokeWidth = 1.5.dp, color = OmTheme.colors.accent)
        Text(
            statusLabel(status),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = statusColor(status),
        )
    }
}

@Composable
private fun PanelMeta(panel: AgentResearchPanel) {
    val docNoun = if (panel.docs.size == 1) "document" else "documents"
    val stepNoun = if (panel.stepCount == 1) "step" else "steps"
    var line = "${panel.docs.size} $docNoun · ${panel.stepCount} $stepNoun"
    if (panel.tokens > 0) line += " · ${formatTokenCount(panel.tokens)} tok"
    Text(
        line,
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
        color = OmTheme.colors.textMuted,
    )
}

@Composable
private fun PanelDocs(
    panel: AgentResearchPanel,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    if (panel.docs.isEmpty()) {
        Text(
            if (panel.status == null) "Gathering sources…" else "No documents.",
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = OmFonts.inter),
            color = OmTheme.colors.textMuted,
            modifier = Modifier.padding(vertical = 6.dp),
        )
    } else {
        // Cap the per-panel doc list and scroll WITHIN the panel so a researcher
        // that reaches dozens of docs can't grow the panel taller than the screen
        // and bury the conversation (#890). The rail scrolls horizontally; this is
        // the orthogonal vertical axis.
        Column(
            Modifier
                .heightIn(max = 150.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            for (doc in panel.docs) ResearchDocChip(doc, catalog, onOpenDocument)
        }
    }
}

/**
 * One flat document row in a researcher's working set. Tappable — opens the in-app
 * document page via [onOpenDocument], the same single source-exit the rest of the agent
 * surface uses. The source icon + title sit flat on the panel, the icon resolved from the
 * source registry ([catalog]) by `sourceId`; an unknown source falls back to the generic
 * doc glyph.
 */
@Composable
private fun ResearchDocChip(
    doc: AgentResearchDoc,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpenDocument(doc.documentId) }
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        SourceIcon(model = catalog.iconModel(doc.sourceId), size = 13.dp)
        Text(
            doc.title?.takeIf { it.isNotBlank() } ?: "Untitled",
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = OmFonts.inter),
            color = OmTheme.colors.textPrimary,
            maxLines = 1,
        )
    }
}

/**
 * A small pulsing dot signalling a live run. Under [LocalInspectionMode] (Roborazzi /
 * Compose preview) it renders a static dot — an unbounded animation never idles and would
 * hang the native screenshot capture otherwise (the OmSpinner pattern).
 */
@Composable
private fun LivePulse() {
    val alpha = if (LocalInspectionMode.current) {
        1f
    } else {
        val transition = rememberInfiniteTransition(label = "researchPulse")
        val a by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
            label = "researchPulseAlpha",
        )
        a
    }
    Box(
        Modifier
            .size(7.dp)
            .clip(RoundedCornerShape(50))
            .background(OmTheme.colors.accent.copy(alpha = alpha)),
    )
}

private fun statusLabel(status: String?): String = when (status) {
    null -> "searching…"
    "complete" -> "done"
    "failed" -> "failed"
    "budget_exhausted" -> "budget"
    else -> status
}

@Composable
private fun statusColor(status: String?): Color = when (status) {
    "complete" -> OmTheme.colors.success
    "failed", "budget_exhausted" -> OmTheme.colors.danger
    else -> OmTheme.colors.textMuted
}

/** Compact token count: 1234 → "1.2k", below 1000 stays exact. */
private fun formatTokenCount(n: Int): String =
    if (n >= 1000) "%.1fk".format(n / 1000.0) else n.toString()
