// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.capture.joinUtterances
import dev.omnesis.android.ui.common.landingPalette
import dev.omnesis.android.ui.voice.DictationFailureCard
import dev.omnesis.android.ui.voice.RecordingMeter
import dev.omnesis.android.ui.voice.TranscribingStatus
import dev.omnesis.android.ui.voice.VoiceRecording

/**
 * The floating glass composer pill — a chrome-less rounded-24 pill that floats over the
 * full-bleed transcript with margins on the sides + bottom, NOT a Material `Surface` +
 * `OutlinedTextField` + `FilledIconButton`. The trailing button is a two-state machine:
 * busy → stop-circle (danger); otherwise → send arrow-up-circle (accent when there's text,
 * dimmed + disabled when empty). Mirrors iOS `AgentComposer` in `AgentView.swift`.
 *
 * Slash-command affordance (parity with portal + iOS): typing `/` at the start of the
 * (otherwise empty) composer opens a typeahead menu of [SlashCommand]s. Selecting one arms
 * it as a PER-MESSAGE pill (top-left, glyph + label + `×`); the next send carries that
 * command's send options (today only `deepResearch`), then the pill clears. The `×` dismisses
 * without sending. A default send (no pill) is an ordinary turn — explicit-only, no auto-gating.
 *
 * Dictation: a mic beside the trailing button fills the draft and never sends (see
 * [ComposerDictationViewModel]). Live on-device words show after the draft while they
 * are heard; a gateway dictation shows its recording and transcription above the field.
 */
