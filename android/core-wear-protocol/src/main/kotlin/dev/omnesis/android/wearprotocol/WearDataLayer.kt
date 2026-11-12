// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

/** A point in time as milliseconds since the Unix epoch. */
typealias EpochMillis = Long

/**
 * Where everything the watch and the phone exchange lives on the Wearable
 * Data Layer. The watch holds no gateway credential and makes no gateway
 * call: every question, note and recording is relayed through the phone app.
 *
 * Three transports are used, each for what it guarantees:
 *
 * - **Messages** (`MessageClient`) are live and unqueued: they reach a
 *   connected peer now or fail. A request that wants an answer is sent with
 *   `sendRequest`, whose reply bytes are another [WearMessage].
 * - **DataItems** (`DataClient`) are synced by the system whenever the two
 *   devices next connect, and survive either app exiting. They carry the
 *   dictation gate, recordings, and the relays a live message could not
 *   deliver.
 * - **Capabilities** (`CapabilityClient`) tell each side which node runs the
 *   other app.
 *
 * Every payload is one [WearMessage] encoded by [WearCodec].
 */
object WearDataLayer {
    /**
     * Advertised by the phone app. The watch relays to the nearest node with
     * this capability; with none, there is no phone app to relay to.
     */
    const val PHONE_CAPABILITY = "omnesis_phone_relay"

    /** Advertised by the watch app, so the phone can address its updates. */
    const val WATCH_CAPABILITY = "omnesis_watch"

    // Watch → phone messages.

    /** Request carrying an [AskRequest]; the reply is an [AskResult]. */
    const val ASK_PATH = "/omnesis/ask"

    /** Request carrying a [TextNote]; the reply is a [NoteAck]. */
    const val NOTE_PATH = "/omnesis/note"

    /**
     * A [VoiceNudge], sent after a recording or queued relay is put, to start
     * a phone app that a DataItem alone may not start promptly.
     */
    const val VOICE_NUDGE_PATH = "/omnesis/voice-nudge"

    // Phone → watch messages.

    /** An [AskProgress], sent without expecting a reply. */
    const val PROGRESS_PATH = "/omnesis/progress"

    /**
     * An [AskResult], sent without expecting a reply alongside the reply to
     * [ASK_PATH], so a lost reply does not strand the watch.
     */
    const val RESULT_PATH = "/omnesis/result"

    /**
     * A [CaptureRouteUpdate] (no reply expected), or a request carrying a
     * [CaptureAnswer] whose reply is a [DisplayedReceipt].
     */
    const val CAPTURE_UPDATE_PATH = "/omnesis/capture-update"

    /**
     * A [DisplayedReceipt] sent on its own, for a watch that showed an answer
     * it received outside a request (for instance from a queued copy).
     */
    const val DISPLAYED_PATH = "/omnesis/displayed"

    /**
     * A [RecordingReceipt]: the phone owns the recording, and the watch may
     * delete its copy and the DataItem.
     */
    const val RECORDING_RECEIVED_PATH = "/omnesis/recording-received"

    // DataItems.

    /**
     * The phone's [DictationGate], one DataItem with the encoded gate under
     * [PAYLOAD_KEY].
     */
    const val GATE_PATH = "/omnesis/dictation-gate"

    /**
     * Prefix of a recording's DataItem, one per recording at
     * [recordingPath]: the audio as an Asset under [AUDIO_KEY] and its
     * encoded [RecordingMetadata] under [PAYLOAD_KEY]. The same path names
     * the channel when a recording is streamed with `ChannelClient` instead.
     */
    const val RECORDING_PATH_PREFIX = "/omnesis/recording/"

    /**
     * Prefix of a queued relay's DataItem, one per relay at [queuedPath],
     * with the encoded [QueuedRelay] under [PAYLOAD_KEY].
     */
    const val QUEUED_PATH_PREFIX = "/omnesis/queued/"

    /** DataMap key holding an encoded [WearMessage] as a byte array. */
    const val PAYLOAD_KEY = "payload"

    /** DataMap key holding a recording's audio Asset. */
    const val AUDIO_KEY = "audio"

    fun recordingPath(ref: String): String = RECORDING_PATH_PREFIX + ref

    fun queuedPath(ref: String): String = QUEUED_PATH_PREFIX + ref

    /** The ref named by a recording DataItem or channel path, or null for any other path. */
    fun recordingRef(path: String): String? = refAfter(RECORDING_PATH_PREFIX, path)

    /** The ref named by a queued-relay DataItem path, or null for any other path. */
    fun queuedRef(path: String): String? = refAfter(QUEUED_PATH_PREFIX, path)

    private fun refAfter(prefix: String, path: String): String? {
        if (!path.startsWith(prefix)) return null
        val ref = path.substring(prefix.length)
        return ref.takeIf { it.isNotEmpty() && '/' !in it }
    }
}
