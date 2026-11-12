// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days

/**
 * Everything the watch and the phone send each other. Each message is a JSON
 * object whose `kind` names its type; field names follow the iOS watch relay
 * (`SiriAskWire`, `WatchNoteWire`, `WatchVoiceRecording`, `WatchDictationGate`)
 * wherever the concept is the same.
 *
 * Fields hold what arrived, unchecked: a peer may be older, newer or wrong.
 * Each type exposes the validated reading its receiver acts on.
 */
@Serializable
sealed interface WearMessage

/** A message the watch keeps in its outbox until the phone confirms it, identified by [ref]. */
@Serializable
sealed interface OutboxContent : WearMessage {
    val ref: String
}

/**
 * Watch → phone: a question. [ref] correlates it with its progress and its
 * result, so a message from an earlier question cannot resolve this one.
 */
@Serializable
@SerialName("ask")
data class AskRequest(
    val question: String,
    val ref: String,
    /** The conversation this question follows up, when it follows an answer on screen. */
    val conversationId: String? = null,
) : WearMessage {
    /** The question to ask, or null when there is nothing to ask. */
    val trimmedQuestion: String? get() = question.trim().ifEmpty { null }

    /** The conversation to resume, when [conversationId] is a usable id. */
    val resumedConversationId: String? get() = conversationId.usableConversationId()
}

/**
 * Phone → watch, mid-turn: the step the agent is on. Sent without a reply; a
 * missed one only leaves the previous step on screen.
 */
@Serializable
@SerialName("progress")
data class AskProgress(
    val activity: String,
    val detail: String? = null,
    val ref: String? = null,
) : WearMessage {
    /**
     * The snapshot to show, or null when the label is unusable. An over-long
     * detail costs only the detail: the step is still worth showing.
     */
    val snapshot: AskActivitySnapshot?
        get() {
            if (activity.isEmpty() || activity.length > MAX_LABEL_LENGTH) return null
            return AskActivitySnapshot(
                label = activity,
                detail = detail?.takeIf { it.isNotEmpty() && it.length <= MAX_DETAIL_LENGTH },
            )
        }

    companion object {
        // Looser than what fits on screen: past these a packet is corrupt.
        private const val MAX_LABEL_LENGTH = 40
        private const val MAX_DETAIL_LENGTH = 20

        fun of(snapshot: AskActivitySnapshot, ref: String?): AskProgress =
            AskProgress(snapshot.label, snapshot.detail?.takeIf { it.isNotEmpty() }, ref)
    }
}

/**
 * Phone → watch: how a question ended. It is the reply to an [AskRequest] and
 * is also sent on its own, so whichever arrives first settles the wait.
 */
@Serializable
@SerialName("result")
data class AskResult(
    /** An [AskOutcome.tag]. */
    val outcome: String,
    /** The answer, or a failure's reason. */
    val text: String? = null,
    val ref: String? = null,
    /** The conversation the turn ran in, for a follow-up question. */
    val conversationId: String? = null,
    /** The assistant message holding the answer. */
    val messageId: String? = null,
) : WearMessage {
    fun toOutcome(): AskOutcome = AskOutcome.fromWire(outcome, text)

    companion object {
        fun of(
            outcome: AskOutcome,
            ref: String?,
            conversationId: String? = null,
            messageId: String? = null,
        ): AskResult = AskResult(outcome.tag, outcome.wireText, ref, conversationId, messageId)
    }
}

/**
 * Watch → phone: a note dictated as text. Every copy of one note carries the
 * same [ref], so the phone saves it once however it arrives.
 */
@Serializable
@SerialName("note")
data class TextNote(
    override val ref: String,
    val text: String,
    val capturedAt: String,
    val capturedTimeZoneId: String,
    val capturedUtcOffsetSeconds: Int,
) : OutboxContent {
    /** The note to save, or null when it is blank. */
    val trimmedText: String? get() = text.trim().ifEmpty { null }

    /** When the note was captured, or null when the fields do not describe a real time. */
    val captureTime: NoteCaptureTime?
        get() = NoteCaptureTime.fromWire(capturedAt, capturedTimeZoneId, capturedUtcOffsetSeconds)

    companion object {
        fun of(text: String, captureTime: NoteCaptureTime, ref: String): TextNote = TextNote(
            ref = ref,
            text = text,
            capturedAt = captureTime.isoString,
            capturedTimeZoneId = captureTime.timeZoneId,
            capturedUtcOffsetSeconds = captureTime.utcOffsetSeconds,
        )
    }
}

