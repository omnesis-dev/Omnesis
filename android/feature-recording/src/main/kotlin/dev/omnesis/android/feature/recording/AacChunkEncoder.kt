// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteOrder

/** Writes mono 16-bit PCM at [ChunkPolicy.SAMPLE_RATE_HZ] to one chunk file. */
interface PcmChunkEncoder {
    fun write(pcm: ShortArray, length: Int = pcm.size)

    /** Closes the file. One that received no audio is left empty. */
    fun finish()
}

fun interface PcmChunkEncoderFactory {
    fun open(file: File): PcmChunkEncoder
}

/**
 * The phone microphone's chunk format, produced from PCM: AAC-LC at
 * [ChunkPolicy.BIT_RATE] in an MPEG-4 container, so a chunk from a wearable is
 * read by the same speech check and transcribed the same way.
 */
class MediaCodecAacChunkEncoder(private val file: File) : PcmChunkEncoder {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private val info = MediaCodec.BufferInfo()
    private var track = -1
    private var samples = 0L
    private var wroteAudio = false

    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, ChunkPolicy.SAMPLE_RATE_HZ, 1)
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        format.setInteger(MediaFormat.KEY_BIT_RATE, ChunkPolicy.BIT_RATE)
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }

    override fun write(pcm: ShortArray, length: Int) {
        var at = 0
        while (at < length) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index < 0) {
                drain(endOfStream = false)
                continue
            }
            val buffer = codec.getInputBuffer(index)!!.order(ByteOrder.LITTLE_ENDIAN)
            buffer.clear()
            val n = minOf(length - at, buffer.capacity() / 2)
            buffer.asShortBuffer().put(pcm, at, n)
            codec.queueInputBuffer(index, 0, n * 2, presentationUs(), 0)
            samples += n
            at += n
            drain(endOfStream = false)
        }
    }

    override fun finish() {
        try {
            if (samples > 0) {
                var index: Int
                do {
                    index = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (index < 0) drain(endOfStream = false)
                } while (index < 0)
                codec.queueInputBuffer(index, 0, 0, presentationUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                drain(endOfStream = true)
            }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            if (wroteAudio) muxer.stop()
            muxer.release()
            if (!wroteAudio) file.writeBytes(ByteArray(0))
        }
    }

    private fun presentationUs(): Long = samples * 1_000_000L / ChunkPolicy.SAMPLE_RATE_HZ

    private fun drain(endOfStream: Boolean) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0)
            when {
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                }
                index >= 0 -> {
                    val buffer = codec.getOutputBuffer(index)!!
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (!config && info.size > 0 && track >= 0) {
                        buffer.position(info.offset).limit(info.offset + info.size)
                        muxer.writeSampleData(track, buffer, info)
                        wroteAudio = true
                    }
                    codec.releaseOutputBuffer(index, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
                index == MediaCodec.INFO_TRY_AGAIN_LATER && !endOfStream -> return
            }
        }
    }

    private companion object {
        const val TIMEOUT_US = 10_000L
    }
}
