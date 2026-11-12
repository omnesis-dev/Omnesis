// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File

/** One closed chunk of a recording, ready for the outbox. */
data class RecordedChunk(
    val seq: Int,
    /** Wall-clock instant the chunk's audio starts, epoch ms. */
    val startedAtMs: Long,
    val durationMs: Long,
    val file: File,
    /** The loudest level heard during the chunk, 0–32767 as `MediaRecorder.getMaxAmplitude`. */
    val peakAmplitude: Int,
    /** The microphone was taken from the recorder during the chunk. */
    val interrupted: Boolean,
)

/** Pure choices about the audio: kept separate so they are unit-testable. */
object ChunkPolicy {
    const val SAMPLE_RATE_HZ = 16_000
    const val BIT_RATE = 32_000
    /** AAC in an MPEG-4 container: the format whose recorder can switch files without stopping. */
    const val MIME_TYPE = "audio/mp4"
    const val FILE_EXTENSION = "m4a"
    /** About a minute of audio per chunk at [BIT_RATE]. */
    const val TARGET_CHUNK_MS = 60_000L
    /**
     * Below this peak a chunk is treated as silence and its audio is not sent.
     * A first estimate; it needs tuning against real recordings on devices.
     * See #862 — planned: on-device voice activity detection instead.
     */
    const val SILENCE_PEAK = 500

    /**
     * File size that holds about [TARGET_CHUNK_MS] of audio at [BIT_RATE]
     * (240 kB). The MPEG-4 header and index add a few kB a minute, so a
     * chunk runs a little under a minute.
     */
    fun maxChunkBytes(): Long = BIT_RATE / 8L * TARGET_CHUNK_MS / 1000L

    fun isSilent(peakAmplitude: Int): Boolean = peakAmplitude < SILENCE_PEAK

    fun fileName(seq: Int): String = "chunk-%05d.%s".format(seq, FILE_EXTENSION)

    /** The chunk number a [fileName] encodes, or null for any other file. */
    fun seqOf(fileName: String): Int? =
        Regex("""chunk-(\d+)\.$FILE_EXTENSION""").matchEntire(fileName)?.groupValues?.get(1)?.toIntOrNull()
}

/**
 * Records the microphone into a sequence of AAC files in an MPEG-4 container
 * of about a minute each. Near the size limit the recorder is handed the next
 * file with `setNextOutputFile`, and switches to it without stopping, so no
 * audio is lost at a boundary. When the next file could not be queued in
 * time, the recorder stops at the limit and is restarted, losing the
 * restart's few milliseconds; if the microphone cannot be reopened, the
 * closed chunk is marked interrupted and [onMicrophoneLost] reports it. Each
 * closed file is handed to [onChunk] with its timing, its peak level (for the
 * silence gate) and whether the microphone was taken.
 *
 * The source is chosen for a voice across a table, not one held to the
 * mouth: `UNPROCESSED` where the device supports it, else `VOICE_RECOGNITION`,
 * which the platform runs without automatic gain control or noise
 * suppression.
 *
 * Pausing closes the current chunk and stops the recorder; resuming starts a
 * fresh chunk, so a pause shows on the gateway as a gap between chunk times.
 * Not thread-safe: drive it from one thread (the service's main thread).
 */
