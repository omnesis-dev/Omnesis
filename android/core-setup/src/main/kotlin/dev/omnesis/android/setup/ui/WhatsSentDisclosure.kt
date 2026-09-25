// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.NorthEast
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.setup.SetupStepCopy

/**
 * The compact "What's sent" row on a source's Settings card: collapsed by
 * default, and when opened the same disclosure and ledger its setup page
 * shows, from the same copy.
 */
@Composable
fun SetupWhatsSentDisclosure(copy: SetupStepCopy, modifier: Modifier = Modifier, initiallyExpanded: Boolean = false) {
    val ledger = copy.ledger ?: return
    var expanded by rememberSaveable { mutableStateOf(initiallyExpanded) }
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.bgSecondary)
            .border(1.dp, c.border, shape),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide what's sent" else "Show what's sent") {
                    expanded = !expanded
                }
                .padding(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Icon(Icons.Outlined.NorthEast, contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(16.dp))
            Text("What's sent", style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, modifier = Modifier.weight(1f))
            Icon(
                if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(20.dp),
            )
        }
        if (expanded) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderLight))
            Column(Modifier.fillMaxWidth().padding(horizontal = OmSpacing.lg, vertical = OmSpacing.xs)) {
                copy.disclosure?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                        modifier = Modifier.padding(top = OmSpacing.sm),
                    )
                }
                Spacer(Modifier.height(OmSpacing.sm))
                SetupLedgerSections(ledger)
            }
        }
    }
}
