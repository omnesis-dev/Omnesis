// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.notes

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Notes
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
                title = { Text(if (selected == null) "Notes" else "Note", fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    IconButton(onClick = { if (selected == null) onBack() else onSelect(null) }) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = c.accent)
                    }
                },
                actions = {
                    if (selected == null) IconButton(onClick = onRefresh, enabled = !state.loading && !state.busy) {
                        Icon(Icons.Outlined.Refresh, "Refresh notes", Modifier.size(20.dp), tint = c.accent)
                    }
                    TextButton(onClick = onCapture) {
                        if (captureLabel == "Tell") {
                            Icon(Icons.Outlined.Mic, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(4.dp))
                        }
                        Text(captureLabel, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary, scrolledContainerColor = c.bgPrimary,
                    titleContentColor = c.textPrimary, navigationIconContentColor = c.accent, actionIconContentColor = c.accent,
                ),
            )
        },
    ) { padding ->
        when {
            selected != null -> NoteDetail(state, selected, onEdit, onDelete, onUndo, onOpenTask, Modifier.padding(padding))
            state.loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { OmSpinner() }
            state.entries.isEmpty() && state.error != null -> Box(Modifier.padding(padding)) {
                GatewayErrorView("load notes", state.error, onRefresh, onOpenSettings)
            }
            state.entries.isEmpty() -> Column(
                Modifier.padding(padding).fillMaxSize().padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Box(Modifier.size(64.dp).clip(RoundedCornerShape(18.dp)).background(c.accent.copy(alpha = 0.1f)),
                    contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Notes, null, Modifier.size(30.dp), tint = c.accent)
                }
                Spacer(Modifier.height(20.dp))
                Text("No notes yet", fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                Spacer(Modifier.height(8.dp))
                Text("What you tell Omnesis, and what it does next, will appear here.", fontSize = 14.sp,
                    lineHeight = 21.sp, color = c.textSecondary, textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                Button(onClick = onCapture, shape = RoundedCornerShape(10.dp)) {
                    Text(if (captureLabel == "Tell") "Tell Omnesis" else captureLabel)
                }
            }
            else -> LazyColumn(
                Modifier.padding(padding).fillMaxSize(), state = listState,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                state.error?.let { error -> item { TextButton(onClick = onRefresh) {
                    Text(classifyGatewayError(error) + " Retry", color = c.warning)
                } } }
                items(state.entries, key = { it.id }) { note ->
                    NoteHistoryRow(note, onClick = { onSelect(note.id) })
                }
                if (state.cursor != null) item {
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        if (state.paging) OmSpinner(Modifier.padding(16.dp))
                        else TextButton(onClick = onLoadMore) { Text("Load older notes", fontSize = 13.sp) }
                    }
                }
            }
        }
    }
}

