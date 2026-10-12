// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.TaskDocumentDto

/**
 * The documents a task refers to, under its title: each its source's icon then its title,
 * opening the document on tap. A long list shows the first few and a "+N more" that reveals
 * the rest. [iconFor] resolves a source id to its icon through the source catalog.
 */
@Composable
internal fun TaskDocuments(
    documents: List<TaskDocumentDto>,
    iconFor: (String) -> SourceIconModel,
    onOpen: (TaskDocumentDto) -> Unit,
) {
    var showAll by rememberSaveable { mutableStateOf(false) }
    val list = taskDocumentsShown(documents, showAll)
    if (list.shown.isEmpty()) return
    val c = OmTheme.colors
    Column(Modifier.fillMaxWidth().padding(top = 2.dp)) {
        list.shown.forEach { document ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 32.dp)
                    .clickable(role = Role.Button, onClickLabel = "Open document") { onOpen(document) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SourceIcon(iconFor(document.sourceId), size = 14.dp)
                Spacer(Modifier.width(6.dp))
                Text(
                    document.title.ifBlank { "Untitled document" },
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (list.hidden > 0) {
            Text(
                "+${list.hidden} more",
                style = MaterialTheme.typography.bodySmall,
                color = c.textMuted,
                modifier = Modifier
                    .heightIn(min = 32.dp)
                    .clickable(role = Role.Button, onClickLabel = "Show all documents") { showAll = true }
                    .padding(vertical = 8.dp),
            )
        }
    }
}
