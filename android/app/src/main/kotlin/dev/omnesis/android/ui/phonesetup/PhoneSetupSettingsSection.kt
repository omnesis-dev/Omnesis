// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.setup.ui.SetupBrandTint
import dev.omnesis.android.setup.ui.asSetupForeground
import dev.omnesis.android.setup.ui.setupPalette

/**
 * The top of Settings' phone-source area: the row that reopens the phone setup
 * flow with how many sources are on — disabled until the session can run it
 * — and, while Android's unused-app restrictions can apply to Omnesis,
 * whether background syncing is protected.
 */
@Composable
fun PhoneSetupSettingsSection(
    summary: PhoneSetupSummary,
    setupReady: Boolean,
    backgroundSyncing: BackgroundSyncingState?,
    onOpenSetup: () -> Unit,
    onOpenBackgroundSettings: () -> Unit,
) {
    val c = OmTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(OmSpacing.md))
        Text(
            "THIS PHONE",
            style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 0.5.sp),
            fontWeight = FontWeight.SemiBold,
            color = c.textSecondary,
            modifier = Modifier.padding(top = OmSpacing.sm, bottom = OmSpacing.xs),
        )
        OmnesisCard(padding = OmSpacing.lg) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .alpha(if (setupReady) 1f else 0.5f)
                    .clickable(enabled = setupReady, role = Role.Button, onClick = onOpenSetup)
                    .padding(vertical = OmSpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
            ) {
                RowGlyph(Icons.Outlined.Smartphone, SetupBrandTint)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Set up this phone", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                    Text("${summary.on} of ${summary.total} sources on", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(20.dp))
            }
            if (backgroundSyncing != null) {
                HorizontalDivider(Modifier.padding(vertical = OmSpacing.xs), thickness = 1.dp, color = c.borderLight)
                Row(
                    Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
                ) {
                    RowGlyph(BackgroundSyncingSetupCopy.glyph, BackgroundSyncingSetupCopy.tint)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Background syncing", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                        Text(
                            when (backgroundSyncing) {
                                BackgroundSyncingState.ON -> "On"
                                BackgroundSyncingState.LIMITED -> "Android may pause Omnesis when it goes unused"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = if (backgroundSyncing == BackgroundSyncingState.ON) c.success else c.warning,
                        )
                    }
                    TextButton(onClick = onOpenBackgroundSettings) { Text("Open Settings", color = c.accent) }
                }
            }
        }
    }
}

@Composable
private fun RowGlyph(icon: ImageVector, tint: Color) {
    Box(
        Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(tint.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint.asSetupForeground(setupPalette), modifier = Modifier.size(20.dp))
    }
}
