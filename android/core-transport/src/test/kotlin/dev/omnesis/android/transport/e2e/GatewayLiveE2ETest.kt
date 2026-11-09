// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.e2e

import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.GatewayClient
import dev.omnesis.android.transport.client.SearchClient
import dev.omnesis.android.transport.client.TaskAction
import dev.omnesis.android.transport.client.TaskView
import dev.omnesis.android.transport.client.TasksClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.TaskMutationDto
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.tls.PinnedOkHttp
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.transport.ws.DeviceSocketReconnectLimits
import dev.omnesis.android.transport.ws.NetworkPathSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.time.LocalDate
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Live-gateway E2E — the Android port of `GatewayLiveE2ETests.swift`. Runs the REAL
 * transport clients against a spawned synthetic gateway over HTTPS with the REAL
 * [LeafCertPinner] pinned to the gateway's self-signed leaf fingerprint.
 *
 * Boot the gateway and run via `scripts/run-android-e2e.sh`. Without the config file
 * (normal `./gradlew test`) every case self-skips, so this never breaks the unit lane.
 */
class GatewayLiveE2ETest {

    @Serializable
    private data class Config(
        val gatewayURL: String,
        val apiToken: String,
        val tlsFingerprint: String? = null,
    )

    private lateinit var http: GatewayHttp
    private lateinit var gateway: GatewayClient
    private lateinit var search: SearchClient
    private lateinit var admin: AdminClient
    private lateinit var agent: AgentClient
    private lateinit var config: Config

    @Before
    fun setUp() {
        // Only runs under scripts/run-android-e2e.sh, which boots a synth gateway and
        // passes -PomnesisE2e. Plain `./gradlew test` skips it (a stale config file
        // must never make it run against an unrelated gateway).
        assumeTrue(
            "live-gateway E2E not enabled — run via scripts/run-android-e2e.sh",
            System.getProperty("omnesis.android.e2e") == "1",
        )
        val file = File(CONFIG_PATH)
        assumeTrue("no live-gateway config at $CONFIG_PATH", file.exists())
        val cfg = OmnesisJson.decodeFromString<Config>(file.readText())
        config = cfg
        http = GatewayHttp(PinnedOkHttp.build(cfg.tlsFingerprint), cfg.gatewayURL, cfg.apiToken)
        gateway = GatewayClient(http)
        search = SearchClient(http)
        admin = AdminClient(http)
        agent = AgentClient(http)
    }

    // --- DeviceSocket lifecycle ---
    //
    // The real socket over real OkHttp and pinned TLS against the live gateway. The outage comes
    // from a loopback forwarder and the path reports are scripted; backoff is far longer than any
    // wait here, so a reconnect proves the wake signal rather than the timer.

    /** A TCP forwarder that can refuse connections and sever the open ones. */
    private class LoopbackForwarder(private val targetHost: String, private val targetPort: Int) {
        private var server: ServerSocket? = null
        private val open = Collections.synchronizedList(mutableListOf<Socket>())
        val accepted = AtomicInteger()

