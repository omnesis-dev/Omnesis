// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.EpochMillis
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.ZoneId
import kotlin.time.Duration

/** A phone that can be reached, answers as the test scripts it, and holds the DataItems the watch puts. */
class FakeLink : PhoneLink {
    var reachable = true
    var installed = true
    var putsSucceed = true
    var gate: DictationGate? = null

    /** DataItems by path. */
    val items = linkedMapOf<String, ByteArray>()
    val audio = linkedMapOf<String, ByteArray>()
    val deleted = mutableListOf<String>()
    val requests = mutableListOf<Pair<String, WearMessage?>>()
    val sent = mutableListOf<Pair<String, WearMessage?>>()

    /** How the phone answers a request. */
    var respond: suspend (path: String, message: WearMessage?) -> LinkReply = { _, _ -> LinkReply.Failed() }

    override suspend fun phoneReachable(): Boolean = reachable

    override suspend fun phoneAppInstalled(): Boolean = installed

    override suspend fun request(path: String, payload: ByteArray): LinkReply {
        val message = WearCodec.decode(payload)
        requests += path to message
        if (!reachable) return LinkReply.Unreachable(phoneCannotReceive = !installed)
        return respond(path, message)
    }

    override suspend fun send(path: String, payload: ByteArray): Boolean {
        if (!reachable) return false
        sent += path to WearCodec.decode(payload)
        return true
    }

    override suspend fun putItem(path: String, payload: ByteArray, audio: File?): Boolean {
        if (!putsSucceed) return false
        items[path] = payload
        if (audio != null) this.audio[path] = audio.readBytes()
        return true
    }

    override suspend fun deleteItem(path: String) {
        deleted += path
        items.remove(path)
        audio.remove(path)
    }

    override suspend fun items(prefix: String): List<LinkItem> =
        items.filterKeys { it.startsWith(prefix) }.map { LinkItem(it.key, it.value) }

    override suspend fun gate(): DictationGate? = gate

    fun item(path: String): WearMessage? = items[path]?.let(WearCodec::decode)

    fun reply(message: WearMessage): LinkReply = LinkReply.Reply(WearCodec.encode(message))
}

class FakeRecorder : AudioRecorder {
    var failsToOpen = false
    val sessions = mutableListOf<FakeSession>()
    val current: FakeSession get() = sessions.last()

    inner class FakeSession(val file: File, val limit: Duration, val listener: AudioRecorder.Listener) :
        AudioRecorder.Session {
        var open = true
        var power = -30f

        /** Whether stopping yields a usable recording. */
        var stopsCleanly = true

        override fun stop() {
            if (!open) return
            open = false
            listener.onFinished(stopsCleanly)
        }

        override fun abandon() {
            open = false
        }

        override fun powerDb(): Float = power

        /** The recording ran to its time limit. */
        fun reachLimit() = stop()

        fun interrupt() = listener.onInterrupted()
    }

    override fun start(file: File, limit: Duration, listener: AudioRecorder.Listener): AudioRecorder.Session {
        if (failsToOpen) throw IOException("No microphone")
        file.writeBytes(byteArrayOf(1, 2, 3))
        return FakeSession(file, limit, listener).also { sessions += it }
    }
}

class FakeSpeech : SpeechEngine {
    override var listener: SpeechEngine.Listener? = null
    val spoken = mutableListOf<Pair<String, Int>>()
    var stops = 0

    override fun speak(text: String, id: Int) {
        spoken += text to id
    }

    override fun stop() {
        stops += 1
    }
}

class FakePermission : MicPermission {
    var granted = true

    /** When set, a request waits for the test to answer it. */
    var prompt: CompletableDeferred<Boolean>? = null
    var requests = 0

    override suspend fun request(): Boolean {
        requests += 1
        return prompt?.await() ?: granted
    }
}

class FakeLog : WatchLog {
    val lines = mutableListOf<String>()

    override fun info(message: String) {
        lines += message
    }

    override fun error(message: String) {
        lines += message
    }
}

/** A [WatchCore] on fakes and a temporary directory, driven by a test's virtual clock. */
@OptIn(ExperimentalCoroutinesApi::class)
class WatchHarness(val test: TestScope, val storage: File = Files.createTempDirectory("omnesis-wear").toFile()) {
    val link = FakeLink()
    val recorder = FakeRecorder()
    val speech = FakeSpeech()
    val permission = FakePermission()
    val haptics = mutableListOf<WatchHaptic>()
    val log = FakeLog()
    val retries = mutableListOf<EpochMillis?>()
    var onScreen = true
    private var refs = 0

    val environment = object : WatchEnvironment {
        override fun now(): EpochMillis = START + test.testScheduler.currentTime

        override fun zone(): ZoneId = ZoneId.of("Europe/London")

        override fun localeTag(): String = "en-GB"

        override fun newRef(): String = "ref-${++refs}"
    }

    val core = WatchCore(
        WatchDevice(
            link = link,
            recorder = recorder,
            permission = permission,
            speech = speech,
            haptics = { haptics += it },
            screen = { onScreen },
            retry = { retries += it },
            environment = environment,
            log = log,
            storage = storage,
        ),
        test.backgroundScope,
    )

    val effects = mutableListOf<WatchEffect>()

    init {
        test.backgroundScope.launch { core.effects.collect { effects += it } }
        test.runCurrent()
    }

    val now: EpochMillis get() = environment.now()

    /** Run everything that is ready to run now. */
    fun settle() = test.runCurrent()

    /** Let [duration] pass, running what falls due in it. */
    fun pass(duration: Duration) {
        test.advanceTimeBy(duration.inWholeMilliseconds)
        test.runCurrent()
    }

    /** A gate the phone published just now. */
    fun publishGate(
        captureSupported: Boolean = true,
        decisionGate: Boolean = false,
        active: Boolean = false,
        maxAudioBytes: Long = 0,
        updatedAt: EpochMillis = now,
    ) {
        link.gate = DictationGate(
            active = active,
            maxAudioBytes = maxAudioBytes,
            updatedAt = updatedAt,
            decisionGate = decisionGate,
            captureSupported = captureSupported,
        )
    }

    /** Deliver [message] from the phone as a message, or as a request when [isRequest]. */
    fun fromPhone(message: WearMessage, path: String = "/omnesis/test", isRequest: Boolean = false): WearMessage? {
        val reply = core.received(path, WearCodec.encode(message), isRequest)
        settle()
        return reply?.let(WearCodec::decode)
    }

    val capturePhase: CapturePhase get() = core.capture.state.value.phase

    fun cleanUp() {
        storage.deleteRecursively()
    }

    companion object {
        const val START = 1_790_000_000_000L
    }
}
