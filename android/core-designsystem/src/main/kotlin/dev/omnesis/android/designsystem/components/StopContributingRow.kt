// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

/** The one line every phone-hosted source's settings card ends with. */
const val STOP_CONTRIBUTING_LABEL = "Stop contributing from this device"

/**
 * The opt-out row shared by every phone-hosted source's settings card: a
 * danger-tinted action that asks once before it stops the phone contributing.
 * Turning a source off on the phone also takes this device off the source's
 * host list on the gateway, so the copy is the same everywhere and lives here
 * rather than in each source's section.
 */
@Composable
fun StopContributingRow(
    onConfirm: () -> Unit,
) {
    var confirming by remember { mutableStateOf(false) }
    Text(
        STOP_CONTRIBUTING_LABEL,
        style = MaterialTheme.typography.bodyMedium,
        color = OmTheme.colors.danger,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { confirming = true }
            .padding(vertical = OmSpacing.xs),
    )
    if (confirming) {
        StopContributingDialog(
            onConfirm = {
                confirming = false
                onConfirm()
            },
            onDismiss = { confirming = false },
        )
    }
}

/**
 * The confirmation behind [StopContributingRow]. Partitioned sources remove
 * only this device's stream when a sibling remains; shared/exclusive sources
 * retain their rows. A last member is paused rather than detached in either
 * case, so its data remains available.
 */
@Composable
fun StopContributingDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = OmTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgSecondary,
        title = { Text("Stop contributing from this device?", color = c.textPrimary) },
        text = {
            Text(
                "Stops uploads from this phone. For a partitioned source with another member, " +
                    "this removes this phone's gateway data; sibling streams stay. Shared data stays. " +
                    "If this is the last member, the source is paused and data is kept. " +
                    "Ownership can pass to another member.\n\n" +
                    "The gateway uses membership at execution time, including after reconnect. " +
                    "Offline requests stay queued. Re-enabling cannot undo deletion already started.\n\n" +
                    "Originals on the phone or provider, backups and exports are not deleted. " +
                    "This is not physical secure erasure.",
                color = c.textSecondary,
                style = MaterialTheme.typography.bodySmall,
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text("Stop", color = c.danger) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = c.accent) }
        },
    )
}