class ChunkedAudioRecorder(
    private val context: Context,
    private val directory: File,
    private val onChunk: (RecordedChunk) -> Unit,
    private val onMicrophoneLost: () -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private var recorder: MediaRecorder? = null
    private var nextSeq = 0
    private var current: Pending? = null
    private var queued: Pending? = null
    private var peak = 0
    private var interrupted = false
    private val handler = Handler(Looper.getMainLooper())
    private var recordingCallback: Any? = null

    private class Pending(val seq: Int, val file: File, var startedAtMs: Long)

    val chunksRecorded: Int get() = nextSeq
    val isRecording: Boolean get() = recorder != null

    /**
     * Start, or resume after [pause]. Returns false when the microphone could
     * not be opened. The session directory must exist.
     */
    fun start(): Boolean {
        if (recorder != null) return true
        val first = newPending(clock())
        var opened: MediaRecorder? = null
        return try {
            val r = newRecorder().also { opened = it }
            r.setOutputFile(first.file)
            r.setMaxFileSize(ChunkPolicy.maxChunkBytes())
            r.setOnInfoListener { _, what, _ -> onInfo(what) }
            r.prepare()
            r.start()
            first.startedAtMs = clock()
            current = first
            peak = 0
            interrupted = false
            recorder = r
            watchForSilencing()
            handler.post(peakPoller)
            true
        } catch (e: Exception) {
            Log.w(TAG, "Could not start recording: ${e.message}")
            opened?.release()
            first.file.delete()
            nextSeq--
            false
        }
    }

    /** Close the current chunk and stop; [start] resumes with a new chunk. */
    fun pause() {
        close()?.let(onChunk)
    }

    /** Close the last chunk and stop for good. */
    fun stop() = pause()

    /** Mark the chunk in progress as interrupted (a call, another app taking the microphone). */
    fun markInterrupted() {
        interrupted = true
    }

    private fun onInfo(what: Int) {
        when (what) {
            MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_APPROACHING -> {
                if (queued != null) return
                val next = newPending(clock())
                try {
                    recorder?.setNextOutputFile(next.file)
                    queued = next
                } catch (e: Exception) {
                    Log.w(TAG, "Could not queue the next chunk: ${e.message}")
                    next.file.delete()
                    nextSeq--
                }
            }
            MediaRecorder.MEDIA_RECORDER_INFO_NEXT_OUTPUT_FILE_STARTED -> {
                val now = clock()
                val next = queued ?: return
                queued = null
                current?.let { onChunk(closedChunk(it, now)) }
                next.startedAtMs = now
                current = next
            }
            MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED -> {
                // The next file could not be queued in time: close this chunk
                // and start over. The chunk is reported after the restart so
                // that a failed one marks it interrupted.
                val closed = close()
                val restarted = start()
                closed?.let { onChunk(if (restarted) it else it.copy(interrupted = true)) }
                if (!restarted) onMicrophoneLost()
            }
        }
    }

    /** Stop the recorder and return its current chunk, closed. */
    private fun close(): RecordedChunk? {
        val r = recorder ?: return null
        handler.removeCallbacks(peakPoller)
        samplePeak()
        unwatchSilencing()
        val now = clock()
        try {
            r.stop()
        } catch (e: RuntimeException) {
            // stop() throws when no audio was captured, or after the recorder
            // stopped itself at the size limit; the controller judges the file.
            Log.w(TAG, "Recorder stop: ${e.message}")
        }
        r.release()
        recorder = null
        // A queued next file the recorder never switched to holds no audio:
        // give its number back so the sequence stays dense.
        queued?.let {
            it.file.delete()
            nextSeq = it.seq
        }
        queued = null
        val chunk = current?.let { closedChunk(it, now) }
        current = null
        return chunk
    }

    /**
     * The chunk [pending] became, ending at [endMs]. Every number is reported,
     * even for an empty file, so the sequence stays dense: the gateway
     * expects every number below the count.
     */
    private fun closedChunk(pending: Pending, endMs: Long): RecordedChunk =
        RecordedChunk(
            seq = pending.seq,
            startedAtMs = pending.startedAtMs,
            durationMs = (endMs - pending.startedAtMs).coerceAtLeast(0),
            file = pending.file,
            peakAmplitude = peak,
            interrupted = interrupted,
        ).also {
            peak = 0
            interrupted = false
        }

    private fun newPending(startMs: Long): Pending {
        val seq = nextSeq++
        return Pending(seq, File(directory, ChunkPolicy.fileName(seq)), startMs)
    }

    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder {
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
        r.setAudioSource(audioSource())
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioChannels(1)
        r.setAudioSamplingRate(ChunkPolicy.SAMPLE_RATE_HZ)
        r.setAudioEncodingBitRate(ChunkPolicy.BIT_RATE)
        return r
    }

    private fun audioSource(): Int {
        val unprocessed = context.getSystemService(AudioManager::class.java)
            ?.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED)
        return if (unprocessed == "true") {
            MediaRecorder.AudioSource.UNPROCESSED
        } else {
            MediaRecorder.AudioSource.VOICE_RECOGNITION
        }
    }

    private val peakPoller = object : Runnable {
        override fun run() {
            samplePeak()
            if (recorder != null) handler.postDelayed(this, PEAK_POLL_MS)
        }
    }

    private fun samplePeak() {
        val level = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
        if (level > peak) peak = level
    }

    private fun watchForSilencing() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val callback = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                val mine = recorder?.activeRecordingConfiguration ?: return
                if (configs.any { it.clientAudioSessionId == mine.clientAudioSessionId && it.isClientSilenced }) {
                    markInterrupted()
                }
            }
        }
        context.getSystemService(AudioManager::class.java)?.registerAudioRecordingCallback(callback, handler)
        recordingCallback = callback
    }

    private fun unwatchSilencing() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            (recordingCallback as? AudioManager.AudioRecordingCallback)?.let {
                context.getSystemService(AudioManager::class.java)?.unregisterAudioRecordingCallback(it)
            }
        }
        recordingCallback = null
    }

    private companion object {
        const val TAG = "Omnesis:Recording"
        const val PEAK_POLL_MS = 200L
    }
}
