// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.notes

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.classifyGatewayError
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay

@Composable
fun NotesHistoryScreen(
    onBack: () -> Unit,
    onCapture: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenTask: (String) -> Unit = {},
    vm: NotesHistoryViewModel = hiltViewModel(),
    captureLabel: String = "Tell",
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(vm, lifecycle) {
        lifecycle.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            vm.onVisible()
            while (true) {
                delay(5000)
                if (vm.state.value.entries.any { noteNeedsRefresh(it) }) {
                    vm.refresh(quietly = true)
                }
            }
        }
    }
    BackHandler(state.selected != null) { vm.select(null) }
    NotesHistoryContent(state, onBack, onCapture, onOpenSettings, vm::select, { vm.refresh() }, vm::loadMore,
        vm::edit, vm::delete, vm::undo, onOpenTask, captureLabel)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesHistoryContent(
    state: NotesHistoryState,
    onBack: () -> Unit,
    onCapture: () -> Unit,
    onOpenSettings: () -> Unit,
    onSelect: (String?) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onEdit: (String) -> Unit,
    onDelete: () -> Unit,
    onUndo: (Long) -> Unit,
    onOpenTask: (String) -> Unit = {},
    captureLabel: String = "Tell",
) {
    val c = OmTheme.colors
    val selected = state.selected
    val listState = rememberLazyListState()
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(if (selected == null) "Notes" else "Your note") },
                navigationIcon = { IconButton(onClick = { if (selected == null) onBack() else onSelect(null) }) {
                    Icon(Icons.Outlined.ArrowBack, "Back")
                } },
                actions = {
                    if (selected == null) IconButton(onClick = onRefresh, enabled = !state.loading && !state.busy) {
                        Icon(Icons.Outlined.Refresh, "Refresh notes")
                    }
                    TextButton(onClick = onCapture) { Icon(Icons.Outlined.Mic, null); Text(captureLabel) }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary, titleContentColor = c.textPrimary),
            )
        },
    ) { padding ->
        when {
            selected != null -> NoteDetail(state, selected, onEdit, onDelete, onUndo, onOpenTask, Modifier.padding(padding))
            state.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { OmSpinner() }
            state.entries.isEmpty() && state.error != null -> Box(Modifier.padding(padding)) {
                GatewayErrorView("load notes", state.error, onRefresh, onOpenSettings)
            }
            state.entries.isEmpty() -> Column(Modifier.padding(padding).fillMaxSize().padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("Your thoughts, remembered", style = MaterialTheme.typography.titleLarge, color = c.textPrimary)
                Spacer(Modifier.height(12.dp))
                Text("Notes you tell Omnesis appear here, along with what it did with them.", color = c.textSecondary)
                TextButton(onClick = onCapture) { Text(if (captureLabel == "Tell") "Tell Omnesis" else captureLabel) }
            }
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
                state.error?.let { error -> item { TextButton(onClick = onRefresh) {
                    Text(classifyGatewayError(error) + " Retry")
                } } }
                items(state.entries, key = { it.id }) { note ->
                    Column(Modifier.fillMaxWidth().clickable { onSelect(note.id) }.padding(horizontal = 20.dp, vertical = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(noteTime(note.capturedAt), style = MaterialTheme.typography.labelMedium, color = c.textMuted,
                                modifier = Modifier.weight(1f))
                            Icon(Icons.Outlined.ChevronRight, null, tint = c.textMuted)
                        }
                        Text(note.text.ifBlank { "Voice note" }, maxLines = 3, overflow = TextOverflow.Ellipsis,
                            color = c.textPrimary, style = MaterialTheme.typography.bodyLarge)
                        noteStatus(note)?.let { Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            color = c.accent, style = MaterialTheme.typography.bodySmall) }
                    }
                    HorizontalDivider(color = c.textMuted.copy(alpha = 0.15f), modifier = Modifier.padding(horizontal = 20.dp))
                }
                if (state.cursor != null) item {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        if (state.paging) OmSpinner(Modifier.padding(16.dp))
                        else TextButton(onClick = onLoadMore) { Text("Load older notes") }
                    }
                }
            }
        }
    }
}

