// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.notes

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NotesHistoryViewModelTest {
    private val note = NoteEntryDto("note-1", "2026-07-13", "2026-07-13T10:00:00Z", "2026-07-13T10:00:00Z",
        "Water the balcony plants", transcription = "pending", agent = NoteAgentDto("running"))
    private inner class Gateway : NotesHistoryGateway {
        var entries = listOf(note)
        var failure: Throwable? = null
        var gate: CompletableDeferred<Unit>? = null
        var editGate: CompletableDeferred<Unit>? = null
        var editedAgent: NoteAgentDto? = null
        var dayReads = 0
        var headPage: NotesHistoryDto? = null
        var pages: Map<String, NotesHistoryDto> = emptyMap()
        override suspend fun history(cursor: String?): NotesHistoryDto {
            val snapshot = entries
            gate?.await()
            return if (cursor == null) headPage ?: NotesHistoryDto(snapshot, NotesPageInfoDto())
                else pages.getValue(cursor)
        }
        override suspend fun day(day: String): List<NoteEntryDto> {
            dayReads++
            return entries.filter { it.day == day }
        }
        override suspend fun edit(id: String, text: String): NoteEntryDto {
            editGate?.await()
            failure?.let { throw it }
            return note.copy(text = text, agent = editedAgent, transcription = null)
        }
        override suspend fun delete(id: String) { failure?.let { throw it } }
        override suspend fun undo(seq: Long) { failure?.let { throw it } }
    }
    @Before fun setup() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun teardown() { Dispatchers.resetMain() }

    @Test fun edit_uses_gateway_receipt_and_supersedes_pending_transcript() = runTest {
        val gateway = Gateway()
        val vm = NotesHistoryViewModel(gateway)
        vm.select(note.id)
        vm.edit("Updated note")
        assertEquals("Updated note", vm.state.value.selected?.text)
        assertNull(vm.state.value.selected?.agent)
        assertNull(vm.state.value.selected?.transcription)
    }

    @Test fun edited_settled_note_polls_pending_revision_until_new_receipt() = runTest {
        val gateway = Gateway()
        gateway.entries = listOf(note.copy(transcription = null,
            agent = NoteAgentDto("done", NoteReceiptDto("Added the workshop."))))
        gateway.editedAgent = NoteAgentDto("pending")
        val vm = NotesHistoryViewModel(gateway)
        vm.select(note.id)
        vm.edit("Move the workshop to Sunday")
        assertEquals("pending", vm.state.value.selected?.agent?.state)
        assertNull(vm.state.value.selected?.agent?.receipt)
        assertTrue(noteNeedsRefresh(vm.state.value.selected!!))
        gateway.entries = listOf(note.copy(text = "Move the workshop to Sunday", transcription = null,
            agent = NoteAgentDto("done", NoteReceiptDto("Moved the workshop."))))
        vm.refresh(quietly = true)
        assertEquals("Moved the workshop.", vm.state.value.selected?.agent?.receipt?.text)
        assertFalse(noteNeedsRefresh(vm.state.value.selected!!))
    }

    @Test fun read_started_before_edit_cannot_restore_old_receipt() = runTest {
        val gateway = Gateway()
        gateway.entries = listOf(note.copy(transcription = null,
            agent = NoteAgentDto("done", NoteReceiptDto("Added the workshop."))))
        gateway.editedAgent = NoteAgentDto("pending")
        val vm = NotesHistoryViewModel(gateway)
        vm.select(note.id)
        gateway.gate = CompletableDeferred()
        vm.refresh()
        vm.edit("Edited workshop")
        gateway.gate!!.complete(Unit)
        assertEquals("Edited workshop", vm.state.value.selected?.text)
        assertEquals("pending", vm.state.value.selected?.agent?.state)
        assertNull(vm.state.value.selected?.agent?.receipt)
    }

    @Test fun already_deleted_note_converges_without_error() = runTest {
        val gateway = Gateway()
        val vm = NotesHistoryViewModel(gateway)
        gateway.failure = GatewayException.NotFound()
        vm.select(note.id)
        vm.delete()
        assertTrue(vm.state.value.entries.isEmpty())
        assertNull(vm.state.value.actionError)
    }

    @Test fun already_deleted_note_closes_editor_on_edit() = runTest {
        val gateway = Gateway()
        val vm = NotesHistoryViewModel(gateway)
        gateway.failure = GatewayException.NotFound()
        vm.select(note.id)
        vm.edit("Update")
        assertNull(vm.state.value.selected)
        assertTrue(vm.state.value.entries.isEmpty())
    }

    @Test fun stale_refresh_cannot_resurrect_deleted_note() = runTest {
        val gateway = Gateway()
        val vm = NotesHistoryViewModel(gateway)
        gateway.gate = CompletableDeferred()
        vm.refresh()
        vm.select(note.id)
        vm.delete()
        gateway.gate!!.complete(Unit)
        assertTrue(vm.state.value.entries.isEmpty())
    }

    @Test fun quiet_refresh_updates_pending_notes_without_resetting_selection() = runTest {
        val gateway = Gateway()
        val vm = NotesHistoryViewModel(gateway)
        vm.select(note.id)
        gateway.entries = listOf(note.copy(text = "Gateway transcript", transcription = null,
            agent = NoteAgentDto("done", NoteReceiptDto("Remembered."))))
        vm.refresh(quietly = true)
        assertEquals("Remembered.", vm.state.value.selected?.agent?.receipt?.text)
        assertEquals("Gateway transcript", vm.state.value.selected?.text)
    }

    @Test fun missing_or_skipped_agent_is_not_shown_as_processing() {
        assertNull(noteStatus(note.copy(transcription = null, agent = null)))
        assertNull(noteStatus(note.copy(transcription = null, agent = NoteAgentDto("skipped"))))
    }
    @Test fun fresh_note_without_agent_is_polled_until_receipt_arrives() = runTest {
        val gateway = Gateway()
        val fresh = note.copy(transcription = null, agent = null, receivedAt = java.time.Instant.now().toString())
        gateway.entries = listOf(fresh)
        val vm = NotesHistoryViewModel(gateway)
        assertTrue(noteNeedsRefresh(fresh))
        assertNull(noteStatus(fresh))
        gateway.entries = listOf(fresh.copy(agent = NoteAgentDto("done", NoteReceiptDto("Remembered."))))
        vm.refresh(quietly = true)
        assertEquals("Remembered.", vm.state.value.entries.single().agent?.receipt?.text)
        assertFalse(noteNeedsRefresh(vm.state.value.entries.single()))
    }

    @Test fun recent_backdated_capture_uses_receipt_time_and_stops_after_window() {
        val now = java.time.Instant.parse("2026-10-01T12:00:00Z")
        val recent = note.copy(transcription = null, agent = null, receivedAt = "2026-10-01T11:59:50Z")
        assertTrue(noteNeedsRefresh(recent, now))
        assertFalse(noteNeedsRefresh(recent, now.plusSeconds(61)))
        assertFalse(noteNeedsRefresh(recent.copy(agent = NoteAgentDto("skipped")), now))
    }

    @Test fun selecting_settled_note_reads_current_day() = runTest {
        val gateway = Gateway()
        gateway.entries = listOf(note.copy(transcription = null, agent = null))
        val vm = NotesHistoryViewModel(gateway)
        gateway.entries = listOf(note.copy(text = "Edited on another device", transcription = null, agent = null))
        vm.select(note.id)
        assertEquals("Edited on another device", vm.state.value.selected?.text)
    }
    @Test fun selecting_during_edit_does_not_start_a_stale_day_read() = runTest {
        val gateway = Gateway()
        gateway.entries = listOf(note, note.copy(id = "note-2"))
        val vm = NotesHistoryViewModel(gateway)
        vm.select(note.id)
        val before = gateway.dayReads
        gateway.editGate = CompletableDeferred()
        vm.edit("Saved edit")
        assertTrue(vm.state.value.busy)
        vm.select("note-2")
        assertEquals(before, gateway.dayReads)
        gateway.editGate!!.complete(Unit)
        assertEquals("Saved edit", vm.state.value.entries.first { it.id == note.id }.text)
    }
    @Test fun returning_to_history_discovers_new_capture_even_without_pending_rows() = runTest {
        val gateway = Gateway()
        val settled = note.copy(transcription = null, agent = NoteAgentDto("done", NoteReceiptDto("Remembered.")))
        gateway.entries = listOf(settled)
        val vm = NotesHistoryViewModel(gateway)
        assertTrue(vm.state.value.entries.none { noteNeedsRefresh(it) })
        val captured = settled.copy(id = "new-capture", text = "The rehearsal room key is in the desk drawer.")
        gateway.entries = listOf(captured, settled)
        vm.onVisible()
        assertEquals(listOf("new-capture", note.id), vm.state.value.entries.map { it.id })
    }
    @Test fun resume_merges_head_without_dropping_older_selection_and_adopts_fresh_cursor() = runTest {
        val gateway = Gateway()
        val settled = note.copy(transcription = null, agent = NoteAgentDto("done", NoteReceiptDto("Remembered.")))
        val older = settled.copy(id = "older", capturedAt = "2026-07-12T10:00:00Z", day = "2026-07-12")
        gateway.entries = listOf(settled, older)
        gateway.headPage = NotesHistoryDto(listOf(settled), NotesPageInfoDto(hasMore = true, nextCursor = "old-cursor"))
        gateway.pages = mapOf("old-cursor" to NotesHistoryDto(listOf(older), NotesPageInfoDto()))
        val vm = NotesHistoryViewModel(gateway)
        vm.loadMore()
        vm.select(older.id)
        val fresh = settled.copy(id = "fresh", capturedAt = "2026-07-14T10:00:00Z")
        val updated = settled.copy(text = "Updated on another device")
        gateway.headPage = NotesHistoryDto(listOf(fresh, updated), NotesPageInfoDto(hasMore = true, nextCursor = "fresh-cursor"))
        vm.onVisible()
        assertEquals(older.id, vm.state.value.selected?.id)
        assertEquals(listOf("fresh", note.id, "older"), vm.state.value.entries.map { it.id })
        assertEquals("Updated on another device", vm.state.value.entries.first { it.id == note.id }.text)
        assertEquals("fresh-cursor", vm.state.value.cursor)
        // More than one page of newly received notes can sit between the refreshed head and cached history.
        val gap = settled.copy(id = "gap", capturedAt = "2026-07-13T09:00:00Z")
        gateway.pages = mapOf("fresh-cursor" to NotesHistoryDto(listOf(gap, older), NotesPageInfoDto()))
        vm.loadMore()
        assertEquals(1, vm.state.value.entries.count { it.id == older.id })
        assertEquals(listOf("fresh", note.id, "gap", "older"), vm.state.value.entries.map { it.id })
    }
}
