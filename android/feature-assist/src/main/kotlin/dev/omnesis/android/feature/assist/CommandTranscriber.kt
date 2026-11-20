// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID

/** Who turns a command into text, for the destinations that need text. */
enum class TranscriberKind {
    /** The paired gateway's own transcriber. */
    GATEWAY,

    /** This phone's on-device speech recognizer. */
    PHONE,
}

/** Turns a recorded command into text. The app provides one per [TranscriberKind]. */
interface CommandTranscriber {
    /** Why it cannot transcribe now, as shown on the card; null when it can. */
    fun unavailable(): String?

    /** The text of the 16 kHz mono WAV [wav]; null when nothing was heard or it could not run. */
    suspend fun transcribe(wav: File, locale: String?): String?
}

/** What the app provides: the transcriber of each kind it can offer. */
class CommandTranscribers(private val byKind: Map<TranscriberKind, CommandTranscriber>) {
    operator fun get(kind: TranscriberKind): CommandTranscriber? = byKind[kind]
}

/** How long one transcription took, to compare the two kinds on real commands. */
data class TranscriptionTiming(val audioMs: Long, val tookMs: Long, val heard: Boolean)

/**
 * Transcribes a command with the kind the user chose: the samples go to a
 * WAV in [directory], which is deleted as soon as the transcriber is done,
 * and how long it took is logged and kept for the card.
 */
class CommandTranscription(
    private val transcribers: CommandTranscribers,
    private val kind: () -> TranscriberKind,
    private val directory: File,
    private val clock: () -> Long = System::currentTimeMillis,
    private val locale: () -> String = { Locale.getDefault().toLanguageTag() },
) {
    private val _timings = MutableStateFlow<Map<TranscriberKind, TranscriptionTiming>>(emptyMap())

    /** The last transcription of each kind. */
    val timings: StateFlow<Map<TranscriberKind, TranscriptionTiming>> = _timings.asStateFlow()

    /** Why [kind] cannot transcribe now; null when it can. */
    fun unavailable(kind: TranscriberKind): String? {
        val transcriber = transcribers[kind] ?: return "not available in this app"
        return transcriber.unavailable()
    }

    suspend fun transcribe(pcm: ShortArray): String? {
        val k = kind()
        val transcriber = transcribers[k] ?: return null
        if (transcriber.unavailable() != null) return null
        val wav = withContext(Dispatchers.IO) {
            directory.mkdirs()
            File(directory, "command-${UUID.randomUUID()}.wav").also { writeWav(it, pcm) }
        }
        val started = clock()
        return try {
            val text = transcriber.transcribe(wav, locale())?.trim()?.takeIf { it.isNotEmpty() }
            val timing = TranscriptionTiming(audioMs = pcm.size * 1000L / SAMPLE_RATE_HZ, tookMs = clock() - started, heard = text != null)
            Log.i(TAG, "Transcribed ${timing.audioMs} ms of audio in ${timing.tookMs} ms (${k.name.lowercase()})${if (text == null) ", nothing heard" else ""}")
            _timings.update { it + (k to timing) }
            text
        } finally {
            withContext(Dispatchers.IO) { wav.delete() }
        }
    }

    companion object {
        private const val TAG = "Omnesis:Assist"
        const val SAMPLE_RATE_HZ = 16_000

        /** [pcm], 16-bit mono at 16 kHz, as a RIFF/WAVE file. */
        fun writeWav(file: File, pcm: ShortArray) {
            val data = pcm.size * 2
            val buffer = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN)
            buffer.put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(36 + data)
            buffer.put("WAVE".toByteArray(Charsets.US_ASCII))
            buffer.put("fmt ".toByteArray(Charsets.US_ASCII)).putInt(16)
            buffer.putShort(1).putShort(1).putInt(SAMPLE_RATE_HZ).putInt(SAMPLE_RATE_HZ * 2).putShort(2).putShort(16)
            buffer.put("data".toByteArray(Charsets.US_ASCII)).putInt(data)
            for (s in pcm) buffer.putShort(s)
            FileOutputStream(file).use { it.write(buffer.array()) }
        }
    }
}
