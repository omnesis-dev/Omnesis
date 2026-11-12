// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import android.util.Log
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.dto.CreateNoteBody
import dev.omnesis.android.transport.dto.VoiceNoteBody
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
    data object Posted : CaptureOutcome
    data class Queued(val reason: QueueReason) : CaptureOutcome
}

/** How a drain of the offline queue ended, for whoever decides whether to try again unprompted. */
enum class DrainOutcome {
    /**
     * Nothing is left that another attempt could deliver on its own: the queue is empty,
     * or what remains waits on the user — pairing, pairing again, a gateway upgrade, or a
     * note the gateway rejected.
     */
    SETTLED,

    /** The gateway could not be reached or failed transiently; the remainder is worth retrying. */
    RETRY_LATER,
}

/**
 * A capture made on another device and relayed to this phone. It keeps the moment it
 * was captured there, and [noteId] (a UUID) is its idempotency key, so every copy of
 * the relay saves one note.
 */
data class RelayedCapture(
    val noteId: String,
    val capturedAt: Instant,
    /** The zone that device captured in; null when it reported none the gateway would accept. */
    val zone: CaptureZone? = null,
    /** The language tag that device recorded a voice note under; null when it named none. */
    val language: String? = null,
)

/**
 * A voice note with no phone transcript that the gateway would not take with its audio:
 * sending it as text would save an empty note, so nothing was saved.
 */
class VoiceNoteNotSavedException : Exception("Couldn't save your voice note.")

/**
 * The single owner of quick-capture note flow: online saves POST `/notes`
 * directly; retryable transport failures — and a 404 from a gateway with the
 * feature off — fall into the durable [PendingNotesStore], drained oldest-first
 * whenever the app starts/foregrounds, right before the next capture save, and from
 * the background: [requestBackgroundDrain] is called whenever notes are left waiting
 * on nothing but a reachable gateway. Queued notes keep their original `capturedAt`,
 * capture time zone and idempotency key.
 *
 * [gateway] resolves the CURRENT session's client on every call (sessions are
 * rebuilt on pair/unpair/url-change), so a long-lived repository never holds a
 * client bound to a stale gateway.
 *
 * A note captured with [VoiceNoteAudio] goes to `POST /notes/voice` instead, queued
 * with its audio when the gateway cannot be reached. A gateway that cannot transcribe
 * voice notes (404 / 409 / 503 / 413) gets the phone's transcript as a plain note and
 * the audio is deleted; the audio file is deleted too once its note is delivered.
 */
