// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.RecordingMetadata
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceRecording
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.ZoneId

class OutboxStoreTest {
    private val directory = File(Files.createTempDirectory("omnesis-outbox").toFile(), "outbox")
    private var now = 1_790_000_000_000L
    private val store = OutboxStore(directory) { now }
    private val captureTime = NoteCaptureTime.at(now, ZoneId.of("Europe/London"))

    @After
    fun cleanUp() {
        directory.parentFile?.deleteRecursively()
    }

    private fun record(ref: String, route: CaptureRoute? = CaptureRoute.ASK): VoiceRecording {
        store.recordingFile(ref).writeBytes(byteArrayOf(1, 2, 3))
        return VoiceRecording(ref, captureTime, "en-GB", route)
    }

    private fun note(ref: String, text: String = "Renew the library card") = TextNote.of(text, captureTime, ref)

    @Test
    fun a_recording_joins_the_outbox_with_its_metadata_and_audio() {
        store.add(record("a"))
        val entry = store.entries().single()
        assertEquals("a", entry.ref)
        assertFalse(entry.isTextNote)
        assertEquals(now, entry.queuedAt)
        assertEquals(CaptureRoute.ASK, (entry.content as RecordingMetadata).captureRoute)
        assertTrue(store.audioFile("a").isFile)
    }

    @Test
    fun a_text_note_joins_the_outbox_without_audio() {
        store.add(note("n"))
        val entry = store.entries().single()
        assertTrue(entry.isTextNote)
        assertEquals("Renew the library card", (entry.content as TextNote).text)
        assertFalse(store.audioFile("n").exists())
    }

    @Test
    fun entries_survive_a_new_store_on_the_same_directory() {
        store.add(record("a"))
        store.add(note("n"))
        assertEquals(setOf("a", "n"), OutboxStore(directory) { now }.entries().map { it.ref }.toSet())
    }

    @Test
    fun a_recording_without_audio_is_refused() {
        assertThrows(IOException::class.java) {
            store.add(VoiceRecording("missing", captureTime, "en-GB", CaptureRoute.NOTE))
        }
        store.recordingFile("empty").writeBytes(ByteArray(0))
        assertThrows(IOException::class.java) {
            store.add(VoiceRecording("empty", captureTime, "en-GB", CaptureRoute.NOTE))
        }
        assertTrue(store.entries().isEmpty())
    }

    @Test
    fun writing_leaves_no_temporary_file_behind() {
        store.add(note("n"))
        store.recordFailure("n")
        assertEquals(listOf("n.json"), directory.list().orEmpty().toList())
    }

    @Test
    fun a_recording_still_being_made_is_left_alone() {
        val file = store.recordingFile("live")
        file.writeBytes(byteArrayOf(1))
        file.setLastModified(now - 10_000)
        assertTrue(store.entries().isEmpty())
        assertTrue(file.isFile)
    }

    @Test
    fun audio_abandoned_without_an_entry_is_deleted() {
        val file = store.recordingFile("stale")
        file.writeBytes(byteArrayOf(1))
        file.setLastModified(now - 10 * 60_000)
        assertTrue(store.entries().isEmpty())
        assertFalse(file.exists())
    }

    @Test
    fun a_recorded_entry_without_its_audio_is_deleted() {
        store.add(record("a"))
        store.audioFile("a").delete()
        assertTrue(store.entries().isEmpty())
        assertTrue(directory.list().orEmpty().isEmpty())
    }

    @Test
    fun an_unreadable_entry_is_deleted_with_its_audio() {
        store.recordingFile("bad").writeBytes(byteArrayOf(1))
        File(directory, "bad.json").writeText("not json")
        assertTrue(store.entries().isEmpty())
        assertTrue(directory.list().orEmpty().isEmpty())
    }

    @Test
    fun an_entry_under_another_ref_is_deleted() {
        store.add(note("n"))
        File(directory, "n.json").copyTo(File(directory, "other.json"))
        assertEquals(listOf("n"), store.entries().map { it.ref })
        assertFalse(File(directory, "other.json").exists())
    }

    @Test
    fun a_failure_is_counted_and_dated() {
        store.add(note("n"))
        now += 5_000
        store.recordFailure("n")
        store.recordFailure("n")
        val entry = store.entries().single()
        assertEquals(2, entry.failures)
        assertEquals(now, entry.lastFailureAt)
    }

    @Test
    fun removing_deletes_both_files() {
        store.add(record("a"))
        store.remove("a")
        assertTrue(directory.list().orEmpty().isEmpty())
        assertEquals(0, store.droppedCount)
    }

    @Test
    fun dropped_notes_are_counted_until_acknowledged() {
        store.add(record("a"))
        store.add(note("n"))
        store.drop("a")
        store.drop("n")
        assertEquals(2, store.droppedCount)
        assertEquals(2, OutboxStore(directory) { now }.droppedCount)
        assertTrue(store.entries().isEmpty())
        store.acknowledgeDropped()
        assertEquals(0, store.droppedCount)
    }
}
