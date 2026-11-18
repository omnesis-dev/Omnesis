// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.io.File
import java.nio.ByteOrder
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Decides whether a closed chunk holds speech. It decodes a copy of the
 * chunk's audio and scores it with [detector], stopping at the first run of
 * speech, then scores the chunk's last [ChunkPolicy.TAIL_MS] on their own to
 * tell whether speech runs into the next chunk; the file itself is left as
 * recorded. Any failure, including a model that does not load, is
 * [SpeechVerdict.Unknown] with speech at the end, which the controller treats
 * as speech: a broken detector costs a transcription, never audio.
 */
class ChunkSpeechScanner(private val detector: SpeechDetector) {
    suspend fun scan(file: File): ChunkSpeech = withContext(Dispatchers.Default) {
        val started = System.nanoTime()
        try {
            val scan = AacPcmSource(file).use { scanForSpeech(it, detector) }
            if (scan.verdict == SpeechVerdict.Speech) {
                val atEnd = speechInTail(file)
                val ms = (System.nanoTime() - started) / 1_000_000
                Log.i(TAG, "${file.name}: speech by ${scan.speechAtMs} ms, peak ${scan.peak}, ${if (atEnd) "speech" else "no speech"} at the end (scored in $ms ms)")
                ChunkSpeech(SpeechVerdict.Speech, speechAtEnd = atEnd)
            } else {
                val ms = (System.nanoTime() - started) / 1_000_000
                Log.i(
                    TAG,
                    "${file.name}: no speech, highest probability %.2f, %d of %d frames at %.2f and %d at %.2f, longest %d ms, peak %d (scored in %d ms)".format(
                        Locale.ROOT, scan.maxProbability, scan.framesAtThreshold, scan.frames, ChunkPolicy.SPEECH_THRESHOLD,
                        scan.framesAtEndThreshold, ChunkPolicy.SPEECH_END_THRESHOLD, scan.longestSpeechMs, scan.peak, ms,
                    ),
                )
                // A full scan without speech: none in the last seconds either.
                ChunkSpeech(SpeechVerdict.NoSpeech, speechAtEnd = false)
            }
        } catch (e: Exception) {
            Log.w(TAG, "${file.name}: speech not scored, sending its audio: ${e.message}")
            ChunkSpeech(SpeechVerdict.Unknown, speechAtEnd = true)
        } catch (e: LinkageError) {
            // The ONNX Runtime native library did not load on this device.
            Log.w(TAG, "${file.name}: speech detector unavailable, sending its audio: ${e.message}")
            ChunkSpeech(SpeechVerdict.Unknown, speechAtEnd = true)
        }
    }

    /** Whether the last [ChunkPolicy.TAIL_MS] of [file] hold speech; true when that cannot be told. */
    private fun speechInTail(file: File): Boolean = try {
        AacPcmSource(file, fromEndUs = ChunkPolicy.TAIL_MS * 1000).use { scanForSpeech(it, detector).verdict != SpeechVerdict.NoSpeech }
    } catch (e: Exception) {
        Log.w(TAG, "${file.name}: end not scored, keeping the next chunk: ${e.message}")
        true
    }

    private companion object {
        const val TAG = "Omnesis:RecordingVad"
    }
}

/**
 * The PCM of an AAC chunk as [ChunkedAudioRecorder] writes it: mono, at
 * [ChunkPolicy.SAMPLE_RATE_HZ]. Any other layout is refused rather than
 * resampled, so the scan never scores audio it misread. With [fromEndUs], it
 * starts that long before the end of the track (every AAC frame is a sync
 * point); a track that does not state its length is refused.
 */
private class AacPcmSource(file: File, fromEndUs: Long? = null) : PcmSource, AutoCloseable {
    private val extractor = MediaExtractor()
    private val codec: MediaCodec
    private val info = MediaCodec.BufferInfo()
    private var inputDone = false
    private var outputDone = false
    private var pending: ShortArray = ShortArray(0)
    private var pendingAt = 0

    init {
        var opened: MediaCodec? = null
        try {
            extractor.setDataSource(file.path)
            val track = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: error("no audio track")
            extractor.selectTrack(track)
            val format = extractor.getTrackFormat(track)
            if (fromEndUs != null) {
                check(format.containsKey(MediaFormat.KEY_DURATION)) { "the track does not state its length" }
                val startUs = (format.getLong(MediaFormat.KEY_DURATION) - fromEndUs).coerceAtLeast(0)
                extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            }
            opened = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            opened.configure(format, null, null, 0)
            opened.start()
            codec = opened
        } catch (e: Exception) {
            opened?.release()
            extractor.release()
            throw e
        }
    }

    override fun read(into: ShortArray): Int {
        while (pendingAt >= pending.size) {
            if (outputDone) return -1
            decodeStep()
        }
        val n = minOf(into.size, pending.size - pendingAt)
        pending.copyInto(into, 0, pendingAt, pendingAt + n)
        pendingAt += n
        return n
    }

    /** Feed one input buffer if one is free, and take one output buffer if one is ready. */
    private fun decodeStep() {
        if (!inputDone) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) {
                val buffer = codec.getInputBuffer(index)!!
                val size = extractor.readSampleData(buffer, 0)
                if (size < 0) {
                    codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    inputDone = true
                } else {
                    codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
                    extractor.advance()
                }
            }
        }
        val index = codec.dequeueOutputBuffer(info, TIMEOUT_US)
        when {
            index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> checkFormat(codec.outputFormat)
            index >= 0 -> {
                val buffer = codec.getOutputBuffer(index)!!.order(ByteOrder.nativeOrder())
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                val shorts = buffer.asShortBuffer()
                pending = ShortArray(shorts.remaining()).also { shorts.get(it) }
                pendingAt = 0
                codec.releaseOutputBuffer(index, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
            }
        }
    }

    private fun checkFormat(format: MediaFormat) {
        val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        check(rate == ChunkPolicy.SAMPLE_RATE_HZ && channels == 1) { "decoded $rate Hz × $channels, expected mono ${ChunkPolicy.SAMPLE_RATE_HZ} Hz" }
        if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
            check(format.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_16BIT) { "decoder output is not 16-bit PCM" }
        }
    }

    override fun close() {
        runCatching { codec.stop() }
        codec.release()
        extractor.release()
    }

    private companion object {
        const val TIMEOUT_US = 10_000L
    }
}
