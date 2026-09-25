// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Textsms
import androidx.compose.material.icons.outlined.ThumbDown
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefKindDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** A brief's full reading surface, with the same action placement as iOS. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BriefDetailSheet(
    brief: BriefRecordDto,
    openingThread: Boolean,
    dictating: Boolean = false,
    dictationText: String = "",
    onAsk: () -> Unit,
    onDictate: () -> Unit = {},
    onDismiss: (BriefDismissReasonDto, String?) -> Unit,
    onMoreOptions: (BriefDismissReasonDto?) -> Unit,
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    onOpenDocument: (String) -> Unit = {},
    onDismissRequest: () -> Unit,
) {
    val colors = OmTheme.colors
    var optionsOpen by remember { mutableStateOf(false) }
    var snoozeMenu by remember { mutableStateOf(false) }
    val zone = remember { ZoneId.systemDefault() }

    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.bgPrimary,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = OmSpacing.xl).padding(bottom = OmSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        ) {
            brief.eventAt?.let { DetailTimeLabel(it) }
            Text(
                brief.title,
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                color = colors.textPrimary,
            )
            if (brief.description.isNotBlank()) {
                MarkdownText(
                    markdown = brief.description,
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.textPrimary,
                )
            }
            DetailTimeLabel(brief.createdAt, muted = true)
            Row(
                Modifier.fillMaxWidth().padding(top = OmSpacing.sm),
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.lg, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BriefGlassAction(
                    label = if (dictating) "Stop and send" else "Dictate a question",
                    onClick = onDictate,
                ) { Icon(Icons.Outlined.Mic, null, tint = colors.textPrimary) }
                BriefGlassAction(
                    label = "Ask the agent about this brief",
                    enabled = !openingThread && !dictating,
                    onClick = onAsk,
                ) {
                    if (openingThread) OmSpinner(Modifier.size(18.dp))
                    else Icon(Icons.Outlined.Textsms, null, tint = colors.textPrimary)
                }
                Box {
                    BriefGlassAction(label = "Brief options", onClick = { optionsOpen = true }) {
                        Icon(Icons.Outlined.MoreHoriz, null, tint = colors.textPrimary)
                    }
                    DropdownMenu(
                        expanded = optionsOpen,
                        onDismissRequest = { optionsOpen = false },
                        modifier = Modifier.testTag("briefDetailOptions"),
                    ) {
                        DropdownMenuItem(
                            text = { Text(brief.kind.clearActionLabel) },
                            leadingIcon = { Icon(Icons.Outlined.Check, null) },
                            onClick = { optionsOpen = false; onDismiss(brief.kind.clearActionReason, null) },
                        )
                        DropdownMenuItem(
                            text = { Text("Snooze") },
                            leadingIcon = { Icon(Icons.Outlined.Schedule, null) },
                            onClick = { optionsOpen = false; snoozeMenu = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Not relevant") },
                            leadingIcon = { Icon(Icons.Outlined.ThumbDown, null) },
                            onClick = { optionsOpen = false; onDismiss(BriefDismissReasonDto.NOT_RELEVANT, null) },
                        )
                        DropdownMenuItem(
                            text = { Text("Wrong") },
                            leadingIcon = { Icon(Icons.Outlined.ErrorOutline, null) },
                            onClick = { optionsOpen = false; onDismiss(BriefDismissReasonDto.WRONG, null) },
                        )
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text("Add a note…") },
                            leadingIcon = { Icon(Icons.Outlined.Edit, null) },
                            onClick = { optionsOpen = false; onMoreOptions(null) },
                        )
                    }
                    DropdownMenu(expanded = snoozeMenu, onDismissRequest = { snoozeMenu = false }) {
                        SnoozeMenuItem("Later today") {
                            val now = Instant.now()
                            onDismiss(
                                BriefDismissReasonDto.SNOOZED,
                                resolveBriefSnooze(BriefSnoozeChoice.LATER_TODAY, now, zone)?.toString(),
                            )
                        }
                        SnoozeMenuItem("Tomorrow") {
                            val now = Instant.now()
                            onDismiss(
                                BriefDismissReasonDto.SNOOZED,
                                resolveBriefSnooze(BriefSnoozeChoice.TOMORROW, now, zone)?.toString(),
                            )
                        }
                        SnoozeMenuItem("Pick a time…") { onMoreOptions(BriefDismissReasonDto.SNOOZED) }
                        SnoozeMenuItem("Let the agent decide") { onDismiss(BriefDismissReasonDto.SNOOZED, null) }
                    }
                }
            }
            if (dictating) {
                Text(
                    dictationText.ifBlank { "Listening…" },
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (!brief.body.isNullOrBlank() || brief.citations.isNotEmpty()) {
                HorizontalDivider(Modifier.padding(vertical = OmSpacing.sm), color = colors.borderLight)
                brief.body?.takeIf { it.isNotBlank() }?.let {
                    MarkdownText(it, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
                }
                if (brief.citations.isNotEmpty()) {
                    Text(
                        "Sources",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.textMuted,
                    )
                    brief.citations.forEach { citation ->
                        Row(
                            Modifier.fillMaxWidth().clickable { onOpenDocument(citation.docId) }
                                .padding(vertical = OmSpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            SourceIcon(iconFor(citation.sourceId), size = 22.dp)
                            Text(
                                citation.title,
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.textPrimary,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Icon(Icons.Outlined.ChevronRight, null, tint = colors.textMuted, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SnoozeMenuItem(label: String, action: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, onClick = action)
}

@Composable
private fun BriefGlassAction(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        Modifier.size(44.dp).background(OmTheme.colors.bgSecondary, CircleShape)
            .border(1.dp, OmTheme.colors.border, CircleShape)
            .alpha(if (enabled) 1f else 0.45f)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
private fun DetailTimeLabel(iso: String, muted: Boolean = false) {
    val instant = remember(iso) { runCatching { Instant.parse(iso) }.getOrNull() } ?: return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!muted) Icon(Icons.Outlined.AccessTime, null, tint = OmTheme.colors.accent, modifier = Modifier.size(15.dp))
        Text(
            DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.systemDefault()).format(instant),
            style = MaterialTheme.typography.labelSmall,
            color = if (muted) OmTheme.colors.textMuted else OmTheme.colors.accent,
        )
    }
}

/** Dismiss reason, conditional snooze controls, optional correction, then one confirmation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BriefDismissSheet(
    brief: BriefRecordDto,
    initialReason: BriefDismissReasonDto? = null,
    onConfirm: (BriefDismissReasonDto, String?, String?) -> Unit,
    onDismissRequest: () -> Unit,
) {
    val context = LocalContext.current
    val zone = remember { ZoneId.systemDefault() }
    var reason by remember(initialReason) { mutableStateOf(initialReason) }
    var snoozeChoice by remember { mutableStateOf(BriefSnoozeChoice.AGENT_DECIDES) }
    var pickedTime by remember { mutableStateOf(Instant.now().plusSeconds(3600)) }
    var feedback by remember { mutableStateOf("") }
    var snoozeError by remember { mutableStateOf<String?>(null) }

    fun pickDateAndTime() {
        val current = ZonedDateTime.ofInstant(pickedTime, zone)
        DatePickerDialog(
            context,
            { _, year, month, day ->
                TimePickerDialog(
                    context,
                    { _, hour, minute ->
                        pickedTime = ZonedDateTime.of(year, month + 1, day, hour, minute, 0, 0, zone).toInstant()
                        snoozeChoice = BriefSnoozeChoice.PICK_A_TIME
                        snoozeError = null
                    },
                    current.hour,
                    current.minute,
                    true,
                ).show()
            },
            current.year,
            current.monthValue - 1,
            current.dayOfMonth,
        ).apply { datePicker.minDate = System.currentTimeMillis() }.show()
    }

    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = OmSpacing.lg).padding(bottom = OmSpacing.xl),
        ) {
            Text(
                "Dismiss brief",
                style = MaterialTheme.typography.titleMedium,
                color = OmTheme.colors.textPrimary,
                modifier = Modifier.padding(bottom = OmSpacing.lg),
            )
            Text("Why dismiss this brief?", style = MaterialTheme.typography.labelMedium, color = OmTheme.colors.textMuted)
            reasonsFor(brief.kind).forEach { (value, label) ->
                ChoiceRow(label, reason == value) { reason = value }
            }
            if (reason == BriefDismissReasonDto.SNOOZED) {
                Spacer(Modifier.height(OmSpacing.md))
                Text("Remind me", style = MaterialTheme.typography.labelMedium, color = OmTheme.colors.textMuted)
                ChoiceRow("Later today", snoozeChoice == BriefSnoozeChoice.LATER_TODAY) {
                    snoozeChoice = BriefSnoozeChoice.LATER_TODAY
                    snoozeError = null
                }
                ChoiceRow("Tomorrow", snoozeChoice == BriefSnoozeChoice.TOMORROW) {
                    snoozeChoice = BriefSnoozeChoice.TOMORROW
                    snoozeError = null
                }
                ChoiceRow("Pick a time", snoozeChoice == BriefSnoozeChoice.PICK_A_TIME) { pickDateAndTime() }
                if (snoozeChoice == BriefSnoozeChoice.PICK_A_TIME) {
                    TextButton(onClick = ::pickDateAndTime) {
                        Text(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm").withZone(zone).format(pickedTime))
                    }
                }
                ChoiceRow("Let the agent decide", snoozeChoice == BriefSnoozeChoice.AGENT_DECIDES) {
                    snoozeChoice = BriefSnoozeChoice.AGENT_DECIDES
                    snoozeError = null
                }
                snoozeError?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = OmTheme.colors.danger)
                }
            }
            Spacer(Modifier.height(OmSpacing.md))
            OutlinedTextField(
                value = feedback,
                onValueChange = { feedback = it },
                label = { Text("Anything to correct or add? (optional)") },
                placeholder = { Text("e.g. the deadline is actually the 20th") },
                minLines = 2,
                maxLines = 4,
                modifier = Modifier.fillMaxWidth().testTag("briefDismissFeedback"),
            )
            Row(
                Modifier.fillMaxWidth().padding(top = OmSpacing.lg),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(onClick = onDismissRequest) { Text("Cancel") }
                Spacer(Modifier.size(OmSpacing.sm))
                Button(
                    enabled = reason != null,
                    onClick = {
                        val selected = reason ?: return@Button
                        val confirmationNow = Instant.now()
                        if (selected == BriefDismissReasonDto.SNOOZED &&
                            !isBriefSnoozeValid(snoozeChoice, confirmationNow, pickedTime)
                        ) {
                            snoozeError = "Choose a reminder time in the future."
                            return@Button
                        }
                        val snoozeUntil = if (selected == BriefDismissReasonDto.SNOOZED) {
                            resolveBriefSnooze(snoozeChoice, confirmationNow, zone, pickedTime)?.toString()
                        } else null
                        onConfirm(selected, feedback.trim().ifEmpty { null }, snoozeUntil)
                    },
                    modifier = Modifier.testTag("briefDismissConfirm"),
                ) { Text("Dismiss") }
            }
        }
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = OmTheme.colors.textPrimary, modifier = Modifier.weight(1f))
        RadioButton(selected = selected, onClick = onClick)
    }
}

private fun reasonsFor(kind: BriefKindDto): List<Pair<BriefDismissReasonDto, String>> = listOf(
    BriefDismissReasonDto.NOT_RELEVANT to "Not relevant",
    BriefDismissReasonDto.WRONG to "Wrong",
    kind.clearActionReason to if (kind == BriefKindDto.LOOP) "Already handled" else "Acknowledged",
    BriefDismissReasonDto.SNOOZED to "Snooze",
)