        fun start(port: Int = 0): Int {
            val socket = ServerSocket()
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), port))
            server = socket
            thread(isDaemon = true) {
                while (!socket.isClosed) {
                    val inbound = runCatching { socket.accept() }.getOrNull() ?: break
                    accepted.incrementAndGet()
                    val outbound = Socket(targetHost, targetPort)
                    open += inbound
                    open += outbound
                    pump(inbound, outbound)
                    pump(outbound, inbound)
                }
            }
            return socket.localPort
        }

        fun stop() {
            server?.close()
            synchronized(open) {
                open.forEach { runCatching { it.close() } }
                open.clear()
            }
        }

        private fun pump(from: Socket, to: Socket) = thread(isDaemon = true) {
            runCatching { from.getInputStream().copyTo(AutoFlush(to.getOutputStream()), bufferSize = 8192) }
            runCatching { from.close() }
            runCatching { to.close() }
        }

        private class AutoFlush(private val out: OutputStream) : OutputStream() {
            override fun write(b: Int) = out.write(b)
            override fun write(b: ByteArray, off: Int, len: Int) {
                out.write(b, off, len)
                out.flush()
            }
        }
    }

    private val wifi = NetworkPathSnapshot(true, setOf(NetworkPathSnapshot.Interface.WIFI))
    private val cellular = NetworkPathSnapshot(true, setOf(NetworkPathSnapshot.Interface.CELLULAR))
    private val noNetwork = NetworkPathSnapshot(false)
    private val longBackoff = DeviceSocketReconnectLimits(baseDelayMs = 120_000, maxDelayMs = 120_000)

    /** Mints a device the way `omnesis devices pair` and the app do. */
    private fun pairDeviceToken(): String {
        val client = PinnedOkHttp.build(config.tlsFingerprint)
        fun post(path: String, body: JsonObject, token: String? = null): JsonObject {
            val request = Request.Builder()
                .url(config.gatewayURL.trimEnd('/') + path)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .apply { if (token != null) header("Authorization", "Bearer $token") }
                .build()
            client.newCall(request).execute().use { response ->
                assertTrue("POST $path answered ${response.code}", response.isSuccessful)
                return OmnesisJson.parseToJsonElement(response.body!!.string()).jsonObject
            }
        }
        val code = post(
            "/admin/devices/pair",
            buildJsonObject { put("kind", "android") },
            token = config.apiToken,
        )["pairingCode"]!!.jsonPrimitive.content
        return post(
            "/devices/pair",
            buildJsonObject {
                put("pairingCode", code)
                put(
                    "capabilities",
                    OmnesisJson.encodeToJsonElement(DeviceCapabilities.serializer(), DeviceCapabilities.android(emptyList())),
                )
            },
        )["token"]!!.jsonPrimitive.content
    }

    private fun forwarder(): LoopbackForwarder {
        val target = URI(config.gatewayURL)
        return LoopbackForwarder(target.host, target.port)
    }

    private inner class Live(url: String, token: String, fingerprint: String? = config.tlsFingerprint) {
        val paths = MutableSharedFlow<NetworkPathSnapshot>(extraBufferCapacity = 16)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val socket = DeviceSocket(
            client = PinnedOkHttp.buildStreaming(fingerprint),
            gatewayUrl = url,
            token = token,
            scope = scope,
            pathObserver = { paths },
            limits = longBackoff,
        )

        /** Starts the socket and hands it the first path report once it is listening. */
        suspend fun start(initial: NetworkPathSnapshot) {
            socket.start()
            withTimeout(5_000) { paths.subscriptionCount.first { it > 0 } }
            paths.emit(initial)
        }

        fun close() {
            socket.stop()
            scope.cancel()
        }

        suspend fun awaitState(what: String, predicate: (DeviceSocket.ConnectionState) -> Boolean) =
            try {
                withTimeout(20_000) { socket.state.first(predicate) }
            } catch (timeout: TimeoutCancellationException) {
                throw AssertionError("timed out waiting for $what; state was ${socket.state.value}", timeout)
            }
    }

    private fun DeviceSocket.ConnectionState.isConnected() = this is DeviceSocket.ConnectionState.Connected

    @Test
    fun device_socket_reconnects_when_the_network_returns_during_a_long_backoff() = runBlocking<Unit> {
        val forwarder = forwarder()
        val port = forwarder.start()
        val live = Live("https://127.0.0.1:$port", pairDeviceToken())
        try {
            live.start(wifi)
            live.awaitState("the first connection") { it.isConnected() }

            live.paths.emit(noNetwork)
            forwarder.stop()
            live.awaitState("the drop to be reported as temporary") {
                it is DeviceSocket.ConnectionState.Reconnecting &&
                    it.network == DeviceSocket.NetworkAvailability.UNAVAILABLE && it.lastError != null
            }

            forwarder.start(port)
            live.paths.emit(wifi)
            live.awaitState("the reconnection, well before the 120s backoff") { it.isConnected() }
            assertEquals(2, forwarder.accepted.get())
        } finally {
            live.close()
            forwarder.stop()
        }
    }

    @Test
    fun device_socket_reports_a_refused_connection_as_temporary_with_its_diagnostic() = runBlocking<Unit> {
        val forwarder = forwarder()
        val port = forwarder.start()
        forwarder.stop()
        val live = Live("https://127.0.0.1:$port", pairDeviceToken())
        try {
            live.start(wifi)
            // A refused attempt can fail before the first path arrives, so the state
            // settles on this once both have, in either order.
            val state = live.awaitState("the failed attempt") {
                it is DeviceSocket.ConnectionState.Reconnecting &&
                    it.network == DeviceSocket.NetworkAvailability.AVAILABLE && it.lastError != null
            } as DeviceSocket.ConnectionState.Reconnecting
            assertTrue("the transport's reason stays visible: ${state.lastError}", !state.lastError.isNullOrBlank())

            // A usable-looking path is only a hint: this one wakes a retry that fails too.
            live.paths.emit(cellular)
            delay(1_000)
            assertTrue(live.socket.state.value is DeviceSocket.ConnectionState.Reconnecting)

            forwarder.start(port)
            live.paths.emit(wifi)
            live.awaitState("the reconnection") { it.isConnected() }
        } finally {
            live.close()
            forwarder.stop()
        }
    }

    @Test
    fun device_socket_treats_a_rejected_token_as_authentication_failure() = runBlocking<Unit> {
        val live = Live(config.gatewayURL, "omn_invalid_for_this_test")
        try {
            live.start(wifi)
            val state = live.awaitState("the refusal") { it is DeviceSocket.ConnectionState.Failed }
                as DeviceSocket.ConnectionState.Failed
            assertEquals(DeviceSocket.FailureKind.AUTHENTICATION, state.kind)
        } finally {
            live.close()
        }
    }

    @Test
    fun device_socket_fails_closed_when_the_certificate_does_not_match_the_pin() = runBlocking<Unit> {
        val forwarder = forwarder()
        val port = forwarder.start()
        val live = Live("https://127.0.0.1:$port", pairDeviceToken(), fingerprint = "0".repeat(64))
        try {
            live.start(wifi)
            val state = live.awaitState("the refusal") { it is DeviceSocket.ConnectionState.Failed }
                as DeviceSocket.ConnectionState.Failed
            assertEquals(DeviceSocket.FailureKind.CERTIFICATE, state.kind)

            live.paths.emit(cellular)
            withTimeout(20_000) {
                while (forwarder.accepted.get() < 2) delay(50)
            }
            delay(500)
            val afterRetry = live.socket.state.value
            assertTrue("a retry stays refused, got $afterRetry", afterRetry is DeviceSocket.ConnectionState.Failed)
        } finally {
            live.close()
            forwarder.stop()
        }
    }

    @Test
    fun device_socket_stays_down_after_stop() = runBlocking<Unit> {
        val forwarder = forwarder()
        val port = forwarder.start()
        val live = Live("https://127.0.0.1:$port", pairDeviceToken())
        try {
            live.start(wifi)
            live.awaitState("the first connection") { it.isConnected() }

            live.socket.stop()
            live.paths.emit(cellular)
            live.socket.appDidBecomeActive()
            delay(1_000)
            assertEquals(1, forwarder.accepted.get())
            assertEquals(DeviceSocket.ConnectionState.Disconnected, live.socket.state.value)
        } finally {
            live.close()
            forwarder.stop()
        }
    }

    /** Widgets use these same journal reads and completion command, without model inference. */
    @Test
    fun widget_task_reads_and_completion_round_trip() = runBlocking {
        val day = LocalDate.now().toString()
        val created = http.postJson<JsonObject, TaskMutationDto>("tasks", buildJsonObject {
            put("title", "Sketch a new trail map")
            put("scheduledFor", day)
        })
        val id = requireNotNull(created.task).id
        val tasks = TasksClient(http)
        try {
            val owned = listOf(TaskView.TODAY, TaskView.MONTH, TaskView.FUTURE, TaskView.ANYTIME)
                .flatMap { tasks.view(it, day).tasks }
            assertTrue(owned.any { it.id == id && !it.isResolved })
            tasks.act(id, TaskAction.Complete())
            assertTrue(tasks.detail(id).task.isDone)
            assertTrue(tasks.view(TaskView.TODAY, day).tasks.none { it.id == id && !it.isResolved })
        } finally {
            tasks.act(id, TaskAction.Delete)
        }
    }

    @Test
    fun health_is_reachable_over_pinned_tls() = runBlocking {
        assertTrue("gateway /health should succeed over pinned TLS", gateway.health())
    }

    @Test
    fun status_decodes() = runBlocking {
        val status = gateway.status()
        assertTrue("documents.total should be present", status.documents.total >= 0)
    }

    @Test
    fun whoami_returns_scopes() = runBlocking {
        val who = gateway.whoami()
        assertTrue("bootstrap token should carry scopes", who.scopes.isNotEmpty())
    }

    /**
     * The descriptors decode is the highest-value contract check: the exact iOS
     * analogue once caught a real optional-field decode bug. Every descriptor must
     * carry the fields the generic renderer relies on.
     */
    @Test
    fun source_descriptors_decode() = runBlocking {
        val descriptors = admin.descriptors()
        assertTrue("expected at least one source descriptor", descriptors.isNotEmpty())
        descriptors.forEach {
            assertTrue("descriptor typeId must be non-blank", it.typeId.isNotBlank())
            assertTrue("descriptor name must be non-blank", it.name.isNotBlank())
        }
    }

    /** Phase-2 read surface: every endpoint the Sources screen uses must decode. */
    @Test
    fun sources_index_meta_decode() = runBlocking {
        val sources = admin.sources()
        admin.syncStatus()
        admin.devices()
        admin.sourceMeta()
        gateway.indexStats()
        sources.firstOrNull()?.let { search.recent(it.id) }
        assertTrue("all Phase-2 read endpoints decoded without throwing", true)
    }

    @Test
    fun people_decode() = runBlocking {
        val people = search.people(limit = 50)
        people.firstOrNull()?.let { p ->
            search.person(p.id)
            search.personDocuments(p.id, limit = 5, offset = 0)
        }
        assertTrue("people endpoints decoded without throwing", true)
    }

    /**
     * Phase-4 agent control surface. A synth gateway with no configured LLM backend
     * returns 503 on every agent route — the exact `fatalError` path the UI handles. So
     * each call must EITHER decode cleanly (when the harness is enabled) OR surface a
     * classified [GatewayException.ServerError]; a decode/transport corruption
     * (`GatewayException.Decoding`) is NOT tolerated and fails the test. The full
     * event/tool-result decode contract is covered by the unit-level AgentDtoDecodeTest.
     */
    @Test
    fun agent_control_endpoints_decode() = runBlocking {
        suspend fun tolerateUnavailable(call: suspend () -> Unit) {
            try {
                call()
            } catch (e: GatewayException.ServerError) {
                // agent harness not configured on the synth gateway — acceptable.
            }
        }
        tolerateUnavailable { agent.conversations() } // GET /agent/conversations
        tolerateUnavailable { agent.model() } // GET /agent/model
        tolerateUnavailable {
            val session = agent.createSession()
            assertTrue("created session id should be non-blank", session.sessionId.isNotBlank())
        }
        assertTrue("agent control endpoints wired + classified cleanly", true)
    }

    /** Model assignments decode from `GET /admin/models`. */
    @Test
    fun models_decode() = runBlocking {
        admin.modelOverview() // GET /admin/models → full overview (displays + inference + catalog)
        assertTrue("models read surface decoded without throwing", true)
    }

    @Test
    fun access_grant_choices_decode() = runBlocking {
        val overview = admin.accessOverview()
        assertTrue("access source identities should be non-blank", overview.sources.all { it.id.isNotBlank() })
    }

    @Test
    fun search_and_document_detail_decode() = runBlocking {
        val response = search.search(text = "the", limit = 5, verbose = true)
        // The e2e-minimal universe carries content; if a hit comes back, open it.
        val first = response.results.firstOrNull()
        if (first != null) {
            val doc = search.document(first.documentId)
            assertTrue("document detail id should be non-blank", doc.id.isNotBlank())
            assertTrue("document sourceId should be non-blank", doc.sourceId.isNotBlank())
        }
    }

    private companion object {
        const val CONFIG_PATH = "/tmp/omnesis-android-e2e-config.json"
    }
}
