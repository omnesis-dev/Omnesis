// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.material.icons.outlined.Person
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.EmptyView
import dev.omnesis.android.designsystem.components.ErrorView
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.PersonAvatar
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.transport.dto.RecordingSpeakerDto
import dev.omnesis.android.transport.dto.SpeakerMapping
import dev.omnesis.android.transport.dto.displayName

/** Who spoke in a recording, and saying who each speaker is (experimental). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingSpeakersScreen(
    onBack: () -> Unit,
    vm: RecordingSpeakersViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var naming by rememberSaveable { mutableStateOf<Int?>(null) }
    LaunchedEffect(state.message) {
        state.message?.let {
            snackbar.showSnackbar(it)
            vm.dismissMessage()
        }
    }
    Scaffold(
        containerColor = OmTheme.colors.bgPrimary,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Who spoke", style = MaterialTheme.typography.titleMedium)
                        if (state.title.isNotBlank()) {
                            Text(
                                state.title,
                                style = MaterialTheme.typography.bodySmall,
                                color = OmTheme.colors.textMuted,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        RecordingSpeakersContent(
            state = state,
            onRetry = vm::load,
            onSetSelf = vm::setSelf,
            onChoosePerson = vm::openPicker,
            onName = { naming = it },
            onClear = vm::clear,
            modifier = Modifier.padding(padding),
        )
    }
    state.picker?.let { picker ->
        ModalBottomSheet(
            onDismissRequest = vm::closePicker,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = OmTheme.colors.bgSecondary,
        ) {
            PersonPickerContent(
                picker = picker,
                onQueryChange = vm::onPickerQuery,
                onPick = { vm.choosePerson(picker.speaker, it) },
            )
        }
    }
    naming?.let { speaker ->
        val current = state.speakers.firstOrNull { it.speaker == speaker }
        NameSpeakerDialog(
            speaker = speaker,
            initial = current?.takeIf { it.personId == null && !it.isSelf }?.name.orEmpty(),
            onDismiss = { naming = null },
            onSave = {
                vm.name(speaker, it)
                naming = null
            },
        )
    }
}

/**
 * The screen's body, taking its state as arguments so a screenshot test renders
 * every state without a gateway. Paints its own background.
 */
