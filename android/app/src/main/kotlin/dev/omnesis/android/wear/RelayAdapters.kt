// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.content.Context
import dev.omnesis.android.assistant.VoiceAskDialog
import dev.omnesis.android.assistant.VoiceAskOutcome
import dev.omnesis.android.assistant.VoiceAskRun
import dev.omnesis.android.assistant.VoiceAskRunner
import dev.omnesis.android.notes.CaptureOutcome
import dev.omnesis.android.notes.CaptureZone
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.RelayedCapture
import dev.omnesis.android.notes.VoiceNoteAudio
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.notes.VoiceNoteNotSavedException
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.RecordingFormat
import dev.omnesis.android.wearprotocol.WearCodec
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** [WatchAsker] on the phone's own voice ask, so a watch question is the same turn a spoken phone ask is. */
class RunnerWatchAsker(private val runner: VoiceAskRunner) : WatchAsker {
    override suspend fun ask(question: String, resuming: String?, onActivity: (AskActivityEvent) -> Unit): AskRun =
        runner.runRelayed(question, resuming, onActivity).toWatch()

    override suspend fun handOff(question: String, resuming: String?): AskRun =
        runner.handOff(question, resuming).toWatch()

    override suspend fun capture(question: String, resuming: String?, onActivity: (AskActivityEvent) -> Unit): AskRun =
        runner.runCapture(question, resuming, onActivity).toWatch()

    private fun VoiceAskRun.toWatch() = AskRun(watchOutcome(outcome), conversationId, messageId, notifyLocally)

    companion object {
        /** The phone's outcome in the watch's terms. */
        fun watchOutcome(outcome: VoiceAskOutcome): AskOutcome = when (outcome) {
            is VoiceAskOutcome.Answered -> AskOutcome.Answered(outcome.text)
            is VoiceAskOutcome.Failed -> AskOutcome.Failed(outcome.reason)
            VoiceAskOutcome.EmptyAnswer -> AskOutcome.EmptyAnswer
            VoiceAskOutcome.StillWorking -> AskOutcome.StillWorking
            VoiceAskOutcome.PreviousTurnRunning -> AskOutcome.PreviousTurnRunning
            VoiceAskOutcome.NotPaired -> AskOutcome.NotPaired
            VoiceAskOutcome.Unauthorized -> AskOutcome.Unauthorized
            VoiceAskOutcome.Unreachable -> AskOutcome.Unreachable
            VoiceAskOutcome.SendFailed -> AskOutcome.SendFailed
            // The watch has no outcome for a send that may or may not have landed; the
            // phone's own sentence says what to do about it.
            VoiceAskOutcome.DeliveryUncertain -> AskOutcome.Failed(VoiceAskDialog.text(outcome))
        }
    }
}

/**
 * [WatchNoteSaver] on the phone's note pipeline, so a watch note is delivered,
 * queued offline and retried exactly as one captured on the phone.
 */
