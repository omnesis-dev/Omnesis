// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import android.os.ParcelFileDescriptor
import dev.omnesis.android.notes.VoiceNoteAudio
import dev.omnesis.android.ui.capture.RecognizerAudioInput
import java.io.File

/** A scripted [VoiceNoteSession] over a real temp file, recording what the screen asked of it. */
class FakeVoiceNoteSession(private val file: File, private val captured: Boolean = true) : VoiceNoteSession {
    override var listener: VoiceNoteSession.Listener? = null
    var inputs = 0
    var paused = 0
    var resumed = 0
    var finished = false
    var discarded = false

    override fun recognizerInput(): RecognizerAudioInput {
        inputs++
        val (read, write) = ParcelFileDescriptor.createPipe()
        write.close()
        return RecognizerAudioInput(read, 16_000)
    }

    override fun pause() {
        paused++
    }

    override fun resume(): Boolean {
        resumed++
        return true
    }

    override fun finish(): VoiceNoteAudio? {
        finished = true
        if (!captured) {
            file.delete()
            return null
        }
        file.writeText("RIFF-invented")
        return VoiceNoteAudio(file, WavWriter.MIME_TYPE)
    }

    override fun discard() {
        discarded = true
        file.delete()
    }
}
