// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat

/** The microphone as 16-bit mono PCM — the seam [VoiceNoteRecorder] records through. */
interface PcmSource {
    val sampleRateHz: Int

    /** Opens (or reopens) the microphone. False when it cannot be opened or is not permitted. */
    fun start(): Boolean

    /** Blocks for the next samples; returns the bytes read, or 0 or less while stopped. */
    fun read(buffer: ByteArray): Int

    /** Stops capturing; [start] may resume. */
    fun stop()

    fun release()
}

/**
 * [PcmSource] on the platform [AudioRecord], 16 kHz mono, using the speech-recognition
 * input so the audio is tuned for transcription rather than for a call.
 *
 * Android silences one capture when another app takes the microphone. [onSilenced] fires
 * (on the main thread) when that happens to this one — the sign that a speech recognizer
 * ignored the audio it was handed and opened the microphone itself.
 */
class AudioRecordPcmSource(
    private val context: Context,
    private val onSilenced: () -> Unit,
) : PcmSource {

    override val sampleRateHz: Int = SAMPLE_RATE_HZ

    private var record: AudioRecord? = null
    private var recordingCallback: Any? = null

    @SuppressLint("MissingPermission") // checked just before
    override fun start(): Boolean {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        val r = record ?: run {
            val minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            if (minBuffer <= 0) return false
            val created = runCatching {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE_HZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(minBuffer, SAMPLE_RATE_HZ), // half a second of headroom
                )
            }.getOrNull() ?: return false
            if (created.state != AudioRecord.STATE_INITIALIZED) {
                created.release()
                return false
            }
            record = created
            watchForSilencing(created)
            created
        }
        return runCatching { r.startRecording() }.isSuccess &&
            r.recordingState == AudioRecord.RECORDSTATE_RECORDING
    }

    override fun read(buffer: ByteArray): Int = record?.read(buffer, 0, buffer.size) ?: -1

    override fun stop() {
        runCatching { record?.stop() }
    }

    override fun release() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            (recordingCallback as? AudioManager.AudioRecordingCallback)?.let {
                context.getSystemService(AudioManager::class.java)?.unregisterAudioRecordingCallback(it)
            }
        }
        recordingCallback = null
        record?.release()
        record = null
    }

    private fun watchForSilencing(r: AudioRecord) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val session = r.audioSessionId
        val callback = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                if (configs.any { it.clientAudioSessionId == session && it.isClientSilenced }) onSilenced()
            }
        }
        context.getSystemService(AudioManager::class.java)
            ?.registerAudioRecordingCallback(callback, Handler(Looper.getMainLooper()))
        recordingCallback = callback
    }

    companion object {
        const val SAMPLE_RATE_HZ = 16_000
    }
}