/** What the phone did with a note. */
enum class NoteOutcome(val tag: String) {
    /** Delivered to the gateway. */
    SAVED("saved"),

    /** In the phone's durable queue; it syncs when the gateway is reachable. */
    QUEUED_ON_PHONE("queuedOnPhone"),

    /** Refused, and nothing was saved. */
    REJECTED("rejected"),

    /** The phone could neither deliver nor queue it. */
    CAPTURE_FAILED("captureFailed"),

    /** Another copy of the same note is already on the phone. */
    REACHED_PHONE("reachedPhone"),

    /** The message could not be read as a note. */
    RELAY_FAILED("relayFailed"),
    ;

    companion object {
        fun fromTag(tag: String): NoteOutcome? = entries.firstOrNull { it.tag == tag }
    }
}

/**
 * Phone → watch: the phone has dealt with a note. Any acknowledgement naming
 * the note's [ref] lets the watch's outbox release it; [outcome] says what
 * the phone did.
 */
@Serializable
@SerialName("noteAck")
data class NoteAck(
    /** A [NoteOutcome.tag]. */
    val outcome: String,
    val ref: String? = null,
) : WearMessage {
    /** What the phone did, or null for an outcome this build does not know. */
    fun toOutcome(): NoteOutcome? = NoteOutcome.fromTag(outcome)

    companion object {
        fun of(outcome: NoteOutcome, ref: String?): NoteAck = NoteAck(outcome.tag, ref)
    }
}

/** What the person chose to do with a recording. */
@Serializable
enum class CaptureRoute {
    @SerialName("ask")
    ASK,

    @SerialName("note")
    NOTE,

    /** The phone decides between a question and a note from what was said. */
    @SerialName("automatic")
    AUTOMATIC,
}

/** Which watch flow made a recording. */
@Serializable
enum class VoiceKind {
    /** The note screen's recorder: always a voice note, with no route. */
    @SerialName("note")
    NOTE,

    /** The unified recorder: carries the route the person chose. */
    @SerialName("capture")
    CAPTURE,
}

/** Watch → phone: what travels with a recording's audio. */
@Serializable
@SerialName("recording")
data class RecordingMetadata(
    val voiceKind: VoiceKind,
    override val ref: String,
    val capturedAt: String,
    val capturedTimeZoneId: String,
    val capturedUtcOffsetSeconds: Int,
    val captureRoute: CaptureRoute? = null,
    val conversationId: String? = null,
    val locale: String? = null,
) : OutboxContent {
    /**
     * The recording these fields describe, or null when they are missing what
     * the phone's pipelines need or contradict each other.
     */
    fun toRecording(): VoiceRecording? {
        val captureTime = NoteCaptureTime.fromWire(capturedAt, capturedTimeZoneId, capturedUtcOffsetSeconds)
        if (ref.isEmpty() || captureTime == null) return null
        // A capture names its route; a voice note has none.
        if ((voiceKind == VoiceKind.CAPTURE) != (captureRoute != null)) return null
        return VoiceRecording(
            ref = ref,
            captureTime = captureTime,
            locale = locale,
            route = captureRoute,
            // Only a question can follow up a conversation.
            conversationId = if (captureRoute == CaptureRoute.ASK) conversationId.usableConversationId() else null,
        )
    }
}

/** A recording made on the watch. The iOS counterpart is `WatchVoiceRecording` in `WatchVoice.swift`. */
data class VoiceRecording(
    /** Identifies the recording across transfers and relaunches; the phone acts on it once. */
    val ref: String,
    val captureTime: NoteCaptureTime,
    /** The watch's locale tag, used to transcribe the recording. */
    val locale: String?,
    /** Null for a voice note from the note screen. */
    val route: CaptureRoute? = null,
    /** The answer being followed up. */
    val conversationId: String? = null,
) {
    fun toMetadata(): RecordingMetadata = RecordingMetadata(
        voiceKind = if (route == null) VoiceKind.NOTE else VoiceKind.CAPTURE,
        ref = ref,
        capturedAt = captureTime.isoString,
        capturedTimeZoneId = captureTime.timeZoneId,
        capturedUtcOffsetSeconds = captureTime.utcOffsetSeconds,
        captureRoute = route,
        conversationId = conversationId,
        locale = locale,
    )
}

/** Phone → watch: the phone owns the recording named by [ref]; the watch may delete its copy. */
@Serializable
@SerialName("recordingReceived")
data class RecordingReceipt(val ref: String) : WearMessage

/**
 * Watch → phone: nothing but a wake-up, sent after a recording or queued
 * relay is put. The phone acts on the DataItem, not on this.
 */
