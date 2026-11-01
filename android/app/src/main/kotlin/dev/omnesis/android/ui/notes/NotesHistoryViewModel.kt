// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.notes

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.transport.dto.NotesHistoryDto
import dev.omnesis.android.ui.common.classifyGatewayError
import javax.inject.Inject
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal interface NotesHistoryGateway {
    suspend fun day(day: String): List<NoteEntryDto>
    suspend fun history(cursor: String?): NotesHistoryDto
    suspend fun edit(id: String, text: String): NoteEntryDto
    suspend fun delete(id: String)
    suspend fun undo(seq: Long)
}

private class SessionNotesHistoryGateway(private val session: SessionManager) : NotesHistoryGateway {
    override suspend fun day(day: String) = session.requireSession().notes.day(day).entries
    override suspend fun history(cursor: String?) = session.requireSession().notes.history(cursor)
    override suspend fun edit(id: String, text: String) = session.requireSession().notes.edit(id, text)
    override suspend fun delete(id: String) = session.requireSession().notes.delete(id)
    override suspend fun undo(seq: Long) { session.requireSession().tasks.undo(seq) }
}

data class NotesHistoryState(
    val entries: List<NoteEntryDto> = emptyList(),
    val loading: Boolean = true,
    val paging: Boolean = false,
    val cursor: String? = null,
    val error: Throwable? = null,
    val actionError: String? = null,
    val selectedId: String? = null,
    val busy: Boolean = false,
    val undone: Set<Long> = emptySet(),
) {
    val selected get() = entries.firstOrNull { it.id == selectedId }
}

/** Cursor history with serialized mutations and generation-guarded reads. */
@HiltViewModel
class NotesHistoryViewModel internal constructor(private val gateway: NotesHistoryGateway) : ViewModel() {
    @Inject constructor(session: SessionManager) : this(SessionNotesHistoryGateway(session))
    private val mutableState = MutableStateFlow(NotesHistoryState())
    val state = mutableState.asStateFlow()
    private var generation = 0L

    init { refresh() }

    /** Re-entering history after capture must discover notes absent from the loaded rows. */
    fun onVisible() = refresh(keepLoaded = true)

    fun select(id: String?) {
        mutableState.update { it.copy(selectedId = id, actionError = null) }
        if (state.value.busy) return
        val note = state.value.selected ?: return
        val stamp = generation
        viewModelScope.launch {
            try {
                val entries = gateway.day(note.day).associateBy { it.id }
                if (stamp != generation) return@launch
                mutableState.update { current -> current.copy(entries = current.entries.mapNotNull { entry ->
                    if (entry.day == note.day) entries[entry.id] else entry
                }) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (error: Throwable) {
                if (stamp == generation) mutableState.update { it.copy(actionError = classifyGatewayError(error)) }
            }
        }
    }

    fun refresh(quietly: Boolean = false, keepLoaded: Boolean = false) {
        val current = state.value
        if (current.busy || (quietly && (current.loading || current.paging || current.entries.none {
            noteNeedsRefresh(it)
        }))) return
        val stamp = ++generation
        mutableState.update { it.copy(loading = !quietly && it.entries.isEmpty(), error = null) }
        viewModelScope.launch {
            try {
                if (quietly) {
                    val pendingDays = state.value.entries.filter { note ->
                        noteNeedsRefresh(note)
                    }.map { it.day }.distinct()
                    val incoming = pendingDays.flatMap { gateway.day(it) }.associateBy { it.id }
                    if (stamp != generation) return@launch
                    mutableState.update { current -> current.copy(entries = current.entries.mapNotNull { note ->
                        if (note.day in pendingDays) incoming[note.id] else note
                    }, loading = false, paging = false) }
                } else {
                    val page = gateway.history(null)
                    if (stamp != generation) return@launch
                    mutableState.update {
                        val entries = if (keepLoaded) {
                            mergeHistoryEntries(page.entries, it.entries)
                        } else page.entries
                        it.copy(entries = entries, cursor = page.pageInfo.nextCursor,
                            loading = false, paging = false, error = null)
                    }
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (error: Throwable) {
                if (stamp == generation) mutableState.update { it.copy(loading = false, paging = false, error = error) }
            }
        }
    }

    fun loadMore() {
        val current = state.value
        val cursor = current.cursor ?: return
        if (current.paging || current.loading || current.busy) return
        val stamp = generation
        mutableState.update { it.copy(paging = true, error = null) }
        viewModelScope.launch {
            try {
                val page = gateway.history(cursor)
                if (stamp != generation) return@launch
                mutableState.update { it.copy(entries = mergeHistoryEntries(page.entries, it.entries),
                    cursor = page.pageInfo.nextCursor, paging = false) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (error: Throwable) {
                if (stamp == generation) mutableState.update { it.copy(paging = false, error = error) }
            }
        }
    }

    fun edit(text: String) {
        val note = state.value.selected ?: return
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.length > 8192) {
            mutableState.update { it.copy(actionError = "Use between 1 and 8192 characters.") }
            return
        }
        mutate {
            val edited = try { gateway.edit(note.id, trimmed) } catch (_: GatewayException.NotFound) {
                mutableState.update { it.copy(entries = it.entries.filterNot { entry -> entry.id == note.id }, selectedId = null) }
                return@mutate
            }
            mutableState.update { it.copy(entries = it.entries.map { entry ->
                if (entry.id == note.id) edited else entry
            }) }
        }
    }

    fun delete() {
        val note = state.value.selected ?: return
        mutate {
            try { gateway.delete(note.id) } catch (_: GatewayException.NotFound) { /* Already removed. */ }
            mutableState.update { it.copy(entries = it.entries.filterNot { entry -> entry.id == note.id }, selectedId = null) }
        }
    }

    fun undo(seq: Long) = mutate {
        try { gateway.undo(seq) } catch (error: GatewayException.ServerError) {
            if (error.status == 409) {
                mutableState.update { it.copy(actionError = "A later change to this task has to be undone first.") }
                return@mutate
            }
            throw error
        }
        mutableState.update { it.copy(undone = it.undone + seq) }
    }

    private fun mutate(action: suspend () -> Unit) {
        if (state.value.busy) return
        generation++
        mutableState.update { it.copy(busy = true, paging = false, actionError = null) }
        viewModelScope.launch {
            try { action() }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Throwable) { mutableState.update { it.copy(actionError = classifyGatewayError(error)) } }
            finally { mutableState.update { it.copy(busy = false) } }
        }
    }
}

/** The queue scan can discover a newly received note a few seconds after capture returns. */
internal fun noteNeedsRefresh(note: NoteEntryDto, now: Instant = Instant.now()): Boolean {
    if (note.transcription == "pending" || note.agent?.state in listOf("pending", "running")) return true
    if (note.agent != null) return false
    val received = runCatching { Instant.parse(note.receivedAt ?: note.capturedAt) }.getOrNull() ?: return false
    val age = java.time.Duration.between(received, now).seconds
    return age in 0..60
}

private fun mergeHistoryEntries(fresh: List<NoteEntryDto>, loaded: List<NoteEntryDto>): List<NoteEntryDto> =
    (fresh + loaded).distinctBy { it.id }
        .sortedWith(compareByDescending<NoteEntryDto> { it.capturedAt }.thenBy { it.id })
