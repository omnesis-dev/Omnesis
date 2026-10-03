// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.client.ConversationSubmission

/** Message actions remain available to touch exploration without occupying transcript space. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ConversationMessageActions(
    text: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    alignMenuEnd: Boolean = false,
    content: @Composable () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Box(Modifier.combinedClickable(onClick = {}, onLongClickLabel = "Message actions", onLongClick = { expanded = true })) {
        content()
        Box(Modifier.align(if (alignMenuEnd) Alignment.BottomEnd else Alignment.BottomStart)) {
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text("Copy") }, onClick = {
                    clipboard.setText(AnnotatedString(text))
                    expanded = false
                })
                if (actionLabel != null && onAction != null) {
                    DropdownMenuItem(text = { Text(actionLabel) }, onClick = {
                        expanded = false
                        onAction()
                    })
                }
            }
        }
    }
}

internal fun queuedConversationText(messages: List<ConversationSubmission>): String =
    messages.filter { it.status == "queued" }.joinToString("\n\n") { it.text }

@Composable
internal fun QueuedConversationBubble(state: AgentCoordinator.UiState, onSendNow: (List<String>) -> Unit) {
    val queued = state.controls.queuedMessages.filter { it.status == "queued" }
    if (queued.isEmpty()) return
    val groups = if (state.controls.capabilities.coalescedQueue) listOf(queued) else queued.map { listOf(it) }
    Column(Modifier.fillMaxWidth()) {
        groups.forEach { group ->
            val text = queuedConversationText(group)
            ConversationMessageActions(
                text = text,
                actionLabel = "Send now",
                alignMenuEnd = true,
                onAction = if (state.controlsAvailable && state.controls.capabilities.queueSendNow && state.canCompose) {
                    { onSendNow(group.map { it.id }) }
                } else null,
            ) {
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                    UserBubble(text)
                    Text("Queued", style = MaterialTheme.typography.labelSmall, color = OmTheme.colors.textSecondary)
                }
            }
        }
    }
}
