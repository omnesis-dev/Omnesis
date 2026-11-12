// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.EpochMillis
import dev.omnesis.android.wearprotocol.OutboxEntry
import dev.omnesis.android.wearprotocol.RecordingFormat
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceRecording
import dev.omnesis.android.wearprotocol.WearCodec
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlin.time.Duration.Companion.seconds

/**
 * The watch's durable outbox: each waiting note is `<ref>.json`, recording
 * its content and delivery history, beside its recording, `<ref>.m4a`, when
 * it has one. Both files are flushed to disk before the note counts as sent,
 * so it survives the app ending and is handed over on the next launch.
 */
class OutboxStore(private val directory: File, private val now: () -> EpochMillis) {
    private val lock = Any()
    private val droppedFile = File(directory, DROPPED_FILE)

    /** Where a new recording is written, before it joins the outbox. */
    @Throws(IOException::class)
    fun recordingFile(ref: String): File {
        prepareDirectory()
        return audioFile(ref)
    }

    fun audioFile(ref: String): File = File(directory, "$ref.${RecordingFormat.FILE_EXTENSION}")

    /**
     * Make a finished recording a waiting note. Throws when either file
     * cannot be made durable; the note is then not in the outbox.
     */
    @Throws(IOException::class)
    fun add(recording: VoiceRecording) = synchronized(lock) {
        val audio = audioFile(recording.ref)
        if (!audio.isFile || audio.length() == 0L) throw IOException("The recording has no audio")
        try {
            writeDurably(entryFile(recording.ref), OutboxEntry(recording.toMetadata(), now()))
            flush(audio)
        } catch (error: IOException) {
            entryFile(recording.ref).delete()
            throw error
        }
    }

    /** Make a note dictated as text a waiting note. Throws when it cannot be made durable. */
    @Throws(IOException::class)
    fun add(note: TextNote) = synchronized(lock) {
        prepareDirectory()
        writeDurably(entryFile(note.ref), OutboxEntry(note, now()))
    }

    /**
     * The waiting notes. A recording without its entry, or a recorded note's
     * entry without its recording, is left over from a note that never made
     * it in, and is deleted.
     */
    fun entries(): List<OutboxEntry> = synchronized(lock) {
        val names = directory.list().orEmpty()
        names.filter { it.endsWith(TEMP_SUFFIX) }.forEach { File(directory, it).delete() }
        val refs = names
            .filter { it.endsWith(ENTRY_SUFFIX) || it.endsWith(AUDIO_SUFFIX) }
            .map { it.substringBeforeLast('.') }
            .toSet()
        refs.mapNotNull { ref ->
            val entry = read(ref)
            if (entry != null && entry.ref == ref && (entry.isTextNote || audioFile(ref).isFile)) {
                entry
            } else {
                // A recording still being made has no entry yet.
                val recording = !entryFile(ref).exists() && isRecent(audioFile(ref))
                if (!recording) removeFiles(ref)
                null
            }
        }
    }

    /** The phone confirmed the note: it leaves the outbox. */
    fun remove(ref: String) = synchronized(lock) { removeFiles(ref) }

    /** A delivery failed: count it, for the backoff. */
    fun recordFailure(ref: String) = synchronized(lock) {
        val entry = read(ref) ?: return@synchronized
        try {
            writeDurably(entryFile(ref), entry.failed(now()))
        } catch (_: IOException) {
            // The entry keeps its previous history and is retried sooner.
        }
    }

    /** Drop a note that waited too long, remembering it until the person has been told. */
    fun drop(ref: String) = synchronized(lock) {
        removeFiles(ref)
        writeDropped(droppedCount + 1)
    }

    /** Notes dropped since the person was last told. */
    val droppedCount: Int
        get() = synchronized(lock) {
            try {
                droppedFile.readText().trim().toIntOrNull()?.coerceAtLeast(0) ?: 0
            } catch (_: IOException) {
                0
            }
        }

    fun acknowledgeDropped() = synchronized(lock) { droppedFile.delete() }

    private fun entryFile(ref: String) = File(directory, "$ref$ENTRY_SUFFIX")

    private fun read(ref: String): OutboxEntry? = try {
        WearCodec.decodeOutboxEntry(entryFile(ref).readBytes())
    } catch (_: IOException) {
        null
    }

    private fun removeFiles(ref: String) {
        audioFile(ref).delete()
        entryFile(ref).delete()
    }

    /** Written within the longest recording's span: possibly being recorded. */
    private fun isRecent(file: File): Boolean {
        val modified = file.lastModified()
        return modified > 0 && now() - modified < (RecordingFormat.MAX_DURATION + 60.seconds).inWholeMilliseconds
    }

    private fun writeDropped(count: Int) {
        try {
            prepareDirectory()
            writeDurably(droppedFile, count.toString().encodeToByteArray())
        } catch (_: IOException) {
            // The notice is lost; the note is dropped either way.
        }
    }

    private fun prepareDirectory() {
        if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) {
            throw IOException("Cannot create the outbox directory")
        }
    }

    private fun writeDurably(file: File, entry: OutboxEntry) = writeDurably(file, WearCodec.encodeOutboxEntry(entry))

    /** Write [bytes] beside [file], flush them to disk, then move them into place in one step. */
    private fun writeDurably(file: File, bytes: ByteArray) {
        val temp = File(file.parentFile, file.name + TEMP_SUFFIX)
        FileOutputStream(temp).use { stream ->
            stream.write(bytes)
            stream.fd.sync()
        }
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    private fun flush(file: File) {
        RandomAccessFile(file, "rw").use { it.fd.sync() }
    }

    private companion object {
        const val ENTRY_SUFFIX = ".json"
        const val AUDIO_SUFFIX = ".${RecordingFormat.FILE_EXTENSION}"
        const val TEMP_SUFFIX = ".tmp"
        const val DROPPED_FILE = "dropped-count"
    }
}
