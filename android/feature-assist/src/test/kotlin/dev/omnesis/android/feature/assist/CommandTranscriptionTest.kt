// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files

class CommandTranscriptionTest {
    private val dir = Files.createTempDirectory("commands").toFile()
    private var now = 1_000L

    /** Answers [text] after 400 ms of the test clock, keeping what it was given. */
    private inner class Fake(private val text: String?, private val problem: String? = null) : CommandTranscriber {
        var heard: ByteArray? = null
        var locale: String? = null
        override fun unavailable() = problem
        override suspend fun transcribe(wav: File, locale: String?): String? {
            heard = wav.readBytes()
            this.locale = locale
            now += 400
            return text
        }
    }

    @After fun tearDown() {
        dir.deleteRecursively()
    }

    private fun transcription(kind: TranscriberKind, vararg transcribers: Pair<TranscriberKind, CommandTranscriber>) =
        CommandTranscription(CommandTranscribers(mapOf(*transcribers)), { kind }, dir, clock = { now }, locale = { "it-IT" })

    @Test fun theChosenKindHearsTheCommandAsAWavThatIsThenDeleted() = runBlocking {
        val gateway = Fake(" accendi la luce ")
        val phone = Fake("unused")
        val t = transcription(TranscriberKind.GATEWAY, TranscriberKind.GATEWAY to gateway, TranscriberKind.PHONE to phone)
        val pcm = ShortArray(16_000) { (it % 100).toShort() }

        assertEquals("accendi la luce", t.transcribe(pcm))
        assertNull(phone.heard)
        assertEquals("it-IT", gateway.locale)
        val wav = gateway.heard!!
        assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
        assertEquals(16_000, ByteBuffer.wrap(wav, 24, 4).order(ByteOrder.LITTLE_ENDIAN).int)
        val samples = ByteBuffer.wrap(wav, 44, wav.size - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        assertArrayEquals(pcm, ShortArray(samples.remaining()).also { samples.get(it) })
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test fun eachKindKeepsItsLastTiming() = runBlocking {
        val t = transcription(TranscriberKind.PHONE, TranscriberKind.PHONE to Fake(""))
        assertNull(t.transcribe(ShortArray(24_000)))
        assertEquals(mapOf(TranscriberKind.PHONE to TranscriptionTiming(audioMs = 1_500, tookMs = 400, heard = false)), t.timings.value)
    }

    @Test fun anUnavailableOrMissingKindTranscribesNothing() = runBlocking {
        val t = transcription(TranscriberKind.GATEWAY, TranscriberKind.GATEWAY to Fake("x", problem = "not paired"))
        assertNull(t.transcribe(ShortArray(100)))
        assertEquals("not paired", t.unavailable(TranscriberKind.GATEWAY))
        assertEquals("not available in this app", t.unavailable(TranscriberKind.PHONE))
        assertNull(transcription(TranscriberKind.PHONE).transcribe(ShortArray(100)))
    }
}
