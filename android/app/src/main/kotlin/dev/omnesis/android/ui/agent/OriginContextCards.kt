// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.BriefOriginSnapshot
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.WatchFiringOriginSnapshot
import dev.omnesis.android.ui.common.TimeFormat

/**
 * The card pinned above an anchored thread's messages, saying what the thread is a reply to.
 *
 * A brief thread or a watch-firing thread opens with the creating run's folded transcript —
 * the agent's own context, not something the user wrote — which the gateway hides. This card
 * takes its place, so the thread reads as a reply to a specific thing rather than as a chat
 * that mysteriously begins mid-conversation. Draws nothing for an origin this build does not
 * recognise, which is the same condition under which the seeded prefix stays visible.
 */
@Composable
fun ConversationOriginCard(
    origin: ConversationOrigin?,
    modifier: Modifier = Modifier,
    onOpenWatch: ((String) -> Unit)? = null,
) {
    // Gated on the same predicate that decides whether the seeded prefix may be hidden. The two
    // must never disagree: hiding the prefix while drawing nothing leaves an empty screen.
    if (!hasContextCard(origin)) return
    when (origin?.kind) {
        "brief" -> origin.brief?.let { BriefContextCard(it, modifier) }
        "watch_firing" -> origin.watch?.let { snapshot ->
            val watchId = origin.watchId?.takeIf(String::isNotBlank)
            WatchFiringContextCard(
                snapshot = snapshot,
                modifier = modifier,
                onOpen = if (watchId != null && onOpenWatch != null) {
                    { onOpenWatch(watchId) }
                } else {
                    null
                },
            )
        }
    }
}

@Composable
private fun WatchFiringContextCard(
    snapshot: WatchFiringOriginSnapshot,
    modifier: Modifier = Modifier,
    onOpen: (() -> Unit)? = null,
) {
    val c = OmTheme.colors
    val cardModifier = if (onOpen == null) {
        modifier.semantics(mergeDescendants = true) {}
    } else {
        modifier
            .clickable(
                onClickLabel = "Open watch details",
                role = Role.Button,
                onClick = onOpen,
            )
            .semantics(mergeDescendants = true) {}
    }
    OriginCardFrame(cardModifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OriginCardKicker(Icons.Outlined.NotificationsActive, "Watch fired")
            if (onOpen != null) {
                Row(
                    modifier = Modifier.weight(1f),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "View watch",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.accent,
                    )
                    Icon(
                        Icons.Outlined.ChevronRight,
                        contentDescription = null,
                        tint = c.accent,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Text(
            snapshot.name,
            fontSize = 20.sp,
            lineHeight = 26.sp,
            fontWeight = FontWeight.Bold,
            color = c.textPrimary,
        )
        // A heading rather than a sentence stem: the condition is quoted verbatim in the
        // operator's own words, often first person, so "you asked to be told when…" would
        // clash on person.
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                "WATCHING FOR",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = c.textSecondary.copy(alpha = 0.7f),
            )
            Text(
                snapshot.condition,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                color = c.textSecondary,
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Outlined.Schedule,
                contentDescription = null,
                tint = c.textSecondary,
                modifier = Modifier.size(14.dp),
            )
            Text(
                TimeFormat.dateTime(snapshot.firedAt),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = c.textSecondary,
            )
        }
    }
}

@Composable
private fun BriefContextCard(snapshot: BriefOriginSnapshot, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    // Collapsed by default: a brief's body can run long, and the thread below it is what the
    // reader came for.
    var bodyExpanded by rememberSaveable { mutableStateOf(false) }
    val body = snapshot.body?.takeIf { it.isNotEmpty() }
    // Announced as one card rather than as four loose nodes.
    OriginCardFrame(modifier.semantics(mergeDescendants = true) {}) {
        OriginCardKicker(Icons.Outlined.Description, "Brief")
        Text(
            snapshot.title,
            fontSize = 20.sp,
            lineHeight = 26.sp,
            fontWeight = FontWeight.Bold,
            color = c.textPrimary,
        )
        MarkdownText(
            markdown = snapshot.description,
            color = c.textPrimary,
            style = MaterialTheme.typography.bodyLarge,
        )
        if (body != null) {
            HorizontalDivider(color = c.borderLight)
            if (bodyExpanded) {
                MarkdownText(
                    markdown = body,
                    color = c.textPrimary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            val toggleLabel = if (bodyExpanded) "Hide details" else "Show details"
            Row(
                modifier = Modifier
                    .clickable { bodyExpanded = !bodyExpanded }
                    .clearAndSetSemantics {
                        contentDescription = if (bodyExpanded) {
                            "Hide the brief's details"
                        } else {
                            "Show the brief's details"
                        }
                    },
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    toggleLabel,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.accent,
                )
                Icon(
                    if (bodyExpanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                    contentDescription = null,
                    tint = c.accent,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

@Composable
private fun OriginCardFrame(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = OmTheme.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(OmRadius.large))
            .border(1.dp, c.border, RoundedCornerShape(OmRadius.large))
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        content = content,
    )
}

@Composable
private fun OriginCardKicker(icon: ImageVector, label: String) {
    val c = OmTheme.colors
    Row(
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = c.accent, modifier = Modifier.size(13.dp))
        Text(
            label.uppercase(),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            color = c.accent,
        )
    }
}