class RepositoryWatchNoteSaver(
    private val notes: NotesRepository,
    private val files: VoiceNoteFiles,
) : WatchNoteSaver {
    override suspend fun save(
        text: String,
        captureTime: NoteCaptureTime,
        ref: String,
        audio: File?,
        locale: String?,
    ): NoteOutcome {
        val relayed = RelayedCapture(
            noteId = RecordingInbox.canonicalRef(ref) ?: UUID.randomUUID().toString(),
            capturedAt = Instant.ofEpochMilli(captureTime.capturedAt),
            zone = CaptureZone.relayed(captureTime.timeZoneId, captureTime.utcOffsetSeconds),
            language = locale?.takeIf { it.isNotBlank() },
        )
        return try {
            // The note pipeline consumes the audio it is given, on refusal too. It gets a copy,
            // so the recording stays in the inbox until the note is known to be kept.
            val voice = audio?.let { source ->
                withContext(Dispatchers.IO) {
                    val copy = files.newRecording(RecordingFormat.FILE_EXTENSION)
                    try {
                        source.copyTo(copy, overwrite = true)
                    } catch (failure: IOException) {
                        copy.delete()
                        throw failure
                    }
                    VoiceNoteAudio(copy, RecordingFormat.CONTENT_TYPE)
                }
            }
            when (notes.capture(text, CaptureSurface.WATCH, audio = voice, relayed = relayed)) {
                CaptureOutcome.Posted -> NoteOutcome.SAVED
                is CaptureOutcome.Queued -> NoteOutcome.QUEUED_ON_PHONE
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: GatewayException) {
            NoteOutcome.REJECTED
        } catch (_: IllegalArgumentException) {
            NoteOutcome.REJECTED
        } catch (_: VoiceNoteNotSavedException) {
            NoteOutcome.CAPTURE_FAILED
        } catch (_: IOException) {
            NoteOutcome.CAPTURE_FAILED
        }
    }
}

/** [CaptureBackend] on the paired gateway's clients, resolved at each call so a re-pairing is followed. */
class SessionCaptureBackend(private val sessions: SessionManager) : CaptureBackend {
    private fun session() = sessions.session ?: throw IOException("not paired")

    override suspend fun status(): CaptureGatewayStatus {
        val status = session().gateway.status()
        return CaptureGatewayStatus(
            gatewayDictation = status.dictation?.let { it.active && it.maxAudioBytes > 0 } == true,
            completionNotifications = status.watchCapture?.completionNotifications == true,
        )
    }

    override suspend fun transcribe(audio: File, locale: String?): String? =
        session().notes.transcribeCapture(audio, RecordingFormat.CONTENT_TYPE, locale)

    override suspend fun classify(text: String): CaptureRoute =
        when (val route = session().notes.routeCapture(text).route) {
            "ask" -> CaptureRoute.ASK
            "note" -> CaptureRoute.NOTE
            else -> throw IOException("unknown capture route $route")
        }

    override suspend fun markSeen(conversationId: String, messageId: String) {
        session().agent.markConversationSeen(conversationId, viewing = false, messageId = messageId)
    }
}

/** [RelayNotifier] on the app's own notification channels. */
class SystemRelayNotifier(private val push: FcmPushManager) : RelayNotifier {
    override fun post(notice: RelayNotice) {
        push.showLocal(
            tag = notice.slot ?: "watch-relay-${UUID.randomUUID()}",
            title = notice.title,
            body = notice.body,
            conversationId = notice.conversationId,
        )
    }
}

/** [RelayStateStore] in the app's private preferences. */
class PreferencesRelayStateStore(context: Context) : RelayStateStore {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun loadGate(): DictationGate? = preferences.getString(KEY_GATE, null)?.let { stored ->
        runCatching { WearCodec.decode(Base64.getDecoder().decode(stored)) }.getOrNull() as? DictationGate
    }

    override fun saveGate(gate: DictationGate) {
        preferences.edit().putString(KEY_GATE, Base64.getEncoder().encodeToString(WearCodec.encode(gate))).apply()
    }

    override fun loadHandledRefs(): List<String> =
        preferences.getString(KEY_HANDLED_REFS, null)?.split(REF_SEPARATOR)?.filter { it.isNotEmpty() }.orEmpty()

    override fun saveHandledRefs(refs: List<String>) {
        // Committed, not applied: a ref that is not on disk when the process dies lets its queued copy act again.
        preferences.edit()
            .putString(KEY_HANDLED_REFS, refs.filter { REF_SEPARATOR !in it }.joinToString(REF_SEPARATOR))
            .commit()
    }

    override fun watchKnown(): Boolean = preferences.getBoolean(KEY_WATCH_KNOWN, false)

    override fun markWatchKnown() {
        preferences.edit().putBoolean(KEY_WATCH_KNOWN, true).apply()
    }

    private companion object {
        const val PREFERENCES = "omnesis_wear_relay"
        const val KEY_GATE = "published_gate"
        const val KEY_HANDLED_REFS = "handled_refs"
        const val KEY_WATCH_KNOWN = "watch_known"
        const val REF_SEPARATOR = "\n"
    }
}
