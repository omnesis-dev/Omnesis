// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import java.io.File
import java.util.UUID

/** The audio a note was dictated from, sent with it for the gateway to transcribe. */
data class VoiceNoteAudio(val file: File, val mimeType: String)

/**
 * The one folder that holds dictation audio: recordings in progress, and the audio of
 * notes waiting in the offline queue. Kept out of the cache folder, which Android may
 * empty under storage pressure — a queued note whose phone transcript is empty would
 * then lose the only copy of what was said.
 *
 * Every path that finishes with a file deletes it: a delivered note, a cancelled or
 * edited dictation, a discarded queue row. [sweepOrphans] removes what a killed process
 * left behind.
 */
class VoiceNoteFiles(private val directory: File) {

    /** A fresh file for a recording about to start. */
    fun newRecording(extension: String): File {
        directory.mkdirs()
        return File(directory, "$RECORDING_PREFIX${UUID.randomUUID()}.$extension")
    }

    /**
     * Moves a finished recording to the name of the note it belongs to, so the queue row
     * that references it and the file never drift apart.
     */
    fun adopt(audio: VoiceNoteAudio, noteId: String): VoiceNoteAudio {
        directory.mkdirs()
        val target = File(directory, "$NOTE_PREFIX$noteId.${audio.file.extension}")
        if (audio.file.absolutePath == target.absolutePath) return audio
        if (!audio.file.renameTo(target)) {
            audio.file.copyTo(target, overwrite = true)
            audio.file.delete()
        }
        return VoiceNoteAudio(target, audio.mimeType)
    }

    /**
     * Deletes files that are not [referenced] by the offline queue and were last written
     * before [writtenBeforeMs] — the process start, so a recording begun since is kept.
     */
    fun sweepOrphans(referenced: Set<String>, writtenBeforeMs: Long) {
        directory.listFiles()?.forEach { file ->
            if (file.absolutePath !in referenced && file.lastModified() < writtenBeforeMs) file.delete()
        }
    }

    private companion object {
        const val RECORDING_PREFIX = "recording-"
        const val NOTE_PREFIX = "note-"
    }
}
