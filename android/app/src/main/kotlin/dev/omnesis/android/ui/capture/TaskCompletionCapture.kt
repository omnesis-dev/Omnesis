// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

/**
 * What a note written for a task does, and how the capture screen words it: completing one of
 * the user's tasks with the note, or accepting a Brain suggestion with it.
 */
enum class TaskNoteKind(val heading: String, val prompt: String, val confirm: String) {
    COMPLETE("Done with a note", "What happened?", "Done"),
    ACCEPT("Accept with a note", "What should Omnesis know about it?", "Accept"),
}

/**
 * What the capture screen does on Done when the note belongs to a task rather than standing on
 * its own: the task it names, what the note does ([kind]), and the call that sends it —
 * returning null once the gateway took it, or the sentence that says why not.
 */
class TaskCompletionCapture(
    val taskTitle: String,
    val save: suspend (String) -> String?,
    val kind: TaskNoteKind = TaskNoteKind.COMPLETE,
)
