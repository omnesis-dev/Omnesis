// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Writes 16-bit PCM into a RIFF/WAVE file: a header with placeholder sizes up front,
 * the samples as they arrive, and the real sizes patched in on [close]. Uncompressed —
 * 16 kHz mono is 32 KB a second, 9.6 MB for five minutes — so there is no encoder to
 * fail and the gateway's decoder takes it as is.
 */
class WavWriter(file: File, private val sampleRateHz: Int, private val channels: Int = 1) : Closeable {

    private val out = RandomAccessFile(file, "rw").apply {
        setLength(0)
        write(header(dataBytes = 0))
    }

    /** Sample bytes written so far, excluding the header. */
    var dataBytes = 0L
        private set

    fun write(buffer: ByteArray, offset: Int, length: Int) {
        out.write(buffer, offset, length)
        dataBytes += length
    }

    override fun close() {
        out.seek(0)
        out.write(header(dataBytes))
        out.close()
    }

    private fun header(dataBytes: Long): ByteArray {
        val byteRate = sampleRateHz * channels * BYTES_PER_SAMPLE
        return ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray(Charsets.US_ASCII))
            putInt((36 + dataBytes).toInt())
            put("WAVE".toByteArray(Charsets.US_ASCII))
            put("fmt ".toByteArray(Charsets.US_ASCII))
            putInt(16)
            putShort(1) // PCM
            putShort(channels.toShort())
            putInt(sampleRateHz)
            putInt(byteRate)
            putShort((channels * BYTES_PER_SAMPLE).toShort())
            putShort((BYTES_PER_SAMPLE * 8).toShort())
            put("data".toByteArray(Charsets.US_ASCII))
            putInt(dataBytes.toInt())
        }.array()
    }

    companion object {
        const val HEADER_BYTES = 44
        const val BYTES_PER_SAMPLE = 2
        const val MIME_TYPE = "audio/wav"
    }
}
