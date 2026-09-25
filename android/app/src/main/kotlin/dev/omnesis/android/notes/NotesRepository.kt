// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import android.util.Log
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.dto.CreateNoteBody
import dev.omnesis.android.transport.dto.NoteEntryDto
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The `/notes` client + device identity of the active pairing; null while unpaired. */
data class NotesGateway(val client: NotesClient, val deviceId: String?)

/** Why a capture landed in the offline queue instead of on the gateway. */
enum class QueueReason {
    /** This phone has no pairing yet — syncs after the operator pairs it. */
    UNPAIRED,

    /** Gateway unavailable — syncs once delivery can resume. */
    UNREACHABLE,

    /** Pairing credentials were rejected — syncs after the user pairs this phone again. */
    UNAUTHORIZED,

    /** The gateway answered but does not expose `/notes` (404) — syncs after an upgrade. */
    FEATURE_OFF,
}

/** Result of a capture save: posted straight to the gateway, or queued for a later drain. */
sealed interface CaptureOutcome {
    data class Posted(val entry: NoteEntryDto) : CaptureOutcome
    data class Queued(val reason: QueueReason) : CaptureOutcome
}

/**
 * The single owner of quick-capture note flow: online saves POST `/notes`
 * directly; retryable transport failures — and a 404 from a gateway with the
 * feature off — fall into the durable [PendingNotesStore], drained oldest-first
 * whenever the app starts/foregrounds or right before the next capture save.
 * Queued notes keep their original `capturedAt` and idempotency key.
 *
 * [gateway] resolves the CURRENT session's client on every call (sessions are
 * rebuilt on pair/unpair/url-change), so a long-lived repository never holds a
 * client bound to a stale gateway.
 */
