// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.AgentPlanItem

/**
 * Pinned TODO panel rendered above the composer while the agent works through a multi-step
 * plan. NOT a bordered Material card: a flat panel on `bgPrimary` with a 2-dp
 * `accent @ 0.5` left rail, 22-dp rows, bare checkmark for done (strikethrough label),
 * filled dot for in-progress (white label + trailing spinner), hollow circle for pending.
 * Mirrors iOS `AgentPlanPanel` in `AgentPlanPanel.swift`. Collapses to height 0 when empty.
 */
@Composable
fun AgentPlanPanel(items: List<AgentPlanItem>, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = items.isNotEmpty(),
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically(),
        modifier = modifier,
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .background(OmTheme.colors.bgPrimary)
                .padding(horizontal = OmTheme.spacing.lg, vertical = 6.dp),
        ) {
            // `height(IntrinsicSize.Min)` hugs the Row to its rows' intrinsic height so the
            // `fillMaxHeight` rail tracks the content instead of claiming all the surplus
            // vertical space the bottom-anchored container offers (the iOS `fixedSize`
            // problem — without it the rail stretches the full screen).
            Row(
                modifier = Modifier.height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Box(
                    Modifier
                        .width(2.dp)
                        .fillMaxHeight()
                        .background(OmTheme.colors.accent.copy(alpha = 0.5f)),
                )
                Column(Modifier.weight(1f).padding(vertical = 2.dp)) {
                    items.forEach { item -> AgentPlanRow(item) }
                }
            }
        }
    }
}

@Composable
private fun AgentPlanRow(item: AgentPlanItem) {
    val colors = OmTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().height(22.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.width(14.dp), contentAlignment = Alignment.Center) {
            when (item.status) {
                "done" -> Icon(
                    Icons.Filled.Check,
                    contentDescription = null,
                    tint = colors.success,
                    modifier = Modifier.size(12.dp),
                )

                "in_progress" -> Box(
                    Modifier
                        .size(9.dp)
                        .clip(CircleShape)
                        .background(colors.accent),
                )

                else -> Box(
                    // Hollow ring: an 11-dp circle stroked in textMuted.
                    Modifier
                        .size(11.dp)
                        .border(1.dp, colors.textMuted, CircleShape),
                )
            }
        }

        Text(
            item.label,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
            color = if (item.status == "in_progress") colors.textPrimary else colors.textMuted,
            textDecoration = if (item.status == "done") TextDecoration.LineThrough else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )

        Spacer(Modifier.weight(1f))

        if (item.status == "in_progress") {
            OmSpinner(
                modifier = Modifier.size(14.dp),
                color = colors.accent,
                strokeWidth = 1.5.dp,
            )
        }
    }
}
