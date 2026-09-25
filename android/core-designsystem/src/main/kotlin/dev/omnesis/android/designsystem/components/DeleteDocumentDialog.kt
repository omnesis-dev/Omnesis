// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * The two ways to delete a document, explained once for every delete prompt.
 * "For good" writes the gateway's durable tombstone; "this copy" leaves the
 * source free to bring the document back.
 */
const val DELETE_DOCUMENT_EXPLANATION =
    "Delete for good: removed, and a later sync or capture will not add it back. Delete this copy: removed now, but a later sync or capture may add it again."

/**
 * The delete prompt shared by the document screen and a source's recent list:
 * delete for good, or delete this copy only. [onDelete] receives `true` for a
 * copy-only delete. Generated Notes day documents are read-only and never
 * reach this prompt — they are managed on Tell Omnesis instead.
 */
@Composable
fun DeleteDocumentDialog(
    title: String,
    onDismiss: () -> Unit,
    onDelete: (keepCopy: Boolean) -> Unit,
) {
    val c = OmTheme.colors
    AlertDialog(
        containerColor = c.bgSecondary,
        onDismissRequest = onDismiss,
        title = { Text(title, color = c.textPrimary) },
        text = {
            Text(
                DELETE_DOCUMENT_EXPLANATION,
                color = c.textSecondary,
            )
        },
        confirmButton = {
            TextButton(onClick = { onDelete(false) }) {
                Text("Delete for good", color = c.danger)
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onDismiss) {
                    Text("Cancel", color = c.accent)
                }
                TextButton(onClick = { onDelete(true) }) {
                    Text("Delete this copy", color = c.danger)
                }
            }
        },
    )
}
