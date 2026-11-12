// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.WearMessage
import java.io.File
import java.io.IOException
import java.time.ZoneId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope

/** The watch node every test relays with. */
internal const val WATCH = "watch-node"

/** 2026-03-14T09:30:00Z, the moment the invented captures were made. */
internal const val CAPTURED_AT = 1_773_480_600_000L

internal val CAPTURE_TIME: NoteCaptureTime = NoteCaptureTime.at(CAPTURED_AT, ZoneId.of("Europe/Lisbon"))

/** Something the fake Data Layer was asked to carry. */
internal sealed interface Sent {
    data class Message(val nodeId: String, val path: String, val message: WearMessage) : Sent
    data class Request(val nodeId: String, val path: String, val message: WearMessage) : Sent
    data class Put(val path: String, val message: WearMessage) : Sent
    data class Deleted(val path: String, val nodeId: String?) : Sent
}

/** A Data Layer that records what crossed it and can be told to fail or stay silent. */
internal class FakeWearGateway : WearGateway {
    val sent = mutableListOf<Sent>()
    val stored = mutableListOf<WearItem>()
    var apiAvailable = true
    var failPuts = false
    var failMessages = false
    var watches = listOf(WearNode(WATCH, "Pixel Watch"))
    var connected = listOf(WearNode(WATCH, "Pixel Watch"))

    /** Answers a request, or throws; null leaves the request unanswered until the caller gives up. */
    var reply: (suspend (Sent.Request) -> WearMessage?)? = { null }

    val messages get() = sent.filterIsInstance<Sent.Message>()
    val requests get() = sent.filterIsInstance<Sent.Request>()
    val puts get() = sent.filterIsInstance<Sent.Put>()
    val deletions get() = sent.filterIsInstance<Sent.Deleted>()

    fun messagesOn(path: String): List<WearMessage> = messages.filter { it.path == path }.map { it.message }

    override suspend fun available(): Boolean = apiAvailable

    override suspend fun sendMessage(nodeId: String, path: String, message: WearMessage) {
        if (failMessages) throw IOException("watch out of reach")
        sent += Sent.Message(nodeId, path, message)
    }

    override suspend fun sendRequest(nodeId: String, path: String, message: WearMessage): WearMessage? {
        val request = Sent.Request(nodeId, path, message)
        sent += request
        val answer = reply ?: return CompletableDeferred<WearMessage?>().await()
        return answer(request)
    }

    override suspend fun putItem(path: String, message: WearMessage) {
        if (failPuts) throw IOException("data layer unavailable")
        sent += Sent.Put(path, message)
    }

    override suspend fun deleteItem(path: String, sourceNodeId: String?) {
        sent += Sent.Deleted(path, sourceNodeId)
        stored.removeAll { it.path == path }
    }

    override suspend fun items(pathPrefix: String): List<WearItem> = stored.filter { it.path.startsWith(pathPrefix) }

    override suspend fun watchNodes(): List<WearNode> = watches

    override suspend fun connectedNodes(): List<WearNode> = connected
}

internal class FakeStateStore : RelayStateStore {
    var gate: DictationGate? = null
    var refs: List<String> = emptyList()
    var known = false

    override fun loadGate(): DictationGate? = gate
    override fun saveGate(gate: DictationGate) {
        this.gate = gate
    }
    override fun loadHandledRefs(): List<String> = refs
    override fun saveHandledRefs(refs: List<String>) {
        this.refs = refs
    }
    override fun watchKnown(): Boolean = known
    override fun markWatchKnown() {
        known = true
    }
}

/** One call the fake asker took. */
internal data class Asked(val mode: String, val question: String, val resuming: String?)

/**
 * Answers every question with [run], reporting [activity] first. [gate] holds an ask open
 * until completed, and [failure] ends it by throwing.
 */