@Serializable
@SerialName("voiceNudge")
data object VoiceNudge : WearMessage

/**
 * Phone → watch: what the recording named by [ref] turned out to be. For an
 * [CaptureRoute.AUTOMATIC] recording this is the phone's decision.
 */
@Serializable
@SerialName("captureRoute")
data class CaptureRouteUpdate(
    val ref: String,
    val route: CaptureRoute,
) : WearMessage

/**
 * Phone → watch: the answer to a recorded question, sent as a request whose
 * reply is a [DisplayedReceipt].
 */
@Serializable
@SerialName("captureAnswer")
data class CaptureAnswer(
    val ref: String,
    /** An [AskOutcome.tag]. */
    val outcome: String,
    val text: String? = null,
    val conversationId: String? = null,
    val messageId: String? = null,
) : WearMessage {
    fun toOutcome(): AskOutcome = AskOutcome.fromWire(outcome, text)

    companion object {
        fun of(
            outcome: AskOutcome,
            ref: String,
            conversationId: String? = null,
            messageId: String? = null,
        ): CaptureAnswer = CaptureAnswer(ref, outcome.tag, outcome.wireText, conversationId, messageId)
    }
}

/**
 * Watch → phone: whether the answer for [ref] was put on a screen the person
 * is looking at. When it was, the phone marks the answer seen; when it was
 * not, the phone posts a notification instead.
 */
@Serializable
@SerialName("displayed")
data class DisplayedReceipt(
    val displayed: Boolean,
    val ref: String? = null,
) : WearMessage

/**
 * Phone → watch, as a DataItem: what the watch may do with a recording. The
 * iOS counterpart is `WatchDictationGate` in `WatchVoice.swift`; the rules
 * that read it are in `DictationGate.kt`.
 */
@Serializable
@SerialName("dictationGate")
data class DictationGate(
    /** The gateway transcribes voice notes, so the note screen records for it. */
    val active: Boolean,
    /** The largest recording the gateway accepts. */
    val maxAudioBytes: Long,
    /** When the phone last read the gateway's status. */
    val updatedAt: EpochMillis,
    /** The gateway can decide between a question and a note itself. */
    val decisionGate: Boolean = false,
    /** The phone can process recordings from the unified recorder. */
    val captureSupported: Boolean = false,
) : WearMessage {
    companion object {
        /** A gate the phone has not refreshed for this long is not trusted. */
        val STALE_AFTER: Duration = 7.days
    }
}

/**
 * Watch → phone, as a DataItem: a question or text note the phone never took
 * live, with what the watch saw before giving up.
 */
@Serializable
@SerialName("queued")
data class QueuedRelay(
    /** The [AskRequest] or [TextNote] exactly as the live relay sent it. */
    val message: WearMessage,
    val queuedAt: EpochMillis,
    /** Live sends made before queueing. */
    val relayAttempts: Int = 0,
    /** The status code of the last failed send, when there was one. */
    val relayLastError: Int? = null,
) : WearMessage

private const val MAX_CONVERSATION_ID_LENGTH = 200

private fun String?.usableConversationId(): String? =
    this?.takeIf { it.isNotEmpty() && it.length <= MAX_CONVERSATION_ID_LENGTH }

/** The one encoding of [WearMessage]: UTF-8 JSON with a `kind` discriminator. */
object WearCodec {
    private val json = Json {
        ignoreUnknownKeys = true
        classDiscriminator = "kind"
    }

    fun encode(message: WearMessage): ByteArray =
        json.encodeToString(WearMessage.serializer(), message).encodeToByteArray()

    /**
     * The message [bytes] hold, or null when they are not one this build can
     * read: not JSON, a `kind` from a newer peer, or a known kind missing a
     * required field. Unknown fields are ignored.
     */
    fun decode(bytes: ByteArray): WearMessage? = try {
        json.decodeFromString(WearMessage.serializer(), bytes.decodeToString())
    } catch (_: SerializationException) {
        null
    }

    /** The watch's on-disk form of one outbox entry. */
    fun encodeOutboxEntry(entry: OutboxEntry): ByteArray =
        json.encodeToString(OutboxEntry.serializer(), entry).encodeToByteArray()

    /** The outbox entry [bytes] hold, or null when they cannot be read as one. */
    fun decodeOutboxEntry(bytes: ByteArray): OutboxEntry? = try {
        json.decodeFromString(OutboxEntry.serializer(), bytes.decodeToString())
    } catch (_: SerializationException) {
        null
    }
}