@Composable
private fun NoteDetail(
    state: NotesHistoryState,
    note: NoteEntryDto,
    onEdit: (String) -> Unit,
    onDelete: () -> Unit,
    onUndo: (Long) -> Unit,
    onOpenTask: (String) -> Unit,
    modifier: Modifier,
) {
    val c = OmTheme.colors
    var editing by rememberSaveable(note.id) { mutableStateOf(false) }
    var draft by rememberSaveable(note.id) { mutableStateOf(note.text) }
    var confirming by remember(note.id) { mutableStateOf(false) }
    var savingEdit by remember(note.id) { mutableStateOf(false) }
    LaunchedEffect(state.busy, note.text, savingEdit) {
        if (savingEdit && !state.busy) {
            if (state.actionError == null) editing = false
            savingEdit = false
        }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(noteTime(note.capturedAt), color = c.textMuted, style = MaterialTheme.typography.labelLarge)
        val metadata = listOfNotNull(noteSurface(note.surface), note.placeName).joinToString(" · ")
        if (metadata.isNotEmpty()) Text(metadata, color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
        if (note.updatedAt != note.capturedAt && note.updatedAt != note.transcribedAt) Text("Edited ${noteTime(note.updatedAt)}", color = c.textMuted, style = MaterialTheme.typography.bodySmall)
        if (editing) {
            OutlinedTextField(value = draft, onValueChange = { draft = it }, label = { Text("Your note") },
                modifier = Modifier.fillMaxWidth(), minLines = 5, enabled = !state.busy,
                supportingText = { Text("${draft.length} / 8192") }, isError = draft.length > 8192)
            Row {
                TextButton(onClick = { editing = false }, enabled = !state.busy) { Text("Cancel") }
                Button(onClick = { savingEdit = true; onEdit(draft) }, enabled = !state.busy && draft.isNotBlank() && draft.length <= 8192) {
                    Text(if (state.busy) "Saving…" else "Save changes")
                }
            }
        } else {
            SelectionContainer { Text(note.text.ifBlank { "Voice note" }, style = MaterialTheme.typography.bodyLarge, color = c.textPrimary) }
            Row {
                TextButton(onClick = { draft = note.text; editing = true }, enabled = !state.busy) {
                    Icon(Icons.Outlined.Edit, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Edit")
                }
                TextButton(onClick = { confirming = true }, enabled = !state.busy) {
                    Icon(Icons.Outlined.Delete, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Delete")
                }
            }
        }
        state.actionError?.let { Text(it, color = c.warning) }
        if (note.transcription == "pending") Text("Transcribing voice note…", color = c.textSecondary)
        val agent = note.agent
        if (agent != null && agent.state != "skipped") {
            HorizontalDivider(color = c.textMuted.copy(alpha = 0.2f))
            Text("Omnesis", style = MaterialTheme.typography.titleMedium, color = c.accent)
            when (agent.state) {
                "pending", "running" -> Text("Omnesis is reading this…", color = c.textSecondary)
                "failed" -> Text("Omnesis couldn't act on this note.", color = c.textSecondary)
                "done" -> {
                    agent.receipt?.let { receipt ->
                        if (receipt.text.isNotBlank()) SelectionContainer { Text(receipt.text, color = c.textPrimary) }
                        receipt.changes.forEach { change ->
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                val taskId = change.taskId
                                if (taskId != null) TextButton(onClick = { onOpenTask(taskId) }) { Text(change.text) }
                                else Text(change.text, color = c.textPrimary)
                                change.undoSeq?.let { seq ->
                                    if (seq in state.undone) Text("Undone", color = c.textMuted)
                                    else TextButton(onClick = { onUndo(seq) }, enabled = !state.busy) { Text("Undo") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (confirming) AlertDialog(
        onDismissRequest = { if (!state.busy) confirming = false },
        title = { Text("Delete this note?") },
        text = { Text("This removes the note and its receipt. Tasks and memories Omnesis already created will remain.") },
        confirmButton = { TextButton(onClick = { confirming = false; onDelete() }, enabled = !state.busy) { Text("Delete") } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
    )
}

internal fun noteStatus(note: NoteEntryDto): String? = when {
    note.transcription == "pending" -> "Transcribing voice note…"
    note.agent?.state in listOf("pending", "running") -> "Omnesis is reading this…"
    note.agent?.state == "failed" -> "Omnesis couldn't act on this note."
    note.agent?.state == "done" -> note.agent?.receipt?.text?.takeIf { it.isNotBlank() }
    else -> null
}

internal fun noteTime(raw: String): String = runCatching {
    DateTimeFormatter.ofPattern("d MMM yyyy · HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(raw))
}.getOrDefault(raw)

internal fun noteSurface(surface: String?): String? = when (surface) {
    "portal" -> "Web portal"
    "ios-app" -> "iPhone"
    "ios-siri" -> "Siri"
    "ios-action-button" -> "iPhone Action Button"
    "ios-control" -> "iPhone Control Center"
    "ios-widget" -> "iPhone widget"
    "ios-quick-action" -> "iPhone quick action"
    "ios-watch", "watch" -> "Apple Watch"
    "android-app" -> "Android"
    "android-tile" -> "Android Quick Settings"
    "android-shortcut" -> "Android shortcut"
    "android-assistant" -> "Android assistant"
    "cli" -> "Command line"
    null -> null
    else -> "Other capture"
}
