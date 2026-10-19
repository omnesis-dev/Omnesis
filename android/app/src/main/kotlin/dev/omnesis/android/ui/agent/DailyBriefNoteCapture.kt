// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.hilt.navigation.compose.hiltViewModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.capture.CaptureScreen
import dev.omnesis.android.ui.capture.CaptureViewModel
import dev.omnesis.android.ui.capture.TaskCompletionCapture

/**
 * The words behind a thumbs-down on a Morning brief item: the Tell Omnesis capture, listening as
 * soon as it opens and ready for typing, filling the screen the way a task's "Done + note" does.
 * [capture] says what the words are about and where they go; [onClose] runs whether the capture
 * saved, was cancelled or was dismissed. The capture stays open with its words when the gateway
 * refuses, so nothing said is lost.
 */
@Composable
fun DailyBriefNoteCapture(capture: TaskCompletionCapture, onClose: () -> Unit) {
    val vm: CaptureViewModel = hiltViewModel(key = BRIEF_NOTE_CAPTURE_KEY)
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
            CaptureScreen(onClose = onClose, vm = vm, completion = capture)
        }
    }
}

/** One capture view model serves every brief reaction note; each opening starts it afresh. */
private const val BRIEF_NOTE_CAPTURE_KEY = "dailyBrief.reaction-note"
