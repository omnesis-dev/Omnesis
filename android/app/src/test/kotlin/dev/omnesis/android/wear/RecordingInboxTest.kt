// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.RecordingInboxPolicy
import dev.omnesis.android.wearprotocol.VoiceRecording
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RecordingInboxTest {
    @get:Rule
    val folder = TemporaryFolder()

    private var now = CAPTURED_AT
    private val key = "5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5d"
    private val metadata = VoiceRecording(key, CAPTURE_TIME, "en_GB", CaptureRoute.ASK).toMetadata()
    private fun inbox() = RecordingInbox(File(folder.root, "inbox")) { now }
    private val copy: suspend (File) -> Boolean = { it.writeBytes(byteArrayOf(9, 8, 7)); true }

    @Test
    fun an_admitted_recording_survives_the_process_with_its_progress() = runTest {
        val first = inbox()
        val item = (first.admit(key, metadata, WATCH, copy) as RecordingInbox.Admission.Owned).item
        item.state = item.state.copy(transcript = "When is the budget review", route = CaptureRoute.ASK)
        assertTrue(first.save(item))

        val claimed = inbox().claimLeftovers(includingKept = false).single()

        assertEquals(key, claimed.key)
        assertEquals(item.state, claimed.state)
        assertEquals(WATCH, claimed.state.sourceNodeId)
        assertEquals(listOf<Byte>(9, 8, 7), inbox().audioFile(key).readBytes().toList())
    }

    @Test
    fun a_recording_has_one_owner_in_a_process() = runTest {
        val inbox = inbox()
        val owned = (inbox.admit(key, metadata, WATCH, copy) as RecordingInbox.Admission.Owned).item

        assertEquals(RecordingInbox.Admission.Busy, inbox.admit(key, metadata, WATCH, copy))
        assertTrue(inbox.claimLeftovers(includingKept = true).isEmpty())

        // Released, it is kept for a retry: nothing else in this process picks it up again.
        inbox.release(owned)
        assertTrue(inbox.claimLeftovers(includingKept = false).isEmpty())
        assertEquals(RecordingInbox.Admission.Kept, inbox.admit(key, metadata, WATCH, copy))
        assertEquals(key, inbox.claimLeftovers(includingKept = true).single().key)
    }

    @Test
    fun a_recording_one_process_kept_is_an_ordinary_leftover_to_the_next() = runTest {
        val first = inbox()
        first.release((first.admit(key, metadata, WATCH, copy) as RecordingInbox.Admission.Owned).item)

        assertEquals(key, inbox().claimLeftovers(includingKept = false).single().key)
    }

    @Test
    fun audio_that_cannot_be_copied_leaves_nothing_behind() = runTest {
        val inbox = inbox()
        assertEquals(RecordingInbox.Admission.Failed, inbox.admit(key, metadata, WATCH) { false })
        assertEquals(RecordingInbox.Admission.Failed, inbox.admit(key, metadata, WATCH) { it.writeBytes(ByteArray(0)); true })
        assertEquals(0, inbox.count())
        assertTrue(inbox.admit(key, metadata, WATCH, copy) is RecordingInbox.Admission.Owned)
    }

    @Test
    fun half_a_recording_is_deleted_by_the_scan_that_finds_it() = runTest {
        val directory = File(folder.root, "inbox").apply { mkdirs() }
        File(directory, "$key.m4a").writeBytes(byteArrayOf(1))
        File(directory, "0b9f6c52-3d18-4a7e-8f21-6e5d4c3b2a19.json").writeText("{not json")

        assertTrue(inbox().claimLeftovers(includingKept = false).isEmpty())
        assertEquals(0, inbox().count())
    }

    @Test
    fun a_receipt_is_remembered_for_twice_the_watch_retention_and_no_longer() = runTest {
        inbox().complete(key)
        assertTrue(inbox().wasCompleted(key))

        val other = "0b9f6c52-3d18-4a7e-8f21-6e5d4c3b2a19"
        now += RecordingInboxPolicy.RECEIPT_RETENTION.inWholeMilliseconds
        inbox().complete(other)
        assertTrue("still inside the retention", inbox().wasCompleted(key))

        now += 1
        inbox().complete(other)
        assertFalse(inbox().wasCompleted(key))
        assertTrue(inbox().wasCompleted(other))
    }

    @Test
    fun only_a_uuid_names_a_recording() {
        assertEquals(key, RecordingInbox.canonicalRef(key.uppercase()))
        assertNull(RecordingInbox.canonicalRef("not-a-uuid"))
        assertNull(RecordingInbox.canonicalRef("../$key"))
        assertNull(RecordingInbox.canonicalRef("5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5"))
    }
}