internal class FakeAsker(
    var run: AskRun = AskRun(AskOutcome.Answered("Tuesday at ten"), "conversation-1", "message-1"),
) : WatchAsker {
    val asked = mutableListOf<Asked>()
    var activity: List<AskActivityEvent> = emptyList()
    var gate: CompletableDeferred<Unit>? = null
    var failure: Exception? = null

    override suspend fun ask(question: String, resuming: String?, onActivity: (AskActivityEvent) -> Unit): AskRun =
        take("ask", question, resuming, onActivity)

    override suspend fun handOff(question: String, resuming: String?): AskRun = take("handOff", question, resuming) {}

    override suspend fun capture(question: String, resuming: String?, onActivity: (AskActivityEvent) -> Unit): AskRun =
        take("capture", question, resuming, onActivity)

    private suspend fun take(
        mode: String,
        question: String,
        resuming: String?,
        onActivity: (AskActivityEvent) -> Unit,
    ): AskRun {
        asked += Asked(mode, question, resuming)
        activity.forEach(onActivity)
        gate?.await()
        failure?.let { throw it }
        return run
    }
}

/** One note the fake pipeline was handed. */
internal data class SavedNote(val text: String, val captureTime: NoteCaptureTime, val ref: String, val audio: ByteArray?)

internal class FakeNotes(var outcome: NoteOutcome = NoteOutcome.SAVED) : WatchNoteSaver {
    val saved = mutableListOf<SavedNote>()

    override suspend fun save(text: String, captureTime: NoteCaptureTime, ref: String, audio: File?): NoteOutcome {
        saved += SavedNote(text, captureTime, ref, audio?.readBytes())
        return outcome
    }
}

internal class FakeBackend(
    var gatewayDictation: Boolean = false,
    var completionNotifications: Boolean = true,
) : CaptureBackend {
    var statusFailure: Exception? = null
    var transcript: String? = "When is the budget review"
    var transcribeFailure: Exception? = null
    var route: CaptureRoute = CaptureRoute.ASK
    var classifyFailure: Exception? = null
    val transcribed = mutableListOf<String?>()
    val classified = mutableListOf<String>()
    val seen = mutableListOf<Pair<String, String>>()

    override suspend fun status(): CaptureGatewayStatus {
        statusFailure?.let { throw it }
        return CaptureGatewayStatus(gatewayDictation, completionNotifications)
    }

    override suspend fun transcribe(audio: File, locale: String?): String? {
        transcribed += locale
        transcribeFailure?.let { throw it }
        return transcript
    }

    override suspend fun classify(text: String): CaptureRoute {
        classified += text
        classifyFailure?.let { throw it }
        return route
    }

    override suspend fun markSeen(conversationId: String, messageId: String) {
        seen += conversationId to messageId
    }
}

internal class FakeTranscriber(var transcript: String? = "Remember the blue folder") : CaptureTranscriber {
    val heard = mutableListOf<String?>()

    override suspend fun transcribe(audio: File, locale: String?): String? {
        heard += locale
        return transcript
    }
}

internal class FakeNotifier : RelayNotifier {
    val posted = mutableListOf<RelayNotice>()

    override fun post(notice: RelayNotice) {
        posted += notice
    }
}

internal class FakeScheduler : RelayKeepAlive, RetryScheduler {
    var holds = 0
    var retries = 0
    var gateRefreshes = 0

    override fun hold() {
        holds++
    }
    override fun keepGateFresh() {
        gateRefreshes++
    }
    override fun retryLater() {
        retries++
    }
}

/** A whole relay over fakes, on [scope] and an inbox under [directory]. */
internal class RelayHarness(scope: CoroutineScope, directory: File) {
    val gateway = FakeWearGateway()
    val asker = FakeAsker()
    val notes = FakeNotes()
    val backend = FakeBackend()
    val notifier = FakeNotifier()
    val scheduler = FakeScheduler()
    val store = FakeStateStore()
    var knowledge = GateKnowledge(paired = true, status = RelayGatewayStatus(4_000_000, decisionGate = true))
    private val clock = { CAPTURED_AT + 5_000 }
    private val handled = HandledRefs(store)

    val relay = WearRelay(
        scope = scope,
        gateway = gateway,
        gate = GatePublisher(gateway, store, clock),
        asks = TextAskRelay(gateway, asker, handled),
        notes = TextNoteRelay(notes, handled),
        queued = QueuedRelayHandler(gateway, asker, notes, handled, notifier, clock),
        recordings = RecordingPipeline(
            RecordingInbox(File(directory, "inbox"), clock),
            gateway, backend, FakeTranscriber(), notes, asker, notifier, scheduler, clock,
        ),
        state = store,
        keepAlive = scheduler,
        knowledge = { knowledge },
    )
}