@Composable
fun RecordingSpeakersContent(
    state: RecordingSpeakersUiState,
    onRetry: () -> Unit,
    onSetSelf: (Int) -> Unit,
    onChoosePerson: (Int) -> Unit,
    onName: (Int) -> Unit,
    onClear: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    val base = modifier.fillMaxSize().background(c.bgPrimary)
    when (val load = state.load) {
        RecordingSpeakersUiState.Load.Loading -> LoadingView(base)
        is RecordingSpeakersUiState.Load.Failed -> ErrorView(load.message, base, onRetry = onRetry)
        RecordingSpeakersUiState.Load.Loaded -> if (state.speakers.isEmpty()) {
            EmptyView(
                "Speakers were not told apart for this recording. The gateway's speaker setting is off, " +
                    "or its transcriber gives no timings to tell voices apart.",
                base,
            )
        } else {
            LazyColumn(
                modifier = base,
                verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
                contentPadding = PaddingValues(OmSpacing.lg),
            ) {
                item {
                    Text(
                        "Say who each voice is. People you choose become participants of the conversation.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textSecondary,
                    )
                }
                items(state.speakers, key = { it.speaker }) { speaker ->
                    SpeakerCard(
                        speaker = speaker,
                        saving = speaker.speaker in state.saving,
                        onSetSelf = onSetSelf,
                        onChoosePerson = onChoosePerson,
                        onName = onName,
                        onClear = onClear,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SpeakerCard(
    speaker: RecordingSpeakerDto,
    saving: Boolean,
    onSetSelf: (Int) -> Unit,
    onChoosePerson: (Int) -> Unit,
    onName: (Int) -> Unit,
    onClear: (Int) -> Unit,
) {
    val c = OmTheme.colors
    val label = speakerLabel(speaker)
    OmnesisCard(modifier = Modifier.fillMaxWidth(), padding = OmSpacing.lg) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (speaker.isSelf) {
                Box(
                    Modifier.size(36.dp).background(c.accent, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Person, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
                }
            } else if (speaker.mapped) {
                PersonAvatar(name = label, size = 36.dp)
            } else {
                Box(
                    Modifier.size(36.dp).background(c.bgTertiary, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        speaker.speaker.toString(),
                        style = MaterialTheme.typography.labelLarge,
                        color = c.textSecondary,
                    )
                }
            }
            Spacer(Modifier.width(OmSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    label,
                    style = MaterialTheme.typography.titleSmall,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${formatTalkTime(speaker.talkMs)} · ${mappingLine(speaker)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (saving) OmSpinner(Modifier.size(18.dp), strokeWidth = 2.dp)
        }
        if (speaker.samples.isNotEmpty()) {
            Spacer(Modifier.height(OmSpacing.md))
            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                speaker.samples.forEach { line ->
                    Text(
                        "“$line”",
                        style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                        color = c.textSecondary,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.height(OmSpacing.sm))
        // Text buttons keep the card compact; the negative offset lines their
        // labels up with the text above while keeping the full touch target.
        FlowRow(modifier = Modifier.offset(x = -OmSpacing.sm)) {
            val padding = PaddingValues(horizontal = OmSpacing.sm, vertical = 0.dp)
            if (!speaker.isSelf) {
                TextButton(onClick = { onSetSelf(speaker.speaker) }, enabled = !saving, contentPadding = padding) {
                    Text("This is me")
                }
            }
            TextButton(onClick = { onChoosePerson(speaker.speaker) }, enabled = !saving, contentPadding = padding) {
                Text("Choose person…")
            }
            TextButton(onClick = { onName(speaker.speaker) }, enabled = !saving, contentPadding = padding) {
                Text("Name…")
            }
            if (speaker.mapped) {
                TextButton(onClick = { onClear(speaker.speaker) }, enabled = !saving, contentPadding = padding) {
                    Text("Clear", color = if (saving) c.textMuted else c.danger)
                }
            }
        }
    }
}

private fun mappingLine(speaker: RecordingSpeakerDto): String = when {
    speaker.isSelf -> "your voice"
    speaker.personId != null -> "one of your people"
    speaker.name != null -> "a name you gave"
    else -> "not named yet"
}

/** The person picker's body: a search field and the matching people. */
@Composable
fun PersonPickerContent(
    picker: PersonPickerState,
    onQueryChange: (String) -> Unit,
    onPick: (PersonSummary) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Column(modifier.fillMaxWidth().padding(bottom = OmSpacing.lg)) {
        Text(
            "Who is speaker ${picker.speaker}?",
            style = MaterialTheme.typography.titleMedium,
            color = c.textPrimary,
            modifier = Modifier.padding(horizontal = OmSpacing.lg),
        )
        Spacer(Modifier.height(OmSpacing.md))
        OutlinedTextField(
            value = picker.query,
            onValueChange = onQueryChange,
            placeholder = { Text("Search people") },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = OmSpacing.lg),
        )
        Spacer(Modifier.height(OmSpacing.sm))
        Box(Modifier.fillMaxWidth().heightIn(min = 120.dp)) {
            when {
                picker.results.isEmpty() && picker.searching ->
                    OmSpinner(Modifier.align(Alignment.Center).size(24.dp), strokeWidth = 2.dp)
                picker.results.isEmpty() -> Text(
                    if (picker.failed) "People could not be searched. Try again." else "No one matches.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (picker.failed) c.danger else c.textMuted,
                    modifier = Modifier.align(Alignment.Center).padding(OmSpacing.lg),
                )
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                    items(picker.results, key = { it.id }) { person ->
                        PersonRow(person, onPick)
                        HorizontalDivider(color = c.border, modifier = Modifier.padding(start = 68.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun PersonRow(person: PersonSummary, onPick: (PersonSummary) -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onPick(person) }
            .padding(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PersonAvatar(name = person.displayName, size = 36.dp)
        Spacer(Modifier.width(OmSpacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                person.displayName,
                style = MaterialTheme.typography.bodyLarge,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (person.documentCount > 0) {
                Text(
                    "${person.documentCount} ${if (person.documentCount == 1) "item" else "items"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textMuted,
                )
            }
        }
    }
}

@Composable
private fun NameSpeakerDialog(
    speaker: Int,
    initial: String,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var text by rememberSaveable(speaker) { mutableStateOf(initial) }
    val valid = text.trim().length in 1..SpeakerMapping.MAX_NAME_LENGTH
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Name speaker $speaker") },
        text = {
            Column {
                Text(
                    "For someone who is not among your people in Omnesis.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(OmSpacing.md))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.take(SpeakerMapping.MAX_NAME_LENGTH) },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text) }, enabled = valid) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
