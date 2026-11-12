// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureAnswer
import dev.omnesis.android.wearprotocol.CaptureDeferred
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.CaptureRouteUpdate
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.RecordingInboxPolicy
import dev.omnesis.android.wearprotocol.RecordingMetadata
import dev.omnesis.android.wearprotocol.RecordingReceipt
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.VoiceRecording
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Turns a recording made on the watch into a note or an answered question.
 *
 * A recording arrives as a DataItem carrying its audio. The phone first copies
 * the audio into its [RecordingInbox] and tells the watch it owns it; from
 * there the watch is done with it and everything is the phone's to finish:
 *
 * - a note for a gateway that transcribes voice notes is saved with its audio
 *   and no text, for the gateway to transcribe;
 * - anything else is transcribed first, by the gateway when it transcribes and
 *   on this phone otherwise, then, when the person left the choice to the
 *   phone, classified as a question or a note;
 * - a note is saved; a question is asked, its answer offered to the watch, and
 *   a notification posted when the watch did not show it and nothing else will
 *   announce it.
 *
 * A step that fails leaves the recording in the inbox with what it had got to,
 * to be run again later, and the first time tells the person, and a watch
 * that may still be waiting on it to stop. Three things are never
 * retried: a recording a week old is removed with a notice, a note the gateway
 * refuses for good is reported, and a question whose hand-off the process did
 * not survive is reported instead of asked again, since it may have been
 * asked. No transcript goes back to the watch.
 */
