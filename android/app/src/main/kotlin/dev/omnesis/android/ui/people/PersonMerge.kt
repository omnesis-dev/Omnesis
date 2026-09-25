// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Forward
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.MergedFromPerson

// MARK: - Merged-into banner (loser -> canonical)

/**
 * "Merged into [canonical]" card shown on a logical-merge loser. The whole card is the tap
 * target; tapping pushes the canonical's detail. Ported from the iOS `MergedIntoBanner` —
 * `OmnesisCard` chrome (bgSecondary + 1px border, radius 8) with a leading accent
 * forward/redirect glyph (filled, points right — matching the iOS
 * `arrowshape.turn.up.right.fill`), title, explanatory body, and a trailing chevron.
 */
@Composable
fun MergedIntoBanner(targetName: String?, onOpen: () -> Unit) {
    val c = OmTheme.colors
    OmnesisCard(modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(
                Icons.AutoMirrored.Filled.Forward,
                contentDescription = null,
                tint = c.accent,
                modifier = Modifier.padding(top = 1.dp).size(14.dp),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    "Merged into ${targetName ?: "another identity"}",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "You're seeing this row's pre-merge state. Edge counts and interaction scores live on the canonical.",
                    fontSize = 11.sp,
                    color = c.textSecondary,
                )
            }
            Spacer(Modifier.width(4.dp))
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

// MARK: - Merged-from summary (canonical -> losers)

/**
 * Concise "N people merged into this" card on a canonical, with a tinted `Details` button
 * that opens the full sheet. Ported from the iOS `MergedFromSummary`.
 */
@Composable
fun MergedFromSummary(count: Int, onShowDetails: () -> Unit) {
    val c = OmTheme.colors
    OmnesisCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Icons.Filled.Group, contentDescription = null, tint = c.accent, modifier = Modifier.size(13.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "$count ${if (count == 1) "person" else "people"} merged into this",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "Aliases, documents, and edge counts have been rolled up.",
                    fontSize = 11.sp,
                    color = c.textMuted,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(4.dp))
            Box(
                Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(c.accent.copy(alpha = 0.18f))
                    .clickable(onClick = onShowDetails)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text("Details", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.accent)
            }
        }
    }
}

// MARK: - Merged-from sheet body (full list)

/**
 * Body of the merged-from bottom sheet. The caller hosts the `ModalBottomSheet`; this renders
 * the header row (`N merged in` + `Done`), the roll-up blurb, and an `OmnesisCard` of
 * [MergedFromRow]s with inset hairlines. Ported from the iOS `MergedFromSheet`.
 */
@Composable
fun MergedFromSheetBody(
    merged: List<MergedFromPerson>,
    canonicalName: String,
    iconFor: (String) -> SourceIconModel,
    onDone: () -> Unit,
    onOpenPerson: (id: String, name: String?) -> Unit,
) {
    val c = OmTheme.colors
    Column(Modifier.fillMaxWidth().background(c.bgPrimary)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Spacer(Modifier.width(56.dp))
            Text(
                "${merged.size} merged in",
                style = MaterialTheme.typography.titleMedium,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
            )
            Box(Modifier.width(56.dp), contentAlignment = Alignment.CenterEnd) {
                Text(
                    "Done",
                    fontSize = 16.sp,
                    color = c.accent,
                    modifier = Modifier.clickable(onClick = onDone),
                )
            }
        }
        Column(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val target = canonicalName.ifBlank { "this person" }
            Text(
                "Aliases, documents, and edge counts from each identity below were rolled up into $target.",
                fontSize = 12.sp,
                color = c.textSecondary,
            )
            OmnesisCard(modifier = Modifier.fillMaxWidth(), padding = 0.dp) {
                merged.forEachIndexed { idx, person ->
                    MergedFromRow(person = person, iconFor = iconFor, onOpen = { onOpenPerson(person.id, person.canonicalName) })
                    if (idx < merged.size - 1) {
                        Spacer(
                            Modifier
                                .padding(start = 44.dp)
                                .fillMaxWidth()
                                .height(1.dp)
                                .background(c.borderLight),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MergedFromRow(
    person: MergedFromPerson,
    iconFor: (String) -> SourceIconModel,
    onOpen: () -> Unit,
) {
    val c = OmTheme.colors
    val name = person.canonicalName.ifBlank { "(no name)" }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        PeopleAvatar(name = name, isSelf = false, size = 28.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                name,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                personRelativeTime(person.appliedAt.takeIf { it.isNotBlank() })?.let { "merged $it" } ?: "merged",
                fontSize = 10.sp,
                color = c.textMuted,
            )
        }
        if (person.sourceIds.isNotEmpty()) {
            PersonSourceStrip(sourceIds = person.sourceIds, iconFor = iconFor, max = 4, size = 13.dp)
        }
        Icon(
            Icons.AutoMirrored.Outlined.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(10.dp),
        )
    }
}
