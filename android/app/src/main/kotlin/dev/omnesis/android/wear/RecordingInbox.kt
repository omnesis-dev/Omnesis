// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.RecordingFormat
import dev.omnesis.android.wearprotocol.RecordingInboxPolicy
import dev.omnesis.android.wearprotocol.RecordingMetadata
import java.io.File
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Where the phone keeps a watch recording from the moment it owns it until it
 * has been turned into a note or a question.
 *
 * A recording's processing — a transcription, then a save or a whole question —
 * can outlast the process that received it. So each recording is copied here
 * first, beside a small state file holding its metadata and how far it got;
 * one still here when the process ended is picked up by the next, from where
 * it stopped. A ref this phone has finished with leaves a receipt, so a
 * DataItem that arrives again later is not processed twice.
 *
 * Every item has one owner in the process: whoever admitted it, or the scan
 * that claimed it. Only the owner updates or discards it. [directory] must be
 * in storage that is never backed up: it holds the person's voice.
 */
class RecordingInbox(
    private val directory: File,
    private val now: () -> Long,
) {
    /** A recording's metadata and progress, persisted beside its audio. */
    @Serializable
    data class State(
        val metadata: RecordingMetadata,
        /** The watch node the recording came from, where its updates and answer go. */
        val sourceNodeId: String? = null,
        /** Processing runs that started and never finished: a process that died mid-run. */
        val attempts: Int = 0,
        /** What the recording turned out to be, once decided. Never [CaptureRoute.AUTOMATIC]. */
        val route: CaptureRoute? = null,
        /** The question was handed to the gateway; whether it arrived is unknown if the process then ended. */
        val askStarted: Boolean = false,
        /** The person has been told this recording is delayed. */
        val failureNotified: Boolean = false,
        /** The transcript, once there is one, so a later run does not transcribe again. */
        val transcript: String? = null,
    )

    /**
     * One recording held in the inbox, owned by whoever holds this. [key] is its
     * ref in canonical form ([canonicalRef]); the ref as the watch wrote it stays
     * in the metadata, for what is sent back.
     */
    class Item(val key: String, var state: State)

    sealed interface Admission {
        /** The caller owns the recording, new or left by an earlier process. */
        data class Owned(val item: Item) : Admission

        /** Another owner in this process is already working on it. */
        data object Busy : Admission

        /** The audio could not be copied; the phone does not own the recording. */
        data object Failed : Admission
    }

    private val owned = mutableSetOf<String>()
    private val receipts = File(directory, "receipts")

    fun audioFile(key: String): File = File(directory, "$key.${RecordingFormat.FILE_EXTENSION}")

    private fun stateFile(key: String): File = File(directory, "$key.json")

    /**
     * Takes ownership of the recording [key] names, copying its audio in with
     * [copyAudio] unless an earlier process already did.
     */
    suspend fun admit(
        key: String,
        metadata: RecordingMetadata,
        sourceNodeId: String?,
        copyAudio: suspend (File) -> Boolean,
    ): Admission {
        if (!own(key)) return Admission.Busy
        load(key)?.let { return Admission.Owned(it) }
        val item = Item(key, State(metadata, sourceNodeId))
        val kept = try {
            directory.mkdirs()
            val partial = File(directory, "$key.partial")
            copyAudio(partial) && partial.length() > 0 && partial.renameTo(audioFile(key)) && save(item)
        } catch (failure: Exception) {
            discard(item)
            throw failure
        }
        if (!kept) {
            discard(item)
            return Admission.Failed
        }
        return Admission.Owned(item)
    }

    /**
     * Claims the recordings no owner in this process holds. A state file
     * without its audio, or audio without its state file, is deleted.
     */
    fun claimLeftovers(): List<Item> = keysOnDisk().mapNotNull { key ->
        if (!own(key)) return@mapNotNull null
        load(key) ?: run {
            delete(key)
            null
        }
    }

    /** How many recordings are waiting here, owned or not. */
    fun count(): Int = keysOnDisk().size

    /** Persists an owned item's progress; false when it could not be written. */
    fun save(item: Item): Boolean = try {
        val target = stateFile(item.key)
        val staged = File(directory, "${item.key}.json.tmp")
        staged.writeText(json.encodeToString(State.serializer(), item.state))
        staged.renameTo(target) || run {
            staged.copyTo(target, overwrite = true)
            staged.delete()
            true
        }
    } catch (_: java.io.IOException) {
        false
    }

    /** Deletes an owned item and gives up its ownership. */
    fun discard(item: Item) = delete(item.key)

    /** Leaves a kept recording for a later run. */
    fun release(item: Item) {
        synchronized(owned) { owned.remove(item.key) }
    }

    /** Whether this phone already finished with the recording [key] names. */
    fun wasCompleted(key: String): Boolean = File(receipts, key).isFile

    /** Records that this phone finished with [key], and forgets receipts no copy can outlive. */
    fun complete(key: String) {
        receipts.mkdirs()
        val current = now()
        File(receipts, key).writeText(current.toString())
        receipts.listFiles()?.forEach { receipt ->
            val completedAt = runCatching { receipt.readText().trim().toLong() }.getOrNull()
            if (completedAt == null || RecordingInboxPolicy.receiptIsExpired(completedAt, current)) receipt.delete()
        }
    }

    private fun own(key: String): Boolean = synchronized(owned) { owned.add(key) }

    private fun delete(key: String) {
        audioFile(key).delete()
        stateFile(key).delete()
        File(directory, "$key.partial").delete()
        File(directory, "$key.json.tmp").delete()
        synchronized(owned) { owned.remove(key) }
    }

    private fun load(key: String): Item? {
        if (!audioFile(key).isFile) return null
        val state = try {
            json.decodeFromString(State.serializer(), stateFile(key).readText())
        } catch (_: java.io.IOException) {
            return null
        } catch (_: SerializationException) {
            return null
        }
        return Item(key, state).takeIf { canonicalRef(state.metadata.ref) == key }
    }

    private fun keysOnDisk(): List<String> = directory.listFiles().orEmpty()
        .filter { it.isFile && (it.extension == "json" || it.extension == RecordingFormat.FILE_EXTENSION) }
        .map { it.nameWithoutExtension }
        .distinct()
        .sorted()

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /**
         * [ref] as the inbox keys a recording: a UUID in its lowercase form, or
         * null for anything else. The key names files and is the note's
         * idempotency key, so nothing but a UUID is accepted.
         */
        fun canonicalRef(ref: String): String? {
            if (ref.length != 36) return null
            return try {
                UUID.fromString(ref).toString()
            } catch (_: IllegalArgumentException) {
                null
            }
        }
    }
}
