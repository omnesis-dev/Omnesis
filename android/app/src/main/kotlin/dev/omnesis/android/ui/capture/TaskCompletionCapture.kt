// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

/**
 * What a note written about something does, and how the capture screen words it: completing one
 * of the user's tasks with the note, accepting a Brain suggestion with it, or telling the Morning
 * brief why an item was not worth reading or what it got wrong.
 */
enum class TaskNoteKind(val heading: String, val prompt: String, val confirm: String) {
    COMPLETE("Done with a note", "What happened?", "Done"),
    ACCEPT("Accept with a note", "What should Omnesis know about it?", "Accept"),
    NOT_INTERESTED("Why not?", "What makes this not worth your time?", "Send"),
    FACTUAL_ERROR("What's wrong?", "What did the brief get wrong?", "Send"),
}

/**
 * What the capture screen does on Done when the note belongs to something rather than standing
 * on its own: the [subject] it is about (a task's title, a brief item's sentence), what the note
 * does ([kind]), and the call that sends it — returning null once the gateway took it, or the
 * sentence that says why not.
 */
class TaskCompletionCapture(
    val subject: String,
    val save: suspend (String) -> String?,
    val kind: TaskNoteKind = TaskNoteKind.COMPLETE,
)