@Composable
fun AgentComposer(
    busy: Boolean,
    enabled: Boolean,
    onSend: (String, SlashCommand?) -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    initialText: String = "",
    // Gateway experimental mode gates any experimental commands the extensible
    // slash-command list may add.
    experimental: Boolean = false,
    // A send the gateway never accepted (failed/superseded lazy mint, or a refused POST) hands
    // its text back here; the composer restores it (if the user hasn't started a new message)
    // then acks via [onRestoreConsumed], so a fast send-then-navigate can't silently drop it.
    pendingRestore: String? = null,
    onRestoreConsumed: () -> Unit = {},
    // DEBUG/snapshot seam: lets a Roborazzi capture render the armed-pill state.
    initialArmedCommand: SlashCommand? = null,
    /** Fresh-conversation entry points place the caret in the empty composer immediately. */
    requestFocus: Boolean = false,
    /** Changes when the coordinator explicitly replaces the local draft with a fresh composer. */
    composerGeneration: Long = 0,
    dictation: ComposerDictation = ComposerDictation.NONE,
) {
    var text by rememberSaveable(composerGeneration) { mutableStateOf(initialText) }
    // Per-message local state — NOT view-model/coordinator state: an ephemeral
    // compose-time affordance that clears on submit (or on `×`). Saved by id so
    // it survives a config change.
    var armedId by rememberSaveable(composerGeneration) { mutableStateOf(initialArmedCommand?.id) }
    val armedCommand = SlashCommand.byId(armedId)
    val colors = OmTheme.colors
    val focusRequester = remember(composerGeneration) { FocusRequester() }

    LaunchedEffect(requestFocus, enabled, composerGeneration) {
        if (requestFocus && enabled) focusRequester.requestFocus()
    }

    val menu = matchSlashCommands(text, experimental = experimental)

    val placeholder = when {
        !enabled -> "Connecting…"
        busy -> "Working…"
        armedCommand != null -> "Describe what to research…"
        else -> "Ask Omnesis"
    }

    val voice = dictation.state
    // A new conversation's fresh draft owes nothing to a dictation begun for the old one.
    var dictationGeneration by rememberSaveable { mutableLongStateOf(composerGeneration) }
    LaunchedEffect(composerGeneration) {
        if (composerGeneration != dictationGeneration) {
            dictationGeneration = composerGeneration
            dictation.onDraftReplaced()
        }
    }
    // A finished dictation is folded into the draft exactly once: here, or by an edit
    // that already carried it (the field shows it before it is folded in).
    var foldedDeliveryId by rememberSaveable { mutableStateOf<Long?>(null) }
    val delivery = voice.delivery?.takeIf { it.id != foldedDeliveryId }
    fun foldDelivery(into: String): String {
        val pending = delivery?.takeIf { it.id != foldedDeliveryId } ?: return into
        foldedDeliveryId = pending.id
        dictation.onDeliveryConsumed(pending.id)
        return into
    }
    LaunchedEffect(delivery?.id) {
        // Re-checked here: an edit may have folded it in between composition and this effect.
        if (delivery != null && delivery.id != foldedDeliveryId) text = foldDelivery(joinUtterances(text, delivery.text))
    }
    // What the field shows: the draft, then any words still arriving from the mic.
    val shown = joinUtterances(joinUtterances(text, delivery?.text.orEmpty()), voice.liveText)
    // A gateway dictation's words are still on their way; sending now would leave them behind.
    val awaitingTranscript = voice.phase is ComposerDictationPhase.Recording ||
        voice.phase == ComposerDictationPhase.Transcribing

    val canSend = enabled && !busy && !awaitingTranscript && shown.trim().isNotEmpty()

    fun arm(cmd: SlashCommand) {
        armedId = cmd.id
        // Strip the `/`-query so the field is clear for the actual prompt.
        text = ""
    }

    fun submit() {
        // The field intentionally stays editable while a turn runs so the user can draft a
        // follow-up. The IME action must still obey the same busy gate as the trailing Stop
        // button: otherwise pressing Send during cancellation clears the draft and races the
        // gateway's one-active-turn guard.
        if (!enabled || busy || awaitingTranscript) return
        val trimmed = shown.trim()
        if (trimmed.isEmpty()) return
        val command = armedCommand
        // Per-message: the pill governs THIS send only, then clears.
        armedId = null
        onSend(trimmed, command)
        dictation.onSent()
        text = foldDelivery("")
    }

    // A rejected send offers its text back — restore it (unless the user already started a new
    // message), then ack so it isn't re-applied on the next recomposition.
    LaunchedEffect(pendingRestore) {
        if (pendingRestore != null) {
            if (text.isEmpty()) text = pendingRestore
            onRestoreConsumed()
        }
    }

    Column(
        modifier
            // Float above whichever bottom obstruction is visible in this edge-to-edge
            // window. Inset consumption keeps the navigation bar from being counted twice
            // while the IME is open; the transcript still scrolls behind this chrome.
            .windowInsetsPadding(WindowInsets.navigationBars)
            .imePadding()
            .padding(start = OmTheme.spacing.md, end = OmTheme.spacing.md, bottom = OmTheme.spacing.sm),
    ) {
        // The `/`-typeahead floats above the pill (only when there's at least one match).
        if (menu.isOpen && menu.matches.isNotEmpty()) {
            SlashCommandMenu(matches = menu.matches, onSelect = ::arm)
            Spacer(Modifier.size(8.dp))
        }

        // The pill: a translucent navy fill rather than a light card, a fine blue-gray rim,
        // and a brighter lip along the top edge — the rim brush carries both, so the
        // highlight is the same stroke rather than a second overlay. Deliberately no glow
        // underneath: the pill is chrome, not a light source.
        val pillShape = RoundedCornerShape(28.dp)
        val palette = landingPalette
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("agentComposerPill")
                .clip(pillShape)
                .background(palette.composerFill)
                .border(
                    width = 0.8.dp,
                    brush = Brush.verticalGradient(
                        0.00f to palette.composerHighlight,
                        0.35f to palette.composerRim,
                        1.00f to palette.composerRim,
                    ),
                    shape = pillShape,
                ),
        ) {
            ComposerDictationStrip(
                dictation = dictation,
                modifier = Modifier.padding(start = 20.dp, end = 12.dp, top = 12.dp),
            )

            // The armed-command pill: top-left, glyph + label + tap-to-dismiss `×`.
            AnimatedVisibility(
                visible = armedCommand != null,
                enter = slideInHorizontally { -it } + fadeIn(),
                exit = slideOutHorizontally { -it } + fadeOut(),
            ) {
                armedCommand?.let { cmd ->
                    ArmedCommandPill(
                        cmd = cmd,
                        onDismiss = { armedId = null },
                        modifier = Modifier.padding(start = 16.dp, top = 10.dp, bottom = 2.dp),
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(
                    Modifier
                        .weight(1f)
                        .padding(start = 20.dp, top = 20.dp, bottom = 20.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    BasicTextField(
                        value = shown,
                        onValueChange = {
                            // The field showed any live words and pending transcript, so the
                            // edit already holds them.
                            dictation.onDraftEdited()
                            text = foldDelivery(it)
                        },
                        enabled = enabled,
                        textStyle = LocalTextStyle.current.merge(
                            MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp, color = colors.textPrimary),
                        ),
                        cursorBrush = SolidColor(colors.accent),
                        maxLines = 5,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { submit() }),
                        modifier = Modifier
                            .focusRequester(focusRequester)
                            .fillMaxWidth()
                            .testTag("agentComposer"),
                    )
                    if (shown.isEmpty()) {
                        Text(
                            placeholder,
                            style = MaterialTheme.typography.bodyLarge.copy(fontSize = 19.sp),
                            color = colors.textMuted,
                        )
                    }
                }

                if (voice.available) {
                    // The mic's 48dp touch target is 18dp taller than the 30dp send button, so
                    // 9dp less bottom padding keeps their centres on one line.
                    Box(Modifier.padding(bottom = 5.dp), contentAlignment = Alignment.Center) {
                        ComposerMicButton(phase = voice.phase, enabled = enabled, onTap = dictation.onMicTap)
                    }
                }
                Box(Modifier.padding(end = 10.dp, bottom = 14.dp), contentAlignment = Alignment.Center) {
                    ComposerTrailingButton(
                        busy = busy,
                        canSend = canSend,
                        onStop = onStop,
                        onSend = ::submit,
                    )
                }
            }
        }
    }
}

