// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.notes.VoiceNoteAudio
import dev.omnesis.android.notes.VoiceNoteFiles
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceNoteFilesTest {

    private val dir: File = Files.createTempDirectory("voice-notes").toFile()
    private val files = VoiceNoteFiles(dir)

    @After fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun adopting_a_recording_renames_it_after_its_note() {
        val recording = files.newRecording("wav").apply { writeText("audio") }
        val adopted = files.adopt(VoiceNoteAudio(recording, "audio/wav"), "note-id-1")
        assertEquals("note-note-id-1.wav", adopted.file.name)
        assertEquals("audio/wav", adopted.mimeType)
        assertEquals("audio", adopted.file.readText())
        assertFalse(recording.exists())
        assertEquals(adopted, files.adopt(adopted, "note-id-1"))
    }

    @Test
    fun the_sweep_keeps_referenced_and_recent_files() {
        val referenced = files.newRecording("wav").apply { writeText("a"); setLastModified(1_000) }
        val orphan = files.newRecording("wav").apply { writeText("b"); setLastModified(1_000) }
        val recent = files.newRecording("wav").apply { writeText("c") }
        files.sweepOrphans(setOf(referenced.absolutePath), writtenBeforeMs = 10_000)
        assertTrue(referenced.exists())
        assertFalse(orphan.exists())
        assertTrue(recent.exists())
    }
}