class NotesRepository(
    private val store: PendingNotesStore,
    private val gateway: () -> NotesGateway?,
    private val now: () -> Instant = Instant::now,
    private val audioFiles: VoiceNoteFiles? = null,
    private val language: () -> String = { Locale.getDefault().toLanguageTag() },
    private val timeZone: () -> ZoneId = ZoneId::systemDefault,
    private val requestBackgroundDrain: () -> Unit = {},
) {

    private val drainMutex = Mutex()

    /** Dictation audio written before this repository existed belongs to an earlier process. */
    private val createdAtMs = now().toEpochMilli()

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
     *
     * With [audio], [text] is the phone's transcript and may be empty; see the class
     * notes for delivery. Throws [VoiceNoteNotSavedException] when the gateway refuses
     * the audio and there is no transcript to fall back on.
     *
     * [relayed] replaces the fresh idempotency key, capture time, time zone and voice
     * note language with the ones the note was given where it was captured. This phone's
     * zone and language stand in for the two that device did not report.
     */
    suspend fun capture(
        text: String,
        surface: String,
        audio: VoiceNoteAudio? = null,
        taskId: String? = null,
        relayed: RelayedCapture? = null,
    ): CaptureOutcome {
        val normalizedText = text.trim()
        if (audio == null) require(normalizedText.isNotEmpty()) { "Note text must not be empty" }
        require(normalizedText.length <= MAX_TEXT_LENGTH) {
            "Too long — notes are capped at $MAX_TEXT_LENGTH characters. Shorten it and try again."
        }
        val capturedInstant = relayed?.capturedAt ?: now()
        val capturedAt = capturedInstant.toString()
        val capturedZone = relayed?.zone ?: CaptureZone.at(capturedInstant, timeZone())
        val noteId = relayed?.noteId ?: UUID.randomUUID().toString()
        try {
            drain()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Draining the backlog is best effort; the new note still gets its own attempt.
        }
        val ownedAudio = audio?.let {
            requireNotNull(audioFiles) { "voice notes need an audio folder" }.adopt(it, noteId)
        }
        val noteLanguage = ownedAudio?.let { relayed?.language ?: language() }
        val g = gateway() ?: run {
            enqueue(
                noteId,
                normalizedText,
                capturedAt,
                surface,
                taskId = taskId,
                lastFailure = "Not paired with a gateway",
                audio = ownedAudio,
                language = noteLanguage,
                zone = capturedZone,
            )
            return CaptureOutcome.Queued(QueueReason.UNPAIRED)
        }
        if (ownedAudio != null) {
            try {
                g.client.createVoice(
                    VoiceNoteBody(
                        id = noteId,
                        text = normalizedText,
                        capturedAt = capturedAt,
                        surface = surface,
                        deviceId = g.deviceId,
                        language = noteLanguage,
                        taskId = taskId,
                        capturedTimeZoneId = capturedZone?.id,
                        capturedUtcOffsetSeconds = capturedZone?.utcOffsetSeconds,
                    ),
                    ownedAudio.file,
                    ownedAudio.mimeType,
                )
                ownedAudio.file.delete()
                return CaptureOutcome.Posted
            } catch (error: GatewayException) {
                when {
                    error.refusesVoiceNotes() -> {
                        ownedAudio.file.delete()
                        Log.i(TAG, "Gateway did not take a voice note's audio; saving the phone's transcript")
                        if (normalizedText.isEmpty()) throw VoiceNoteNotSavedException()
                    }
                    error.isDeterministicNoteRejection() -> {
                        ownedAudio.file.delete()
                        throw error
                    }
                    else -> {
                        Log.i(TAG, "Gateway did not accept a voice note; queuing it captured at $capturedAt")
                        enqueue(
                            noteId,
                            normalizedText,
                            capturedAt,
                            surface,
                            taskId = taskId,
                            lastAttemptAt = now().toString(),
                            lastFailure = failureReason(error),
                            audio = ownedAudio,
                            language = noteLanguage,
                            zone = capturedZone,
                        )
                        return queued(error.queueReason())
                    }
                }
            }
        }
        return try {
            g.client.create(
                CreateNoteBody(
                    text = normalizedText,
                    id = noteId,
                    capturedAt = capturedAt,
                    surface = surface,
                    deviceId = g.deviceId,
                    taskId = taskId,
                    capturedTimeZoneId = capturedZone?.id,
                    capturedUtcOffsetSeconds = capturedZone?.utcOffsetSeconds,
                ),
            )
            CaptureOutcome.Posted
        } catch (error: GatewayException) {
            if (error.isDeterministicNoteRejection()) throw error
            val reason = error.queueReason()
            Log.i(TAG, "Gateway did not accept quick capture; queuing note captured at $capturedAt")
            enqueue(
                noteId,
                normalizedText,
                capturedAt,
                surface,
                taskId = taskId,
                lastAttemptAt = now().toString(),
                lastFailure = failureReason(error),
                zone = capturedZone,
            )
            queued(reason)
        }
    }

    /** A note that waits only for the gateway to be reachable is retried without the app open. */
    private fun queued(reason: QueueReason): CaptureOutcome.Queued {
        if (reason == QueueReason.UNREACHABLE) requestBackgroundDrain()
        return CaptureOutcome.Queued(reason)
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
     * start/foreground, the next capture save, or the background drain a
     * [DrainOutcome.RETRY_LATER] asks for). Auth trouble and other
     * retryable transport failures also stop the drain. Deterministic per-note
     * failures (400/413/422) skip just that row and keep draining the rest, so
     * one rejected note can't wedge the queue; the row stays queued and the
     * diagnostic dialog's discard action remains the manual escape.
     * No-op while unpaired.
     *
     * Every caller — foreground, capture, background worker — goes through the one
     * [drainMutex] and reads the queue only once it holds it, so two drains never post
     * the same row concurrently or count one failure twice.
     */
    suspend fun drain(): DrainOutcome {
        val outcome = drainMutex.withLock { drainUnlocked() }
        if (outcome == DrainOutcome.RETRY_LATER) requestBackgroundDrain()
        return outcome
    }

    private suspend fun drainUnlocked(): DrainOutcome {
        sweepOrphanAudioUnlocked()
        val g = gateway() ?: return DrainOutcome.SETTLED
        val queued = store.readAll()
        if (queued.isEmpty()) {
            _pending.value = emptyList()
            return DrainOutcome.SETTLED
        }
        var drained = 0
        var outcome = DrainOutcome.SETTLED
        for (note in queued) {
            try {
                if (!deliverQueued(g, note)) continue
            } catch (error: GatewayException) {
                store.recordRetryFailure(note.id, now().toString(), failureReason(error))
                if (error.isDeterministicNoteRejection()) {
                    Log.i(TAG, "Drain skipping a note the gateway rejected: ${error.message}")
                    continue
                }
                Log.i(TAG, "Drain stopped after $drained/${queued.size} notes: ${failureReason(error)}")
                if (error.queueReason() == QueueReason.UNREACHABLE) outcome = DrainOutcome.RETRY_LATER
                break
            }
            deleteRow(note)
            drained++
        }
        if (drained > 0) Log.i(TAG, "Drained $drained queued note(s) to the gateway")
        refreshPendingUnlocked()
        return outcome
    }

    /**
     * Discard a queued (never-synced) note. Serialized with [drain] via the
     * same mutex, so the delete can't race an in-flight drain that already
     * snapshotted the row and would still POST it after the discard.
     */
    suspend fun deletePending(id: Long): Unit = drainMutex.withLock {
        store.readAll().firstOrNull { it.id == id }?.let { deleteRow(it) }
        refreshPendingUnlocked()
    }

    /**
     * Deletes dictation audio no queued note references, left behind by a process that
     * died mid-recording or mid-delivery. Runs with every drain — at each app start and
     * foreground — and keeps files written since this repository was created, which
     * belong to this process's recordings.
     */
    private suspend fun sweepOrphanAudioUnlocked() {
        val files = audioFiles ?: return
        val referenced = store.readAll().mapNotNull { it.audio?.file?.absolutePath }.toSet()
        withContext(Dispatchers.IO) { files.sweepOrphans(referenced, createdAtMs) }
    }

    /**
     * Delivers one queued note. False when the row must stay queued without stopping the
     * drain: a voice note with no phone transcript whose audio the gateway will not take
     * now, kept with its audio for a gateway that can transcribe it later.
     */
    private suspend fun deliverQueued(g: NotesGateway, note: PendingNote): Boolean {
        val audio = note.audio?.takeIf { it.file.exists() }
        if (audio != null) {
            try {
                g.client.createVoice(
                    VoiceNoteBody(
                        id = note.noteId,
                        text = note.text,
                        capturedAt = note.capturedAt,
                        surface = note.surface,
                        deviceId = g.deviceId,
                        language = note.language,
                        taskId = note.taskId,
                        capturedTimeZoneId = note.zone?.id,
                        capturedUtcOffsetSeconds = note.zone?.utcOffsetSeconds,
                    ),
                    audio.file,
                    audio.mimeType,
                )
                return true
            } catch (error: GatewayException) {
                if (!error.refusesVoiceNotes()) throw error
                if (note.text.isBlank()) {
                    store.recordRetryFailure(note.id, now().toString(), "Gateway can't transcribe voice notes")
                    return false
                }
                audio.file.delete()
                store.dropAudio(note.id)
            }
        }
        // Audio and transcript both gone: there is nothing left to deliver.
        if (note.text.isBlank()) return true
        g.client.create(
            CreateNoteBody(
                text = note.text,
                id = note.noteId,
                capturedAt = note.capturedAt,
                surface = note.surface,
                deviceId = g.deviceId,
                taskId = note.taskId,
                capturedTimeZoneId = note.zone?.id,
                capturedUtcOffsetSeconds = note.zone?.utcOffsetSeconds,
            ),
        )
        return true
    }

    private suspend fun deleteRow(note: PendingNote) {
        store.delete(note.id)
        note.audio?.file?.let { withContext(Dispatchers.IO) { it.delete() } }
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
        audio: VoiceNoteAudio? = null,
        language: String? = null,
        taskId: String? = null,
        zone: CaptureZone? = null,
    ) {
        store.insert(noteId, text, capturedAt, surface, lastAttemptAt, lastFailure, audio, language, taskId, zone)
        refreshPending()
    }

    companion object {
        private const val TAG = "Omnesis:notes"

        /** Client-side mirror of the gateway's per-note text cap. */
        const val MAX_TEXT_LENGTH = 8192
    }
}

/**
 * The gateway will not transcribe voice notes — too old (404),
 * dictation switched off (409), no runnable transcriber (503) — or not this audio (413).
 * The note itself is still fine as text.
 */
private fun GatewayException.refusesVoiceNotes(): Boolean =
    this is GatewayException.NotFound ||
        (this is GatewayException.ServerError && (status == 409 || status == 503 || status == 413))

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