/**
 * The `/`-typeahead: one row per matching command, tapping a row arms it. A
 * standalone framed card floating above the composer pill.
 */
@Composable
private fun SlashCommandMenu(
    matches: List<SlashCommand>,
    onSelect: (SlashCommand) -> Unit,
) {
    val colors = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.bgSecondary)
            .border(0.5.dp, colors.border, RoundedCornerShape(16.dp)),
    ) {
        matches.forEach { cmd ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onSelect(cmd) }
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(
                    cmd.icon,
                    contentDescription = null,
                    tint = colors.accent,
                    modifier = Modifier.size(18.dp),
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        cmd.label,
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = colors.textPrimary,
                    )
                    Text(
                        cmd.hint,
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                        color = colors.textSecondary,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/**
 * The armed-command pill: glyph + label + `×`. The whole pill is clickable so
 * the dismiss target is large enough for reliable phone use. Dismissing clears
 * the arm without sending, so the next send is an ordinary turn.
 */
@Composable
private fun ArmedCommandPill(
    cmd: SlashCommand,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OmTheme.colors
    Row(
        modifier
            .noRippleClickable(onDismiss)
            .clip(CircleShape)
            .background(colors.accent.copy(alpha = 0.15f))
            .padding(start = 9.dp, end = 5.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(cmd.icon, contentDescription = null, tint = colors.accentHover, modifier = Modifier.size(13.dp))
        Text(
            cmd.label,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            color = colors.accentHover,
        )
        Icon(
            Icons.Filled.Close,
            contentDescription = "Dismiss ${cmd.label}",
            tint = colors.accentHover,
            modifier = Modifier.size(15.dp),
        )
    }
}

@Composable
private fun ComposerTrailingButton(
    busy: Boolean,
    canSend: Boolean,
    onStop: () -> Unit,
    onSend: () -> Unit,
) {
    val colors = OmTheme.colors
    when {
        busy -> Icon(
            Icons.Filled.StopCircle,
            contentDescription = "Stop",
            tint = colors.danger,
            modifier = Modifier
                .size(30.dp)
                .noRippleClickable(onStop),
        )

        else -> Icon(
            Icons.Filled.ArrowCircleUp,
            contentDescription = "Send",
            tint = if (canSend) colors.accent else colors.textMuted.copy(alpha = 0.4f),
            modifier = Modifier
                .size(30.dp)
                .testTag("agentSendButton")
                .then(if (canSend) Modifier.noRippleClickable(onSend) else Modifier),
        )
    }
}

/**
 * The composer's mic: idle, lit while it hears you (tap to stop), and resting while
 * the gateway transcribes — the strip above the field carries that wait.
 */
@Composable
private fun ComposerMicButton(phase: ComposerDictationPhase, enabled: Boolean, onTap: () -> Unit) {
    val colors = OmTheme.colors
    when (phase) {
        ComposerDictationPhase.Transcribing -> Icon(
            Icons.Outlined.Mic,
            contentDescription = null,
            tint = colors.textMuted.copy(alpha = 0.4f),
            modifier = Modifier
                .minimumInteractiveComponentSize()
                .size(30.dp)
                .padding(3.dp)
                .semantics { stateDescription = "Transcribing" },
        )
        ComposerDictationPhase.Listening, is ComposerDictationPhase.Recording -> Box(
            Modifier
                .minimumInteractiveComponentSize()
                .testTag("agentMicButton")
                .micClickable(onTap),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier.size(30.dp).clip(CircleShape).background(colors.accent),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Stop, contentDescription = "Stop dictation", tint = Color.White, modifier = Modifier.size(16.dp))
            }
        }
        ComposerDictationPhase.Idle, is ComposerDictationPhase.Failed -> Box(
            Modifier
                .minimumInteractiveComponentSize()
                .testTag("agentMicButton")
                .then(if (enabled) Modifier.micClickable(onTap) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.Mic,
                contentDescription = "Dictate",
                tint = if (enabled) colors.textSecondary else colors.textMuted.copy(alpha = 0.4f),
                modifier = Modifier.size(30.dp).padding(3.dp),
            )
        }
    }
}

/**
 * Gateway dictation's progress above the field — the recording level and time, the
 * transcription wait — and a failed dictation's notice with its ways forward. Nothing
 * for live on-device dictation, whose words appear in the field itself.
 */
@Composable
private fun ComposerDictationStrip(dictation: ComposerDictation, modifier: Modifier = Modifier) {
    when (val phase = dictation.state.phase) {
        is ComposerDictationPhase.Recording -> RecordingMeter(
            VoiceRecording(phase.level, phase.elapsedMs),
            modifier = modifier.testTag("agentDictationRecording"),
            barHeight = 16.dp,
        )
        ComposerDictationPhase.Transcribing -> TranscribingStatus(modifier)
        is ComposerDictationPhase.Failed -> DictationFailureCard(
            notice = phase.notice,
            onRetry = dictation.onRetry,
            onDictateOnDevice = dictation.onDictateOnDevice,
            onDismiss = dictation.onDismissFailure,
            modifier = modifier,
            onOpenSettings = dictation.onOpenSettings,
        )
        ComposerDictationPhase.Idle, ComposerDictationPhase.Listening -> Unit
    }
}

/** The mic's tap target: a button to accessibility services, without a ripple on the glass pill. */
private fun Modifier.micClickable(onClick: () -> Unit): Modifier = composed {
    clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        role = Role.Button,
        onClick = onClick,
    )
}

private fun Modifier.noRippleClickable(onClick: () -> Unit): Modifier = composed {
    clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onClick = onClick,
    )
}
