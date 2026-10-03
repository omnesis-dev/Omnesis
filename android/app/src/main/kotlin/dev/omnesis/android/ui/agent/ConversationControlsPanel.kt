// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme

/** Gateway-owned questions and queue remain visible after switching devices or restarting. */
@Composable
internal fun ConversationControlsPanel(
    state: AgentCoordinator.UiState,
    onAnswer: (String) -> Unit,
    onRetry: (String) -> Unit,
    onEditPending: (String) -> Unit = {},
) {
    val question = state.controls.pendingClarification
    val pending = state.composer.pending
    val queue = state.controls.queuedMessages.filter { queued -> queued.status != "queued" && pending.none { it.clientMessageId == queued.id } }
    if (question == null && pending.isEmpty() && queue.isEmpty()) return
    Column(
        Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        question?.let { clarification ->
            Text(clarification.question, style = MaterialTheme.typography.titleSmall, color = OmTheme.colors.textPrimary)
            clarification.choices.forEach { choice ->
                TextButton(onClick = { onAnswer(choice.label) }, enabled = state.canCompose && state.submissionsSending.isEmpty(), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth()) {
                        Text(choice.label)
                        choice.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
        pending.forEach { message ->
            val sending = message.clientMessageId in state.submissionsSending
            PendingMessageRow(message.text, if (sending) "Sending…" else "Delivery unconfirmed · check before resending",
                if (sending) null else ({ onRetry(message.clientMessageId) }),
                if (sending) null else ({ onEditPending(message.clientMessageId) }))
        }
        queue.forEach { message ->
            PendingMessageRow(message.text, if (message.status == "failed") message.error ?: "Delivery failed" else if (message.status == "queued") "Queued" else "Pending", if (message.status == "failed") ({ onRetry(message.id) }) else null)
        }
    }
}

@Composable
private fun PendingMessageRow(text: String, status: String, retry: (() -> Unit)?, edit: (() -> Unit)? = null) {
    ConversationMessageActions(text = text, actionLabel = "Edit and resend", onAction = edit) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(status, style = MaterialTheme.typography.labelSmall, color = OmTheme.colors.textSecondary)
                Text(text, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.textPrimary)
            }
            if (retry != null) TextButton(onClick = retry) { Text("Retry") }
        }
    }
}
