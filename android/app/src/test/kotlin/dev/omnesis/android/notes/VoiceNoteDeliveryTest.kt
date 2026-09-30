// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.http.GatewayHttp
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Voice notes through the quick-capture pipeline: `POST /notes/voice` with the audio,
 * the plain-text fallback when the gateway will not transcribe, the offline queue
 * carrying the audio, and the audio file deleted on every path that finishes with it.
 * The audio is invented bytes; the transcripts are invented text.
 */
@RunWith(RobolectricTestRunner::class)
class VoiceNoteDeliveryTest {

    private lateinit var server: MockWebServer
    private lateinit var store: PendingNotesStore
    private lateinit var folder: File
    private lateinit var files: VoiceNoteFiles

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        store = PendingNotesStore(ApplicationProvider.getApplicationContext())
        folder = Files.createTempDirectory("voice-notes").toFile()
        files = VoiceNoteFiles(folder)
    }

    @After fun tearDown() {
        runCatching { server.shutdown() }
        folder.deleteRecursively()
    }

    private fun repo(paired: Boolean = true) = NotesRepository(
        store = store,
        gateway = {
            if (paired) {
                NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")), "dev-1")
            } else {
                null
            }
        },
        audioFiles = files,
        language = { "fr-FR" },
    )

    private fun recording(): VoiceNoteAudio =
        VoiceNoteAudio(files.newRecording("wav").apply { writeText(AUDIO) }, "audio/wav")

    private fun accepted() = MockResponse().setResponseCode(202).setBody("""{"id":"n1","transcription":"pending"}""")

    private fun entry() = MockResponse().setResponseCode(201).setBody(
        """{"id":"n1","day":"2026-07-13","capturedAt":"2026-07-13T09:00:00.000Z",
            "updatedAt":"2026-07-13T09:00:00.000Z","text":"x"}""",
    )

    private fun refusal(status: Int, code: String) =
        MockResponse().setResponseCode(status).setBody("""{"error":"refused","code":"$code"}""")

    @Test
    fun a_voice_note_is_posted_with_its_audio_and_the_audio_is_deleted() = runTest {
        server.enqueue(accepted())
        val outcome = repo().capture("  Pick up basil  ", "android-tile", recording())

        assertEquals(CaptureOutcome.Posted, outcome)
        val request = server.takeRequest()
        assertEquals("/notes/voice", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        val body = request.body.readUtf8()
        assertTrue(body.contains("name=\"note\""))
        assertTrue(body.contains("\"text\":\"Pick up basil\""))
        assertTrue(body.contains("\"surface\":\"android-tile\""))
        assertTrue(body.contains("\"language\":\"fr-FR\""))
        assertTrue(body.contains("name=\"audio\""))
        assertTrue(body.contains("Content-Type: audio/wav"))
        assertTrue(body.contains(AUDIO))
        assertTrue(store.readAll().isEmpty())
        assertTrue(folder.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun a_gateway_that_will_not_transcribe_gets_the_phones_transcript_as_a_plain_note() = runTest {
        server.enqueue(refusal(409, "DICTATION_DISABLED"))
        server.enqueue(entry())

        val outcome = repo().capture("Call the florist", "android-app", recording())

        assertEquals(CaptureOutcome.Posted, outcome)
        assertEquals("/notes/voice", server.takeRequest().path)
        val text = server.takeRequest()
        assertEquals("/notes", text.path)
        assertTrue(text.body.readUtf8().contains("\"text\":\"Call the florist\""))
        assertTrue(folder.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun a_refused_voice_note_without_a_transcript_is_not_saved_empty() = runTest {
        server.enqueue(refusal(503, "TRANSCRIBER_UNAVAILABLE"))
        try {
            repo().capture("", "android-app", recording())
            fail("expected VoiceNoteNotSavedException")
        } catch (e: VoiceNoteNotSavedException) {
            assertEquals("Couldn't save your voice note.", e.message)
        }
        assertEquals(1, server.requestCount)
        assertTrue(store.readAll().isEmpty())
        assertTrue(folder.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun an_unreachable_gateway_queues_the_note_with_its_audio() = runTest {
        server.enqueue(MockResponse().setResponseCode(502).setBody("bad gateway"))

        val outcome = repo().capture("", "android-assistant", recording())

        assertEquals(CaptureOutcome.Queued(QueueReason.UNREACHABLE), outcome)
        val queued = store.readAll().single()
        assertEquals("", queued.text)
        assertEquals("fr-FR", queued.language)
        val audio = queued.audio!!
        // The file belongs to the note now, under its id.
        assertEquals("note-${queued.noteId}.wav", audio.file.name)
        assertEquals(AUDIO, audio.file.readText())
    }

    @Test
    fun a_note_queued_while_unpaired_is_delivered_with_its_audio_by_the_drain() = runTest {
        repo(paired = false).capture("Water the ferns", "android-tile", recording())
        val queued = store.readAll().single()
        assertTrue(queued.audio!!.file.exists())

        server.enqueue(accepted())
        repo().drain()

        val request = server.takeRequest()
        assertEquals("/notes/voice", request.path)
        assertTrue(request.body.readUtf8().contains("\"id\":\"${queued.noteId}\""))
        assertTrue(store.readAll().isEmpty())
        assertFalse(queued.audio!!.file.exists())
    }

    @Test
    fun the_drain_keeps_a_voice_note_without_transcript_the_gateway_cannot_take_yet() = runTest {
        repo(paired = false).capture("", "android-tile", recording())
        store.insert("typed", "Typed afterwards", "2026-07-13T10:00:00.000Z", "android-app")
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not found"}"""))
        server.enqueue(entry())

        repo().drain()

        assertEquals("/notes/voice", server.takeRequest().path)
        assertEquals("/notes", server.takeRequest().path)
        val kept = store.readAll().single()
        assertEquals("", kept.text)
        assertEquals(1, kept.retryCount)
        assertTrue(kept.audio!!.file.exists())
    }

    @Test
    fun the_drain_sends_a_refused_voice_note_with_a_transcript_as_text() = runTest {
        repo(paired = false).capture("Renew the passport", "android-app", recording())
        val audio = store.readAll().single().audio!!.file
        server.enqueue(refusal(503, "TRANSCRIBER_UNAVAILABLE"))
        server.enqueue(entry())

        repo().drain()

        assertEquals("/notes/voice", server.takeRequest().path)
        assertEquals("/notes", server.takeRequest().path)
        assertTrue(store.readAll().isEmpty())
        assertFalse(audio.exists())
    }

    @Test
    fun discarding_a_queued_voice_note_deletes_its_audio() = runTest {
        val repo = repo(paired = false)
        repo.capture("", "android-app", recording())
        val queued = store.readAll().single()

        repo.deletePending(queued.id)

        assertTrue(store.readAll().isEmpty())
        assertFalse(queued.audio!!.file.exists())
    }

    @Test
    fun a_drain_deletes_only_earlier_audio_no_queued_note_needs() = runTest {
        val repo = repo(paired = false)
        repo.capture("", "android-app", recording())
        val kept = store.readAll().single().audio!!.file.apply { setLastModified(1_000) }
        val orphan = files.newRecording("wav").apply { writeText(AUDIO); setLastModified(1_000) }
        val inProgress = files.newRecording("wav").apply { writeText(AUDIO) }

        repo.drain()

        assertTrue(kept.exists())
        assertFalse(orphan.exists())
        assertTrue(inProgress.exists())
    }

    @Test
    fun a_typed_note_is_unchanged_by_voice_notes() = runTest {
        server.enqueue(entry())
        repo().capture("Just typed", "android-app")
        assertEquals("/notes", server.takeRequest().path)
        assertNull(store.readAll().firstOrNull())
    }

    private companion object {
        const val AUDIO = "RIFF-invented-audio-bytes"
    }
}
