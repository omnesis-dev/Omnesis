// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File

/** A microphone recording into a file — the seam [GatewayVoiceInput] records through. */
interface AudioRecorder {
    /**
     * Opens the microphone and records into [file]. Recording stops by itself at
     * [maxBytes] (0 = no size cap) or [maxDurationMs], and then [onLimitReached] is
     * called on the main thread.
     */
    fun start(file: File, maxBytes: Long, maxDurationMs: Long, onLimitReached: () -> Unit): RecordingStart

    /** The peak amplitude (0–32767) since the previous call. */
    fun maxAmplitude(): Int

    /** Stops and finalizes the file, then releases the microphone. False when nothing playable was written. */
    fun stop(): Boolean

    /** Releases the microphone without finalizing the file. */
    fun release()
}

/** Whether a recording started. */
enum class RecordingStart {
    STARTED,

    /** RECORD_AUDIO is not granted. */
    DENIED,

    /** The microphone could not be opened: another app holds it, or no encoder. */
    FAILED,
}

/**
 * [AudioRecorder] on the platform [MediaRecorder]: mono AAC in an MPEG-4
 * container at 16 kHz / 32 kbps — the rate speech models consume, about 240 KB a
 * minute, and a container ffmpeg decodes on the gateway.
 */
class MediaRecorderAudioRecorder(private val context: Context) : AudioRecorder {

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var limitReached = false

    override fun start(file: File, maxBytes: Long, maxDurationMs: Long, onLimitReached: () -> Unit): RecordingStart {
        release()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return RecordingStart.DENIED
        }
        this.file = file
        limitReached = false
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else legacyRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(SAMPLE_RATE_HZ)
            r.setAudioEncodingBitRate(BIT_RATE_BPS)
            if (maxBytes > 0) r.setMaxFileSize(maxBytes)
            r.setMaxDuration(maxDurationMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
            r.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ||
                    what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED
                ) {
                    limitReached = true
                    onLimitReached()
                }
            }
            r.setOutputFile(file.absolutePath)
            r.prepare()
            r.start()
            recorder = r
            RecordingStart.STARTED
        } catch (e: Exception) {
            // Another app holding the mic, or a device without an AAC encoder.
            Log.w(TAG, "Could not start recording: ${e.message}")
            r.release()
            RecordingStart.FAILED
        }
    }

    override fun maxAmplitude(): Int = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)

    override fun stop(): Boolean {
        val r = recorder ?: return false
        recorder = null
        val stopped = try {
            r.stop()
            true
        } catch (e: RuntimeException) {
            // stop() throws when nothing was recorded, and may throw after a cap
            // already stopped the recorder — in which case the file is complete.
            limitReached
        } finally {
            r.release()
        }
        return stopped && (file?.length() ?: 0L) > 0L
    }

    override fun release() {
        recorder?.release()
        recorder = null
    }

    @Suppress("DEPRECATION")
    private fun legacyRecorder() = MediaRecorder()

    private companion object {
        const val TAG = "Omnesis:dictation"
        const val SAMPLE_RATE_HZ = 16_000
        const val BIT_RATE_BPS = 32_000
    }
}
