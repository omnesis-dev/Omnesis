// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

/**
 * What the capture screen does on Done when it completes a task rather than saving a note: the
 * task it names, and the call that completes it with the note — returning null once the gateway
 * took it, or the sentence that says why not.
 */
class TaskCompletionCapture(
    val taskTitle: String,
    val save: suspend (String) -> String?,
)