class RecordingPipeline(
    private val inbox: RecordingInbox,
    private val gateway: WearGateway,
    private val backend: CaptureBackend,
    private val transcriber: CaptureTranscriber,
    private val notes: WatchNoteSaver,
    private val asker: WatchAsker,
    private val notifier: RelayNotifier,
    private val retry: RetryScheduler,
    private val now: () -> Long,
) {
    /** A step that could not be done now and is worth doing again later. */
    private class Retryable(message: String) : Exception(message)

    /** The gateway refused the note for good; no later run can save it. */
    private class Refused : Exception()

    /** An answer offered to the watch that it has not said it showed, by the watch's ref. */
    private data class OfferedAnswer(val conversationId: String, val messageId: String)

    private val offered = LinkedHashMap<String, OfferedAnswer>()

    /** Takes a recording DataItem: owns its audio, confirms that to the watch, then processes it. */
    suspend fun onItem(item: WearItem) {
        val pathRef = WearDataLayer.recordingRef(item.path) ?: return
        val metadata = item.payload as? RecordingMetadata
        val key = RecordingInbox.canonicalRef(pathRef)
        if (metadata == null || key == null || metadata.toRecording() == null ||
            RecordingInbox.canonicalRef(metadata.ref) != key
        ) {
            // Nothing the phone can ever process: let the watch stop offering it.
            confirm(item.sourceNodeId, pathRef)
            attempt { gateway.deleteItem(item.path, item.sourceNodeId) }
            return
        }
        if (inbox.wasCompleted(key)) {
            confirm(item.sourceNodeId, metadata.ref)
            attempt { gateway.deleteItem(item.path, item.sourceNodeId) }
            return
        }
        val copy = item.audio ?: return
        // A copy that fails by throwing is a copy that failed: the watch still holds the recording.
        val admitted = attempt { inbox.admit(key, metadata, item.sourceNodeId, copy) }
        when (val admission = admitted ?: RecordingInbox.Admission.Failed) {
            // The watch keeps its copy and offers it again.
            RecordingInbox.Admission.Failed -> Unit
            // An earlier delivery of the same item is being processed; the phone owns the audio.
            RecordingInbox.Admission.Busy -> confirm(item.sourceNodeId, metadata.ref)
            // An earlier delivery was processed and kept for retry; this copy has nothing to add.
            RecordingInbox.Admission.Kept -> {
                confirm(item.sourceNodeId, metadata.ref)
                attempt { gateway.deleteItem(item.path, item.sourceNodeId) }
            }
            is RecordingInbox.Admission.Owned -> {
                confirm(item.sourceNodeId, metadata.ref)
                attempt { gateway.deleteItem(item.path, item.sourceNodeId) }
                process(admission.item)
            }
        }
    }

    /**
     * Processes the recordings an earlier process left in the inbox, and with
     * [retryKept] those this process kept after a step failed. The second is
     * for when the failure may have passed: the retry job, a new process, the
     * person asking. Anything else that wakes the relay leaves them be, so a
     * recording that cannot be processed is not transcribed again for every
     * message the watch sends.
     */
    suspend fun resume(retryKept: Boolean) {
        inbox.claimLeftovers(includingKept = retryKept).forEach { process(it) }
    }

    /** How many recordings are kept for a later run. */
    fun waiting(): Int = inbox.count()

    /**
     * The watch showed, or did not show, the answer for [receipt]'s ref after
     * the phone stopped waiting to hear. Shown late is still shown.
     */
    suspend fun onDisplayed(receipt: DisplayedReceipt) {
        val ref = receipt.ref ?: return
        val answer = synchronized(offered) { offered.remove(ref) } ?: return
        if (receipt.displayed) attempt { backend.markSeen(answer.conversationId, answer.messageId) }
    }

    private suspend fun process(item: RecordingInbox.Item) {
        val recording = item.state.metadata.toRecording()
        if (recording == null || inbox.wasCompleted(item.key)) {
            inbox.discard(item)
            return
        }
        if (RecordingInboxPolicy.recordingIsExpired(recording.captureTime.capturedAt, now())) {
            finish(item, RelayNotice.captureExpired)
            return
        }
        // The process ended between handing the question to the gateway and hearing how
        // that went. Asking again could ask twice.
        if (item.state.askStarted) {
            finish(item, RelayNotice.askInterrupted)
            return
        }
        // Counts the runs that started and never came back: only a process that died mid-run leaves
        // the count raised, and a recording that keeps doing that is given up.
        val unfinished = item.state.attempts
        if (unfinished >= RecordingInboxPolicy.MAX_ATTEMPTS) {
            finish(item, if (recording.route == null) RelayNotice.voiceNoteFailed else RelayNotice.captureAbandoned)
            return
        }
        try {
            update(item) { it.copy(attempts = unfinished + 1) }
            carryOut(item, recording)
            inbox.complete(item.key)
            inbox.discard(item)
        } catch (cancelled: CancellationException) {
            item.state = item.state.copy(attempts = unfinished)
            inbox.save(item)
            inbox.release(item)
            throw cancelled
        } catch (_: Refused) {
            finish(item, RelayNotice.voiceNoteFailed)
        } catch (_: Exception) {
            val tell = !item.state.failureNotified
            item.state = item.state.copy(attempts = unfinished, failureNotified = true)
            inbox.save(item)
            inbox.release(item)
            if (tell) {
                notifier.post(RelayNotice.captureDelayed)
                // A watch still showing this recording stops waiting for its route or answer.
                if (recording.route != null) deferred(item, recording)
            }
            retry.retryLater()
        }
    }

    private suspend fun carryOut(item: RecordingInbox.Item, recording: VoiceRecording) {
        val audio = inbox.audioFile(item.key)
        val status = backend.status()
        val requested = recording.route
        val tell = requested == null || requested == CaptureRoute.NOTE
        if (tell && status.gatewayDictation) {
            if (requested != null) resolved(item, recording, CaptureRoute.NOTE)
            save("", item, recording, withAudio = true)
            return
        }
        val text = item.state.transcript ?: run {
            val heard = if (status.gatewayDictation) {
                backend.transcribe(audio, recording.locale)
            } else {
                transcriber.transcribe(audio, recording.locale)
            }
            val transcript = heard?.trim().orEmpty().ifEmpty { throw Retryable("no transcript") }
            update(item) { it.copy(transcript = transcript) }
            transcript
        }
        val route = item.state.route ?: run {
            val decided = when (requested) {
                null, CaptureRoute.NOTE -> CaptureRoute.NOTE
                CaptureRoute.ASK -> CaptureRoute.ASK
                CaptureRoute.AUTOMATIC -> backend.classify(text).also {
                    if (it == CaptureRoute.AUTOMATIC) throw Retryable("no route")
                }
            }
            update(item) { it.copy(route = decided) }
            decided
        }
        if (requested != null) resolved(item, recording, route)
        if (route == CaptureRoute.NOTE) {
            save(text, item, recording, withAudio = false)
        } else {
            update(item) { it.copy(askStarted = true) }
            answer(text, item, recording, status)
        }
    }

    private suspend fun save(text: String, item: RecordingInbox.Item, recording: VoiceRecording, withAudio: Boolean) {
        val outcome = notes.save(
            text,
            recording.captureTime,
            item.key,
            audio = inbox.audioFile(item.key).takeIf { withAudio },
            locale = recording.locale.takeIf { withAudio },
        )
        when (outcome) {
            NoteOutcome.SAVED, NoteOutcome.QUEUED_ON_PHONE -> Unit
            NoteOutcome.REJECTED -> throw Refused()
            else -> throw Retryable("note not kept")
        }
    }

    private suspend fun answer(
        question: String,
        item: RecordingInbox.Item,
        recording: VoiceRecording,
        status: CaptureGatewayStatus,
    ) {
        val node = watchNode(item)
        val run = if (status.completionNotifications) {
            AskProgressReporter.reporting(gateway, node, recording.ref) { report ->
                asker.capture(question, recording.conversationId, report)
            }
        } else {
            // A gateway that leaves the announcement to the phone: any outcome the watch
            // does not show is the phone's to notify, and no message is marked seen.
            asker.handOff(question, recording.conversationId).copy(messageId = null, notifyLocally = true)
        }
        val answer = CaptureAnswer.of(run.outcome, recording.ref, run.conversationId, run.messageId)
        val seen = run.conversationId?.let { conversation ->
            run.messageId?.takeIf { run.outcome is AskOutcome.Answered }?.let { OfferedAnswer(conversation, it) }
        }
        if (seen != null) remember(recording.ref, seen)
        val displayed = node != null && offer(node, answer)
        if (displayed && seen != null) {
            synchronized(offered) { offered.remove(recording.ref) }
            attempt { backend.markSeen(seen.conversationId, seen.messageId) }
        }
        if (!displayed && run.notifyLocally) {
            RelayNotice.queuedAsk(run.outcome, run.conversationId)?.let(notifier::post)
        }
    }

    /** Sends the answer as a request and waits briefly to hear whether the watch showed it. */
    private suspend fun offer(node: String, answer: CaptureAnswer): Boolean {
        val reply = withTimeoutOrNull(RelayPatience.DISPLAYED_REPLY_TIMEOUT) {
            attempt { gateway.sendRequest(node, WearDataLayer.CAPTURE_UPDATE_PATH, answer) }
        }
        return (reply as? DisplayedReceipt)?.displayed == true
    }

    /** Tells the watch what the recording turned out to be. Best effort. */
    private suspend fun resolved(item: RecordingInbox.Item, recording: VoiceRecording, route: CaptureRoute) {
        val node = watchNode(item) ?: return
        attempt { gateway.sendMessage(node, WearDataLayer.CAPTURE_UPDATE_PATH, CaptureRouteUpdate(recording.ref, route)) }
    }

    /** Tells the watch the recording is kept to be finished later. Best effort. */
    private suspend fun deferred(item: RecordingInbox.Item, recording: VoiceRecording) {
        val node = watchNode(item) ?: return
        attempt { gateway.sendMessage(node, WearDataLayer.CAPTURE_UPDATE_PATH, CaptureDeferred(recording.ref)) }
    }

    /** The watch the recording came from, or the watch in reach when that was not recorded. */
    private suspend fun watchNode(item: RecordingInbox.Item): String? =
        item.state.sourceNodeId ?: attempt { gateway.watchNodes() }?.firstOrNull()?.id

    private suspend fun confirm(nodeId: String?, ref: String) {
        val node = nodeId ?: attempt { gateway.watchNodes() }?.firstOrNull()?.id ?: return
        attempt { gateway.sendMessage(node, WearDataLayer.RECORDING_RECEIVED_PATH, RecordingReceipt(ref)) }
    }

    /** Ends a recording that will not be processed, telling the person why. */
    private fun finish(item: RecordingInbox.Item, notice: RelayNotice) {
        notifier.post(notice)
        inbox.complete(item.key)
        inbox.discard(item)
    }

    /** Applies [change] to an owned item and persists it; a step that cannot record its progress does not go on. */
    private fun update(item: RecordingInbox.Item, change: (RecordingInbox.State) -> RecordingInbox.State) {
        item.state = change(item.state)
        if (!inbox.save(item)) throw Retryable("progress not saved")
    }

    private fun remember(ref: String, answer: OfferedAnswer) = synchronized(offered) {
        offered[ref] = answer
        while (offered.size > MAX_OFFERED) offered.remove(offered.keys.first())
    }

    private companion object {
        /** Answers remembered for a late display receipt; the oldest is forgotten first. */
        const val MAX_OFFERED = 16
    }
}
