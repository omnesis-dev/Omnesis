// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devannotate

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import kotlinx.coroutines.launch

/**
 * Composer for filing one developer annotation (`OMNESIS_DEV_MODE`) — the
 * Android analogue of the iOS shake-to-annotate sheet and the portal's
 * floating ⚑ composer. The target is fixed when the dialog opens so it can't
 * shift under the operator while they type; [fileNote] posts it and throws on
 * failure, which surfaces inline rather than losing the draft.
 */
@Composable
fun DevAnnotationDialog(
    target: DevAnnotationTarget,
    fileNote: suspend (note: String) -> Unit,
    onClose: () -> Unit,
) {
    val colors = OmTheme.colors
    var note by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun submit() {
        val trimmed = note.trim()
        if (trimmed.isEmpty() || busy) return
        scope.launch {
            busy = true
            error = null
            try {
                fileNote(trimmed)
                onClose()
            } catch (e: Exception) {
                error = "Failed to file annotation: ${e.message}"
                busy = false
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        containerColor = colors.bgSecondary,
        title = { Text("Developer annotation", color = colors.textPrimary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
                Text(
                    target.label,
                    color = colors.textSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 3,
                )
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it; error = null },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("What's wrong or inconsistent here?") },
                    minLines = 4,
                )
                error?.let {
                    Text(it, color = colors.danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = ::submit, enabled = !busy && note.trim().isNotEmpty()) {
                Text(
                    if (busy) "Filing…" else "File",
                    color = if (busy) colors.textMuted else colors.accent,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onClose, enabled = !busy) {
                Text("Cancel", color = if (busy) colors.textMuted else colors.accent)
            }
        },
    )
}
