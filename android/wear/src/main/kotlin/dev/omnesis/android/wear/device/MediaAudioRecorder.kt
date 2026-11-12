// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.device

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import dev.omnesis.android.wear.core.AudioRecorder
import dev.omnesis.android.wearprotocol.RecordingFormat
import java.io.File
import java.io.IOException
import kotlin.math.log10
import kotlin.time.Duration

/**
 * Records with [MediaRecorder] in the shared [RecordingFormat]. Listener
 * callbacks are posted to the main thread, after the call that caused them
 * has returned.
 */
class MediaAudioRecorder(private val context: Context) : AudioRecorder {
    private val main = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(AudioManager::class.java)

    override fun start(file: File, limit: Duration, listener: AudioRecorder.Listener): AudioRecorder.Session {
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        val session = MediaSession(recorder, listener)
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioSamplingRate(RecordingFormat.SAMPLE_RATE_HZ)
            recorder.setAudioEncodingBitRate(RecordingFormat.BIT_RATE)
            recorder.setAudioChannels(RecordingFormat.CHANNELS)
            recorder.setMaxDuration(limit.inWholeMilliseconds.toInt())
            recorder.setOutputFile(file.absolutePath)
            recorder.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) session.stop()
            }
            recorder.setOnErrorListener { _, _, _ -> session.fail() }
            recorder.prepare()
            recorder.start()
        } catch (error: IOException) {
            recorder.release()
            throw error
        } catch (error: RuntimeException) {
            recorder.release()
            throw IOException("The microphone could not be opened", error)
        }
        session.takeFocus()
        return session
    }

    private inner class MediaSession(
        private val recorder: MediaRecorder,
        private val listener: AudioRecorder.Listener,
    ) : AudioRecorder.Session {
        private var open = true

        private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener({ change ->
                if (change < 0 && open) listener.onInterrupted()
            }, main)
            .build()

        fun takeFocus() {
            audio.requestAudioFocus(focusRequest)
        }

        override fun stop() {
            if (open) report(close())
        }

        override fun abandon() {
            if (open) close()
        }

        override fun powerDb(): Float {
            if (!open) return SILENCE_DB
            val amplitude = try {
                recorder.maxAmplitude
            } catch (_: IllegalStateException) {
                0
            }
            return (20 * log10(amplitude.coerceAtLeast(1) / FULL_SCALE)).coerceAtLeast(SILENCE_DB)
        }

        /** The recorder reported an error: whatever it wrote is not a usable recording. */
        fun fail() {
            if (!open) return
            close()
            report(success = false)
        }

        private fun report(success: Boolean) {
            main.post { listener.onFinished(success) }
        }

        /** Stop and release the recorder. False when it had written nothing usable. */
        private fun close(): Boolean {
            open = false
            audio.abandonAudioFocusRequest(focusRequest)
            return try {
                recorder.stop()
                true
            } catch (_: RuntimeException) {
                // Stopped before any audio was written.
                false
            } finally {
                recorder.release()
            }
        }
    }

    private companion object {
        const val SILENCE_DB = -120f
        const val FULL_SCALE = 32767f
    }
}
