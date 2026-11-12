// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.EpochMillis
import java.io.File
import java.time.ZoneId
import kotlin.time.Duration

// Everything the watch logic needs from the device, as interfaces. The logic
// in this package depends on these and on the shared relay contract only, so
// it runs on a plain JVM with fakes.

/** The device's clock, calendar and locale, and the source of new relay refs. */
interface WatchEnvironment {
    fun now(): EpochMillis

    fun zone(): ZoneId

    /** The locale as a BCP 47 tag, which the phone uses to transcribe a recording. */
    fun localeTag(): String

    /** A ref no other relay from this watch carries. */
    fun newRef(): String
}

/** One-line diagnostics. Lines never carry a question, note or answer. */
interface WatchLog {
    fun info(message: String)

    fun error(message: String)
}

/** The four signals the watch plays on the wrist. */
enum class WatchHaptic {
    /** The microphone opened. */
    START,

    /** Something was kept, or an answer arrived. */
    SUCCESS,

    /** Something could not be done. */
    FAILURE,

    /** The work continues elsewhere, or a result arrived unprompted. */
    NOTIFICATION,
}

fun interface Haptics {
    fun play(haptic: WatchHaptic)
}

/** How one request to the phone ended. */
sealed interface LinkReply {
    /** The phone answered with these bytes. */
    class Reply(val payload: ByteArray) : LinkReply

    /**
     * No connected node runs the phone app. [phoneCannotReceive] says no
     * paired phone has it at all, so neither a retry nor a queued copy can
     * arrive.
     */
    data class Unreachable(val phoneCannotReceive: Boolean, val code: Int? = null) : LinkReply

    /** The Data Layer gave up waiting for the phone's reply. */
    data class TimedOut(val code: Int? = null) : LinkReply

    /** The watch's own Data Layer connection is not usable. */
    data class LinkDown(val code: Int? = null) : LinkReply

    data class Failed(val code: Int? = null) : LinkReply
}

/** One DataItem this watch put, as its path and encoded payload. */
class LinkItem(val path: String, val payload: ByteArray?)

/** The Wearable Data Layer, addressed at the phone app. */
interface PhoneLink {
    /** Whether a connected node runs the phone app. */
    suspend fun phoneReachable(): Boolean

    /** Whether any paired phone has the phone app, connected or not. */
    suspend fun phoneAppInstalled(): Boolean

    /** Send a request to the phone app and wait for its reply. */
    suspend fun request(path: String, payload: ByteArray): LinkReply

    /** Send a message that expects no reply. False when it was not handed over. */
    suspend fun send(path: String, payload: ByteArray): Boolean

    /**
     * Put a DataItem, which the system syncs to the phone whenever the two
     * next connect. [audio] travels as the item's audio Asset. False when the
     * item was not stored.
     */
    suspend fun putItem(path: String, payload: ByteArray, audio: File? = null): Boolean

    suspend fun deleteItem(path: String)

    /** The DataItems under [prefix]. */
    suspend fun items(prefix: String): List<LinkItem>

    /** The gate DataItem the phone last published, or null when there is none to read. */
    suspend fun gate(): DictationGate?
}

/** The microphone, recording into a file in the shared recording format. */
interface AudioRecorder {
    interface Listener {
        /**
         * The recording ended: stopped, or at its time limit. [success] is
         * false when the file is not a usable recording.
         */
        fun onFinished(success: Boolean)

        /** Something else took the microphone. */
        fun onInterrupted()
    }

    /** A recording in progress. */
    interface Session {
        /** End the recording; [Listener.onFinished] follows. */
        fun stop()

        /** End the recording without reporting it. The caller owns the file. */
        fun abandon()

        /** The loudest input since the last call, in decibels relative to full scale. */
        fun powerDb(): Float
    }

    /** Start recording into [file] for at most [limit]. Throws when the microphone cannot be opened. */
    fun start(file: File, limit: Duration, listener: Listener): Session
}

fun interface MicPermission {
    /** Ask for microphone access when it is not granted yet. False when it is refused or cannot be asked for. */
    suspend fun request(): Boolean
}

/** The system voice, speaking one utterance at a time. */
interface SpeechEngine {
    interface Listener {
        /** Speech reached the word ending at UTF-16 offset [end] of utterance [id]. */
        fun onRange(id: Int, end: Int)

        fun onDone(id: Int)

        /** Utterance [id] ended early: stopped, replaced, or it could not be spoken. */
        fun onStopped(id: Int)
    }

    var listener: Listener?

    fun speak(text: String, id: Int)

    fun stop()
}

fun interface ScreenPresence {
    /** Whether the app is on screen and the display is awake, so what it shows is being seen. */
    fun isVisibleAndAwake(): Boolean
}

fun interface RetryScheduler {
    /** Run the outbox again at [at], replacing any earlier schedule; null cancels it. */
    fun schedule(at: EpochMillis?)
}
