// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wear.FakeAsker
import dev.omnesis.android.wear.FakeBackend
import dev.omnesis.android.wear.FakeNotes
import dev.omnesis.android.wear.FakeNotifier
import dev.omnesis.android.wear.FakeStateStore
import dev.omnesis.android.wear.FakeTranscriber
import dev.omnesis.android.wear.GateKnowledge
import dev.omnesis.android.wear.GatePublisher
import dev.omnesis.android.wear.HandledRefs
import dev.omnesis.android.wear.QueuedRelayHandler
import dev.omnesis.android.wear.RecordingInbox
import dev.omnesis.android.wear.RecordingPipeline
import dev.omnesis.android.wear.RelayGatewayStatus
import dev.omnesis.android.wear.RelayKeepAlive
import dev.omnesis.android.wear.RetryScheduler
import dev.omnesis.android.wear.TextAskRelay
import dev.omnesis.android.wear.TextNoteRelay
import dev.omnesis.android.wear.WearRelay
import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.CaptureState
import dev.omnesis.android.wear.core.TextInputPurpose
import dev.omnesis.android.wear.core.WatchRig
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.EpochMillis
import java.io.File
import java.nio.file.Files
import java.util.UUID
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals

/**
 * The real watch logic and the real phone relay, joined by a
 * [LoopbackDataLayer] and driven by one virtual clock. Only what lies outside
 * the two is faked: the watch's microphone, voice and haptics, and on the
 * phone the gateway calls, the transcriber, the note pipeline and the
 * notifications, each at the port just below the relay's orchestrators.
 *
 * The phone side is a process that can end and start again over the same
 * storage ([restartPhone]), as the system ends and starts the phone app.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal class Loopback(private val test: TestScope) {
    private val directory: File = Files.createTempDirectory("omnesis-loopback").toFile()
    private var skew = 0L

    /** The one clock both devices read. */
    val now: EpochMillis get() = WatchRig.START + skew + test.testScheduler.currentTime

    val layer = LoopbackDataLayer(test.backgroundScope)

    val watch = WatchRig(
        test = test,
        link = layer.watchLink,
        storage = File(directory, "watch"),
        clock = { now },
        // The phone keys a recording by its ref and accepts nothing but a UUID.
        refFor = { UUID(0L, it.toLong()).toString() },
    )

    // What the phone app reaches outside itself, kept across its restarts.
    val asker = FakeAsker()
    val notes = FakeNotes()
    val backend = FakeBackend()
    val transcriber = FakeTranscriber()
    val notifier = FakeNotifier()
    private val state = FakeStateStore()

    /**
     * What the phone knows about its pairing and its gateway, which the
     * watch's gate follows. Paired, with no status read yet, until a test
     * calls [publishGate].
     */
    var knowledge = GateKnowledge(paired = true, status = null)

    /** One run of the phone app's process. */
    inner class PhoneProcess : RelayKeepAlive, RetryScheduler {
        private val scope = CoroutineScope(
            test.backgroundScope.coroutineContext + SupervisorJob(test.backgroundScope.coroutineContext.job),
        )
        private val handled = HandledRefs(state)
        private val textNotes = TextNoteRelay(notes, handled, notifier)

        /** Times the relay asked for kept recordings to be processed again later. */
        var retriesAsked = 0
            private set

        val relay: WearRelay = WearRelay(
            scope = scope,
            gateway = layer.phoneGateway,
            gate = GatePublisher(layer.phoneGateway, state) { now },
            asks = TextAskRelay(layer.phoneGateway, asker, handled),
            notes = textNotes,
            queued = QueuedRelayHandler(layer.phoneGateway, asker, textNotes, handled, notifier) { now },
            recordings = RecordingPipeline(
                RecordingInbox(File(directory, "phone-inbox")) { now },
                layer.phoneGateway, backend, transcriber, notes, asker, notifier, this,
            ) { now },
            state = state,
            keepAlive = this,
            knowledge = { knowledge },
        )

        /** What the app does whenever its process starts: the gate, and what an earlier process left. */
        fun start() {
            scope.launch {
                relay.ensureGateRefresh()
                if (relay.waitingRecordings() > 0) relay.retryRecordings()
                relay.refreshGate()
            }
        }

        /** The hold job the relay asks for starts by picking up whatever is waiting. */
        override fun hold() {
            scope.launch { relay.resumePending() }
        }

        override fun keepGateFresh() = Unit

        override fun retryLater() {
            retriesAsked += 1
        }

        /** The retry job runs: every kept recording is processed again. */
        fun runRetry() {
            scope.launch {
                relay.resumePending()
                relay.retryRecordings()
            }
        }
    }

    var phone = PhoneProcess()
        private set

    init {
        layer.watch = watch.core
        layer.relay = phone.relay
        phone.start()
        watch.core.launched()
        settle()
    }

    /**
     * The phone app's process ends where it stands, with no chance to tidy
     * up, and a new one starts over what the old one had written. Whatever
     * the old process was waiting on is never heard from again.
     */
    fun restartPhone() {
        layer.relay = null
        phone = PhoneProcess()
        layer.relay = phone.relay
        phone.start()
    }

    /** Run everything that is ready to run now. */
    fun settle() = test.runCurrent()

    /** Let [duration] pass on both devices, running what falls due in it. */
    fun pass(duration: Duration = 2.seconds) {
        test.advanceTimeBy(duration.inWholeMilliseconds)
        test.runCurrent()
    }

    /** Move the clock on without running what would have happened meanwhile, as a device left in a drawer. */
    fun sleepThrough(duration: Duration) {
        skew += duration.inWholeMilliseconds
    }

    /** The phone reads its gateway's status and publishes the gate it implies. */
    fun publishGate(
        paired: Boolean = true,
        decisionGate: Boolean = false,
        dictationMaxAudioBytes: Long? = null,
    ) {
        knowledge = GateKnowledge(paired, RelayGatewayStatus(dictationMaxAudioBytes, decisionGate).takeIf { paired })
        test.backgroundScope.launch { phone.relay.refreshGate() }
        pass(1.seconds)
    }

    // The person, on the watch.

    fun typeQuestion(question: String) = watch.core.textEntered(TextInputPurpose.QUESTION, question)

    fun typeNote(note: String) = watch.core.textEntered(TextInputPurpose.NOTE, note)

    /** Open the unified recorder, speak, and press the button for [route]. */
    fun record(route: CaptureRoute, followUp: Boolean = false) {
        watch.core.capture.start(followUp = followUp)
        settle()
        watch.core.capture.send(route)
        settle()
    }

    val asked: AskState get() = watch.core.ask.state.value
    val recorder: CaptureState get() = watch.core.capture.state.value

    /** The refs of everything still waiting in the watch's outbox. */
    fun outbox(): List<String> = watch.core.store.entries().map { it.ref }

    /** The ref the watch gave the [n]th relay it made. */
    fun ref(n: Int): String = UUID(0L, n.toLong()).toString()

    /** Nothing is waiting on either side and the Data Layer holds no item but the gate. */
    fun assertNothingLeft() {
        assertEquals("the watch's outbox", emptyList<String>(), outbox())
        assertEquals("DataItems left on the Data Layer", emptySet<String>(), layer.leftovers())
        assertEquals("recordings in the phone's inbox", 0, phone.relay.waitingRecordings())
    }

    fun cleanUp() {
        directory.deleteRecursively()
    }
}