class NotesRepository(
    private val store: PendingNotesStore,
    private val gateway: () -> NotesGateway?,
    private val now: () -> Instant = Instant::now,
) {

    private val drainMutex = Mutex()

    private val _pending = MutableStateFlow<List<PendingNote>>(emptyList())

    /** The queued (not-yet-synced) notes, oldest first, for diagnostics and warning state. */
    val pending: StateFlow<List<PendingNote>> = _pending.asStateFlow()

    /**
     * Save one captured note. Drains any backlog first (best effort — this
     * direct save can still reach the gateway before older queued rows do; the
     * gateway orders entries by their `capturedAt`, not arrival), then posts
     * this note with a fresh idempotency key. Retryable transport failures,
     * including auth trouble and server errors, queue. A missing pairing uses
     * [QueueReason.UNPAIRED]. Auth failures use
     * [QueueReason.UNAUTHORIZED], while connectivity/server failures use
     * [QueueReason.UNREACHABLE]; a 404 from an older gateway without the
     * `/notes` surface queues as [QueueReason.FEATURE_OFF]. Only
     * deterministic per-note rejections (400/413/422) propagate so the caller
     * can explain them — queueing those would wedge the queue on a note the
     * gateway will never accept.
     */
    suspend fun capture(text: String, surface: String): CaptureOutcome {
        val normalizedText = text.trim()
        require(normalizedText.isNotEmpty()) { "Note text must not be empty" }
        require(normalizedText.length <= MAX_TEXT_LENGTH) {
            "Too long — notes are capped at $MAX_TEXT_LENGTH characters. Shorten it and try again."
        }
        val capturedAt = now().toString()
        val noteId = UUID.randomUUID().toString()
        try {
            drain()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Draining the backlog is best effort; the new note still gets its own attempt.
        }
        val g = gateway() ?: run {
            enqueue(noteId, normalizedText, capturedAt, surface, lastFailure = "Not paired with a gateway")
            return CaptureOutcome.Queued(QueueReason.UNPAIRED)
        }
        return try {
            CaptureOutcome.Posted(
                g.client.create(
                    CreateNoteBody(
                        text = normalizedText,
                        id = noteId,
                        capturedAt = capturedAt,
                        surface = surface,
                        deviceId = g.deviceId,
                    ),
                ),
            )
        } catch (error: GatewayException) {
            if (error.isDeterministicNoteRejection()) throw error
            val reason = error.queueReason()
            Log.i(TAG, "Gateway did not accept quick capture; queuing note captured at $capturedAt")
            enqueue(
                noteId,
                normalizedText,
                capturedAt,
                surface,
                lastAttemptAt = now().toString(),
                lastFailure = failureReason(error),
            )
            CaptureOutcome.Queued(reason)
        }
    }

    /**
     * Push every queued note to the gateway, oldest first, deleting each row
     * only after its POST succeeds. The drain is at-least-once (process death
     * between the POST and the delete re-posts the note next time), but
     * retries are duplicate-safe: each row's persisted [PendingNote.noteId]
     * rides as the POST's idempotency key, so a re-post returns the stored
     * entry instead of creating a second one. A retryable failure stops the
     * drain (nothing else will get through either), and so does a 404 —
     * the whole `/notes` surface is off, so hammering every row is pointless;
     * both leave the remainder queued for the next attempt (app
     * start/foreground, or the next capture save). Auth trouble and other
     * retryable transport failures also stop the drain. Deterministic per-note
     * failures (400/413/422) skip just that row and keep draining the rest, so
     * one rejected note can't wedge the queue; the row stays queued and the
     * diagnostic dialog's discard action remains the manual escape.
     * No-op while unpaired.
     */
    suspend fun drain(): Unit = drainMutex.withLock {
        val g = gateway() ?: return
        val queued = store.readAll()
        if (queued.isEmpty()) {
            _pending.value = emptyList()
            return
        }
        var drained = 0
        for (note in queued) {
            try {
                g.client.create(
                    CreateNoteBody(
                        text = note.text,
                        id = note.noteId,
                        capturedAt = note.capturedAt,
                        surface = note.surface,
                        deviceId = g.deviceId,
                    ),
                )
            } catch (error: GatewayException) {
                store.recordRetryFailure(note.id, now().toString(), failureReason(error))
                if (error.isDeterministicNoteRejection()) {
                    Log.i(TAG, "Drain skipping a note the gateway rejected: ${error.message}")
                    continue
                }
                Log.i(TAG, "Drain stopped after $drained/${queued.size} notes: ${failureReason(error)}")
                break
            }
            store.delete(note.id)
            drained++
        }
        if (drained > 0) Log.i(TAG, "Drained $drained queued note(s) to the gateway")
        refreshPendingUnlocked()
    }

    /**
     * Discard a queued (never-synced) note. Serialized with [drain] via the
     * same mutex, so the delete can't race an in-flight drain that already
     * snapshotted the row and would still POST it after the discard.
     */
    suspend fun deletePending(id: Long): Unit = drainMutex.withLock {
        store.delete(id)
        refreshPendingUnlocked()
    }

    /** Reload from disk without racing a drain's delete-and-publish sequence. */
    suspend fun refreshPending(): Unit = drainMutex.withLock {
        refreshPendingUnlocked()
    }

    private suspend fun refreshPendingUnlocked() {
        _pending.value = store.readAll()
    }

    private suspend fun enqueue(
        noteId: String,
        text: String,
        capturedAt: String,
        surface: String,
        lastAttemptAt: String? = null,
        lastFailure: String,
    ) {
        store.insert(noteId, text, capturedAt, surface, lastAttemptAt, lastFailure)
        refreshPending()
    }

    companion object {
        private const val TAG = "Omnesis:notes"

        /** Client-side mirror of the gateway's per-note text cap. */
        const val MAX_TEXT_LENGTH = 8192
    }
}

/** Only these statuses say that retrying this exact note can never succeed. */
private fun GatewayException.isDeterministicNoteRejection(): Boolean =
    this is GatewayException.ServerError && (status == 400 || status == 413 || status == 422)

private fun GatewayException.queueReason(): QueueReason =
    when (this) {
        is GatewayException.NotFound -> QueueReason.FEATURE_OFF
        is GatewayException.Unauthorized, is GatewayException.Forbidden -> QueueReason.UNAUTHORIZED
        else -> QueueReason.UNREACHABLE
    }

/** Stable, sanitized diagnostic copy: never persist response bodies, URLs, or exception detail. */
private fun failureReason(error: GatewayException): String = when (error) {
    is GatewayException.Network -> "Gateway unreachable"
    is GatewayException.NotFound -> "This gateway version does not support Tell Omnesis"
    is GatewayException.Unauthorized -> "Gateway authorization failed"
    is GatewayException.Forbidden -> "Gateway denied this device"
    is GatewayException.ServerError -> "Gateway returned HTTP ${error.status}"
    is GatewayException.InvalidResponse -> "Gateway returned an invalid response"
    is GatewayException.Decoding -> "Gateway response could not be read"
}