/** The document accent and content hierarchy mirror the source's Recent documents. */
@Composable
private fun NoteHistoryRow(note: NoteEntryDto, onClick: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape).background(c.bgSecondary)
            .border(1.dp, c.borderLight, shape).clickable(onClick = onClick),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent.copy(alpha = 0.65f)))
        Column(Modifier.weight(1f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                Text(note.text.ifBlank { "Voice note" }, fontSize = 16.sp, lineHeight = 23.sp,
                    fontWeight = FontWeight.Medium, maxLines = 3, overflow = TextOverflow.Ellipsis,
                    color = c.textPrimary, modifier = Modifier.weight(1f))
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(17.dp).padding(top = 3.dp), tint = c.textMuted)
            }
            Text(listOfNotNull(noteTime(note.capturedAt), noteSurface(note.surface)).joinToString(" · "),
                fontSize = 11.sp, lineHeight = 16.sp, color = c.textSecondary)
            noteStatus(note)?.let { status ->
                val completed = note.agent?.state == "done" && note.transcription != "pending"
                val failed = note.agent?.state == "failed" && note.transcription != "pending"
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                    Icon(when {
                        note.transcription == "pending" -> Icons.Outlined.Mic
                        failed -> Icons.Outlined.WarningAmber
                        else -> Icons.Outlined.AutoAwesome
                    }, null, Modifier.size(15.dp).padding(top = 1.dp), tint = if (failed) c.warning else c.accent)
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        if (completed) Text("Omnesis", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = c.accent)
                        Text(status, fontSize = 13.sp, lineHeight = 19.sp, color = c.textSecondary,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
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
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (editing) "Edit your note" else "Your note", fontSize = 22.sp,
                fontWeight = FontWeight.Bold, color = c.textPrimary)
            Text(noteTime(note.capturedAt), fontSize = 12.sp, color = c.textSecondary)
            val metadata = listOfNotNull(noteSurface(note.surface), note.placeName).joinToString(" · ")
            if (metadata.isNotEmpty()) Text(metadata, fontSize = 12.sp, color = c.textSecondary)
            if (note.updatedAt != note.capturedAt && note.updatedAt != note.transcribedAt) {
                Text("Edited ${noteTime(note.updatedAt)}", fontSize = 11.sp, color = c.textSecondary)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (editing) {
                OutlinedTextField(value = draft, onValueChange = { draft = it }, label = { Text("Your note") },
                    modifier = Modifier.fillMaxWidth(), minLines = 5, enabled = !state.busy,
                    shape = RoundedCornerShape(12.dp), textStyle = MaterialTheme.typography.bodyLarge.copy(lineHeight = 25.sp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = c.bgSecondary, unfocusedContainerColor = c.bgSecondary,
                        disabledContainerColor = c.bgSecondary, focusedBorderColor = c.accent,
                        unfocusedBorderColor = c.border, disabledTextColor = c.textPrimary,
                    ), supportingText = { Text("${draft.length} / 8192") }, isError = draft.length > 8192)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { editing = false }, enabled = !state.busy) { Text("Cancel") }
                    Button(onClick = { savingEdit = true; onEdit(draft) },
                        enabled = !state.busy && draft.isNotBlank() && draft.length <= 8192,
                        shape = RoundedCornerShape(10.dp)) {
                        Text(if (state.busy) "Saving…" else "Save changes")
                    }
                }
            } else {
                SelectionContainer {
                    Text(note.text.ifBlank { "Voice note" }, fontSize = 17.sp, lineHeight = 26.sp, color = c.textPrimary)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { draft = note.text; editing = true }, enabled = !state.busy,
                        shape = RoundedCornerShape(9.dp), border = androidx.compose.foundation.BorderStroke(1.dp, c.border)) {
                        Icon(Icons.Outlined.Edit, null, Modifier.size(15.dp)); Spacer(Modifier.width(6.dp)); Text("Edit", fontSize = 13.sp)
                    }
                    TextButton(onClick = { confirming = true }, enabled = !state.busy) {
                        Icon(Icons.Outlined.Delete, null, Modifier.size(15.dp), tint = c.danger)
                        Spacer(Modifier.width(6.dp)); Text("Delete", fontSize = 13.sp, color = c.danger)
                    }
                }
            }
            state.actionError?.let { Text(it, fontSize = 13.sp, lineHeight = 20.sp, color = c.warning) }
            if (note.transcription == "pending") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Mic, null, Modifier.size(16.dp), tint = c.accent)
                    Text("Transcribing voice note…", fontSize = 13.sp, color = c.textSecondary)
                }
            }
        }
        NoteAgentPanel(state, note, onUndo, onOpenTask)
        Spacer(Modifier.height(16.dp))
    }
    if (confirming) AlertDialog(
        onDismissRequest = { if (!state.busy) confirming = false },
        containerColor = c.bgSecondary, titleContentColor = c.textPrimary, textContentColor = c.textSecondary,
        title = { Text("Delete this note?") },
        text = { Text("This removes the note and its receipt. Tasks and memories Omnesis already created will remain.") },
        confirmButton = { TextButton(onClick = { confirming = false; onDelete() }, enabled = !state.busy) { Text("Delete", color = c.danger) } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
    )
}

@Composable
private fun NoteAgentPanel(state: NotesHistoryState, note: NoteEntryDto, onUndo: (Long) -> Unit, onOpenTask: (String) -> Unit) {
    val c = OmTheme.colors
    val agent = note.agent ?: return
    if (agent.state == "skipped") return
    if (agent.state == "done" && agent.receipt?.text.isNullOrBlank() && agent.receipt?.changes.isNullOrEmpty()) return
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.bgSecondary).border(1.dp, c.borderLight, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(28.dp).clip(RoundedCornerShape(8.dp)).background(c.accent.copy(alpha = 0.1f)),
                contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.AutoAwesome, null, Modifier.size(15.dp), tint = c.accent)
            }
            Text("Omnesis", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
        }
        when (agent.state) {
            "pending", "running" -> Text("Omnesis is reading this…", fontSize = 14.sp, lineHeight = 22.sp, color = c.textSecondary)
            "failed" -> Text("Omnesis couldn't act on this note.", fontSize = 14.sp, lineHeight = 22.sp, color = c.textSecondary)
            "done" -> agent.receipt?.let { receipt ->
                if (receipt.text.isNotBlank()) SelectionContainer {
                    Text(receipt.text, fontSize = 15.sp, lineHeight = 24.sp, color = c.textPrimary)
                }
                receipt.changes.forEach { change ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).background(c.bgPrimary).padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        val taskId = change.taskId
                        val textModifier = Modifier.weight(1f).heightIn(min = 48.dp)
                        Text(change.text, fontSize = 13.sp, lineHeight = 20.sp, color = if (taskId != null) c.accent else c.textPrimary,
                            modifier = (if (taskId != null) textModifier.clickable { onOpenTask(taskId) } else textModifier)
                                .wrapContentHeight(Alignment.CenterVertically))
                        change.undoSeq?.let { seq ->
                            if (seq in state.undone) Text("Undone", fontSize = 11.sp, color = c.textSecondary, modifier = Modifier.padding(end = 8.dp))
                            else TextButton(onClick = { onUndo(seq) }, enabled = !state.busy) { Text("Undo", fontSize = 12.sp) }
                        }
                    }
                }
            }
        }
    }
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
