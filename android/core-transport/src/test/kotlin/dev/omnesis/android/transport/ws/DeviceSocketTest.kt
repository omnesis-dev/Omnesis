// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import dev.omnesis.android.transport.routing.DirectGatewayProbe
import dev.omnesis.android.transport.routing.DirectGatewayProbing
import dev.omnesis.android.transport.routing.GatewayConnectionPath
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.HostedSourceContract
import dev.omnesis.android.transport.SourceMultiDeviceMode
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Device-WS frame contract over a real WebSocket (MockWebServer upgrade): the
 * hello handshake, inbound command frames surfacing on [DeviceSocket.commands]
 * while the mandatory generic ack still goes out, and the outbound
 * `{kind:"event", type, payload}` shape from [DeviceSocket.sendEvent].
 */
class DeviceSocketTest {

    /** Server end of the socket: records inbound frames, exposes the ws to push frames. */
    private class ServerSide {
        val received = LinkedBlockingQueue<String>()
        val closed = CompletableDeferred<Unit>()

        @Volatile
        var ws: WebSocket? = null

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                ws = webSocket
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                received.put(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                closed.complete(Unit)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                closed.complete(Unit)
            }
        }

        fun takeFrame(): JsonObject {
            val raw = received.poll(5, TimeUnit.SECONDS)
                ?: throw AssertionError("no frame from client within 5s")
            return OmnesisJson.parseToJsonElement(raw).jsonObject
        }
    }

    private lateinit var server: MockWebServer
    private lateinit var serverSide: ServerSide
    private lateinit var scope: CoroutineScope

    @Before
    fun setUp() {
        server = MockWebServer()
        serverSide = ServerSide()
        server.enqueue(MockResponse().withWebSocketUpgrade(serverSide.listener))
        server.start()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.shutdown()
    }

    private fun socket(route: DirectGatewayRoute? = null, probe: DirectGatewayProbing = DirectGatewayProbe, expected: String? = null, refresh: (suspend () -> Unit)? = null) = DeviceSocket(
        OkHttpClient(),
        server.url("/").toString(),
        "tok",
        scope,
        directRoute = route,
        directProbe = probe,
        expectedDeviceId = expected,
        refreshHints = refresh,
        capabilities = DeviceCapabilities.android(
            listOf(
                HostedSourceContract("health-connect", SourceMultiDeviceMode.PARTITIONED),
                HostedSourceContract("android-activity-segments", SourceMultiDeviceMode.PARTITIONED),
            ),
            version = "9.8.7",
            pushAppId = "dev.omnesis.android",
        ).withTlsMode("pinned-leaf"),
    )

    /** Drives the hello handshake from the server side until the client is Connected. */
    private suspend fun connect(socket: DeviceSocket) {
        socket.start()
        assertEquals("Bearer tok", server.takeRequest(5, TimeUnit.SECONDS)?.getHeader("Authorization"))
        val hello = serverSide.takeFrame()
        assertEquals("hello", hello["type"]!!.jsonPrimitive.content)
        assertEquals(1, hello["payload"]!!.jsonObject["protocolVersion"]!!.jsonPrimitive.int)
        assertFalse(hello["payload"]!!.jsonObject.containsKey("token"))
        val capabilities = hello["payload"]!!.jsonObject["capabilities"]!!.jsonObject
        assertEquals("android", capabilities["platform"]!!.jsonPrimitive.content)
        // The gateway's version ledger reads this out of every hello.
        assertEquals("9.8.7", capabilities["version"]!!.jsonPrimitive.content)
        assertEquals("dev.omnesis.android", capabilities["pushAppId"]!!.jsonPrimitive.content)
        assertEquals(
            "partitioned",
            capabilities["multiDeviceModes"]!!.jsonObject["health-connect"]!!.jsonPrimitive.content,
        )
        assertEquals(
            "partitioned",
            capabilities["multiDeviceModes"]!!.jsonObject["android-activity-segments"]!!.jsonPrimitive.content,
        )
        assertFalse(capabilities.containsKey("syncLease"))
        // The gateway warns about pinned phones before a certificate renewal from this.
        assertEquals("pinned-leaf", capabilities["tls"]!!.jsonObject["mode"]!!.jsonPrimitive.content)
        val helloId = hello["id"]!!.jsonPrimitive.content
        serverSide.ws!!.send(
            """{"kind":"response","correlationId":"$helloId","ok":true,""" +
                """"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""",
        )
        withTimeout(5_000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected } }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun `actual network socket close reconnects and foreground replaces only the same authenticated control connection`(): Unit = runBlocking {
        val socket = socket(expected = "dev-1")
        connect(socket)
        val second = ServerSide()
        server.enqueue(MockResponse().withWebSocketUpgrade(second.listener))
        serverSide.ws!!.close(1001, "owned gateway restart") // real peer close, rather than an injected callback
        assertEquals("Bearer tok", server.takeRequest(5, TimeUnit.SECONDS)?.getHeader("Authorization"))
        val hello = second.takeFrame()
        second.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        withTimeout(5_000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected } }
        val third = ServerSide()
        server.enqueue(MockResponse().withWebSocketUpgrade(third.listener))
        socket.recoverAfterInterruption()
        assertEquals("Bearer tok", server.takeRequest(5, TimeUnit.SECONDS)?.getHeader("Authorization"))
        val resumedHello = third.takeFrame()
        third.ws!!.send("""{"kind":"response","correlationId":"${resumedHello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        withTimeout(5_000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected } }
        socket.stop()
        socket.recoverAfterInterruption()
        assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
    }

    @Test fun `relay connection periodically checks returning home and stops probing after teardown`() {
        scope.cancel()
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        val route = DirectGatewayRoute.createValidated("https://gateway.example.test", listOf(DirectGatewayCandidate("127.0.0.1", server.port)), true)!!
        route.connected(java.net.InetSocketAddress("127.0.0.1", 9443))
        var probes = 0
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean { probes++; return false }
        }
        val socket = socket(route, probe)
        socket.start()
        scheduler.runCurrent()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        val hello = serverSide.takeFrame()
        serverSide.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        runBlocking { withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected } } }
        scheduler.advanceTimeBy(30_001)
        scheduler.runCurrent()
        assertEquals(1, probes)
        socket.stop()
        scheduler.advanceTimeBy(60_000)
        scheduler.runCurrent()
        assertEquals(1, probes)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun `metadata refresh continues while disconnected and rejected updates do not change authority`() {
        scope.cancel()
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        val route = DirectGatewayRoute.maintained("https://gateway.example.test", emptyList())
        var refreshes = 0
        val socket = socket(route, refresh = { refreshes++; throw javax.net.ssl.SSLHandshakeException("Refused metadata") })
        runBlocking { socket.refreshDirectPath() }
        assertEquals(0, refreshes)
        socket.start()
        scheduler.runCurrent()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        scheduler.advanceTimeBy(30_001)
        scheduler.runCurrent()
        assertEquals(1, refreshes)
        assertTrue(route.endpoints.isEmpty())
        socket.stop()
        scheduler.advanceTimeBy(60_000)
        scheduler.runCurrent()
        assertEquals(1, refreshes)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun `stopping cancels an outstanding metadata refresh and never starts a later promotion`() {
        scope.cancel()
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        val route = DirectGatewayRoute.maintained("https://gateway.example.test", emptyList())
        val gate = CompletableDeferred<Unit>()
        var refreshes = 0
        val socket = socket(route, refresh = { refreshes++; gate.await() })
        socket.start(); scheduler.runCurrent()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        scheduler.advanceTimeBy(30_001); scheduler.runCurrent()
        assertEquals(1, refreshes)
        socket.stop(); scheduler.runCurrent()
        scheduler.advanceTimeBy(60_000); scheduler.runCurrent()
        assertEquals(1, refreshes)
    }

    @Test fun `live metadata refresh runs before considering promotion on the same authenticated socket`() = runBlocking {
        val route = DirectGatewayRoute.maintained("https://gateway.example.test", emptyList())
        var refreshes = 0
        val socket = socket(route, refresh = { refreshes++ })
        connect(socket)
        socket.refreshDirectPath()
        assertEquals(1, refreshes)
        assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
        socket.stop()
    }

    @Test fun `verified better path reconnects only control socket and reauthenticates same device and bearer`() = runBlocking {
        val route = DirectGatewayRoute.createValidated("https://gateway.example.test", listOf(DirectGatewayCandidate("127.0.0.1", server.port)), true)!!
        route.connected(java.net.InetSocketAddress("127.0.0.1", 9443))
        var probes = 0
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean { probes++; return true }
        }
        val socket = socket(route, probe, "dev-1")
        connect(socket)
        assertEquals("relay", serverSide.takeFrame()["payload"]!!.jsonObject["path"]!!.jsonPrimitive.content)
        val second = ServerSide()
        server.enqueue(MockResponse().withWebSocketUpgrade(second.listener))
        socket.promoteDirectPath()
        assertEquals(1, probes)
        assertEquals("Bearer tok", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Authorization"))
        val hello = second.takeFrame()
        route.connected(java.net.InetSocketAddress("127.0.0.1", server.port))
        second.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected && it.connectionPath == GatewayConnectionPath.LOCAL } }
        assertEquals("local", second.takeFrame()["payload"]!!.jsonObject["path"]!!.jsonPrimitive.content)
        socket.promoteDirectPath()
        assertEquals(1, probes)
        socket.stop()
        socket.promoteDirectPath()
        assertEquals(1, probes)
    }

    @Test fun `failed and stale better-path probes cannot close a newer or stopped socket`() = runBlocking {
        val route = DirectGatewayRoute.createValidated("https://gateway.example.test", listOf(DirectGatewayCandidate("127.0.0.1", server.port)), true)!!
        route.connected(java.net.InetSocketAddress("127.0.0.1", 9443))
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Boolean>()
        var probes = 0
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean {
                probes++
                if (probes == 1) return false
                started.complete(Unit)
                return release.await()
            }
        }
        val socket = socket(route, probe)
        socket.promoteDirectPath()
        assertEquals(0, probes)
        connect(socket)
        serverSide.takeFrame() // advisory relay telemetry after authenticated hello
        socket.promoteDirectPath()
        assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
        val late = launch { socket.promoteDirectPath() }
        started.await()
        socket.stop()
        release.complete(true)
        late.join()
        assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
    }

    @Test fun `earlier probe cannot reconnect a new socket with identical connected values`() = runBlocking {
        val route = DirectGatewayRoute.createValidated("https://gateway.example.test", listOf(DirectGatewayCandidate("127.0.0.1", server.port)), true)!!
        route.connected(java.net.InetSocketAddress("127.0.0.1", 9443))
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Boolean>()
        var calls = 0
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean {
                if (++calls > 1) return true
                started.complete(Unit)
                return release.await()
            }
        }
        val socket = socket(route, probe, "dev-1")
        connect(socket)
        serverSide.takeFrame()
        val stale = launch { socket.promoteDirectPath() }
        started.await()
        val second = ServerSide()
        server.enqueue(MockResponse().withWebSocketUpgrade(second.listener))
        socket.promoteDirectPath()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        val hello = second.takeFrame()
        second.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected } }
        second.takeFrame()
        release.complete(true)
        stale.join()
        assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
        assertEquals(2, server.requestCount)
        socket.stop()
    }

    @Test fun `default direct socket stays independent of cloud routing and retains decoded device metadata`() = runBlocking {
        val socket = DeviceSocket(OkHttpClient(), server.url("/").toString(), "tok", scope)
        socket.start()
        assertEquals("Bearer tok", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Authorization"))
        val hello = serverSide.takeFrame()
        serverSide.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        val connected = withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Connected } } as DeviceSocket.ConnectionState.Connected
        assertEquals("dev-1", connected.deviceId)
        assertEquals("Pixel Test", connected.deviceName)
        assertEquals(listOf("read"), connected.scopes)
        assertEquals(DeviceSocket.ConnectionState.Connected("dev-1", "Pixel Test", listOf("read")), connected)
        socket.promoteDirectPath()
        assertEquals(connected, socket.state.value)
        assertTrue(serverSide.received.isEmpty())
        assertNull(socket.dispatchSync)
        socket.stop()
    }

    @Test fun `revoked hello never publishes advisory path or reauthenticates a different device`() = runBlocking {
        val route = DirectGatewayRoute.maintained("https://gateway.example.test", emptyList())
        route.connected(java.net.InetSocketAddress("127.0.0.1", 9443))
        val socket = socket(route, expected = "dev-1")
        socket.start()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        val hello = serverSide.takeFrame()
        serverSide.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":false,"error":{"message":"revoked"}}""")
        val failure = withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Failed } } as DeviceSocket.ConnectionState.Failed
        assertEquals("revoked", failure.message)
        socket.promoteDirectPath()
        assertTrue(serverSide.received.isEmpty())
        socket.stop()
    }

    @Test fun `malformed strict hello identity is refused before connected state or path telemetry`() = runBlocking {
        val socket = socket(expected = "dev-1")
        socket.start()
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        val hello = serverSide.takeFrame()
        serverSide.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":{}}}""")
        val failure = withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Failed } } as DeviceSocket.ConnectionState.Failed
        assertTrue(failure.message.contains("identity"))
        assertTrue(serverSide.received.isEmpty())
        socket.stop()
    }

    @Test fun `mismatching gateway device identity never becomes connected or reports path`() = runBlocking {
        val socket = socket(expected = "a-different-device")
        socket.start()
        server.takeRequest(5, TimeUnit.SECONDS)
        val hello = serverSide.takeFrame()
        serverSide.ws!!.send("""{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"dev-1","deviceName":"Pixel Test","scopes":["read"]}}""")
        withTimeout(5000) { socket.state.first { it is DeviceSocket.ConnectionState.Failed } }
        assertTrue(serverSide.received.isEmpty())
        socket.stop()
    }

    @Test
    fun shared_auth_fixtures_survive_the_real_event_decoder_without_field_loss() = runBlocking {
        val socket = socket()
        val events = Channel<DeviceSocket.WsEvent>(Channel.UNLIMITED)
        val collector = scope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
            socket.events.collect { events.send(it) }
        }
        try {
            connect(socket)
            for (name in listOf("fields", "code", "qr", "redirect", "wait", "widget", "complete")) {
                val file = if (name == "complete") "auth-complete-extras" else "auth-challenge-$name"
                val payload = javaClass.getResourceAsStream("/wire-fixtures/$file.json")!!
                    .bufferedReader().use { OmnesisJson.parseToJsonElement(it.readText()).jsonObject }
                val type = if (name == "complete") "auth.complete" else "auth.challenge"
                serverSide.ws!!.send(buildJsonObject {
                    put("kind", "event")
                    put("type", type)
                    put("payload", payload)
                }.toString())
                val received = withTimeout(5_000) { events.receive() }
                assertEquals(type, received.type)
                assertEquals(payload, received.payload)
            }
        } finally {
            socket.stop()
            collector.cancel()
        }
    }

    @Test
    fun command_frame_surfaces_on_commands_and_acks_a_dispatched_sync() = runBlocking {
        val socket = socket()
        socket.dispatchSync = { it.startsWith("health-connect:") }
        val commands = Channel<DeviceSocket.WsCommand>(Channel.UNLIMITED)
        scope.launch { socket.commands.collect { commands.send(it) } }

        connect(socket)
        serverSide.ws!!.send(
            """{"kind":"command","id":"cmd-1","type":"source.sync",""" +
                """"payload":{"sourceId":"health-connect:local"}}""",
        )

        val cmd = withTimeout(5_000) { commands.receive() }
        assertEquals("cmd-1", cmd.id)
        assertEquals("source.sync", cmd.type)
        assertEquals("health-connect:local", cmd.payload["sourceId"]!!.jsonPrimitive.content)

        // The gateway validates `result` against the source.sync schema, which
        // requires `ok` — an empty object is rejected as a protocol error.
        val ack = serverSide.takeFrame()
        assertEquals("response", ack["kind"]!!.jsonPrimitive.content)
        assertEquals("cmd-1", ack["correlationId"]!!.jsonPrimitive.content)
        assertEquals(true, ack["ok"]!!.jsonPrimitive.booleanOrNull)
        val result = ack["result"]!!.jsonObject
        assertEquals(true, result["ok"]!!.jsonPrimitive.booleanOrNull)
        assertEquals(1, result["triggered"]!!.jsonPrimitive.int)

        socket.stop()
    }

    @Test
    fun sync_for_an_unhosted_source_is_refused_rather_than_falsely_acked() = runBlocking {
        // A blanket `ok: true` would report a completed sync for a source this
        // build cannot touch; the gateway turns this refusal into a 502 the
        // operator can read.
        val socket = socket()
        socket.dispatchSync = { it.startsWith("health-connect:") }

        connect(socket)
        serverSide.ws!!.send(
            """{"kind":"command","id":"cmd-2","type":"source.sync",""" +
                """"payload":{"sourceId":"gmail:someone@example.com"}}""",
        )

        val ack = serverSide.takeFrame()
        assertEquals("cmd-2", ack["correlationId"]!!.jsonPrimitive.content)
        assertEquals(false, ack["ok"]!!.jsonPrimitive.booleanOrNull)
        assertEquals("not_hosted", ack["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)

        socket.stop()
    }

    @Test
    fun sync_is_refused_when_no_feature_takes_it_on() = runBlocking {
        // The acknowledgement has to come from the dispatch, not a list of
        // hosted types: a disabled feature matches the type but starts nothing,
        // and acking that would report a sync the operator never gets.
        val socket = socket()
        socket.dispatchSync = { false }

        connect(socket)
        serverSide.ws!!.send(
            """{"kind":"command","id":"cmd-5","type":"source.sync",""" +
                """"payload":{"sourceId":"health-connect:local"}}""",
        )

        val ack = serverSide.takeFrame()
        assertEquals(false, ack["ok"]!!.jsonPrimitive.booleanOrNull)
        assertEquals("not_hosted", ack["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)

        socket.stop()
    }

    @Test
    fun source_change_commands_ack_with_the_ok_their_schema_requires() = runBlocking {
        // These are the frames whose empty replies produced the recurring
        // "Failed to dispatch source.added" warnings.
        val socket = socket()
        connect(socket)

        for ((i, type) in listOf("source.added", "source.updated", "source.removed", "sources.snapshot").withIndex()) {
            serverSide.ws!!.send("""{"kind":"command","id":"chg-$i","type":"$type","payload":{}}""")
            val ack = serverSide.takeFrame()
            assertEquals("chg-$i", ack["correlationId"]!!.jsonPrimitive.content)
            assertEquals("$type envelope", true, ack["ok"]!!.jsonPrimitive.booleanOrNull)
            assertEquals("$type result", true, ack["result"]!!.jsonObject["ok"]!!.jsonPrimitive.booleanOrNull)
        }

        socket.stop()
    }

    @Test
    fun an_unhandled_command_is_refused_with_a_structured_error() = runBlocking {
        val socket = socket()

        connect(socket)
        serverSide.ws!!.send("""{"kind":"command","id":"cmd-3","type":"credentials.set","payload":{}}""")

        val ack = serverSide.takeFrame()
        assertEquals("cmd-3", ack["correlationId"]!!.jsonPrimitive.content)
        assertEquals(false, ack["ok"]!!.jsonPrimitive.booleanOrNull)
        assertEquals("unsupported", ack["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)

        socket.stop()
    }

    @Test
    fun source_debug_acks_with_the_status_field_its_schema_declares() = runBlocking {
        val socket = socket()

        connect(socket)
        serverSide.ws!!.send(
            """{"kind":"command","id":"cmd-4","type":"source.debug",""" +
                """"payload":{"sourceId":"health-connect:local"}}""",
        )

        val ack = serverSide.takeFrame()
        assertEquals(true, ack["ok"]!!.jsonPrimitive.booleanOrNull)
        val status = ack["result"]!!.jsonObject["status"]!!.jsonObject
        assertEquals("health-connect:local", status["sourceId"]!!.jsonPrimitive.content)

        socket.stop()
    }

    @Test
    fun send_event_emits_the_event_frame_shape() = runBlocking {
        val socket = socket()
        connect(socket)

        val sent = socket.sendEvent(
            "sync.status",
            buildJsonObject {
                put("sourceId", "health-connect:local")
                put("state", "syncing")
                put("startedAt", 1_700_000_000_000L)
            },
        )
        assertTrue(sent)

        val frame = serverSide.takeFrame()
        assertEquals("event", frame["kind"]!!.jsonPrimitive.content)
        assertEquals("sync.status", frame["type"]!!.jsonPrimitive.content)
        val payload = frame["payload"]!!.jsonObject
        assertEquals("health-connect:local", payload["sourceId"]!!.jsonPrimitive.content)
        assertEquals("syncing", payload["state"]!!.jsonPrimitive.content)
        assertEquals("1700000000000", payload["startedAt"]!!.jsonPrimitive.content)

        socket.stop()
    }

    @Test
    fun send_event_is_a_no_op_returning_false_when_not_connected() {
        val socket = socket()
        // Never started — no active websocket, state Disconnected.
        assertFalse(socket.sendEvent("sync.status", buildJsonObject { put("state", "syncing") }))
        assertTrue(serverSide.received.isEmpty())
    }

    @Test
    fun stop_closes_the_live_socket_and_disables_events() = runBlocking {
        val socket = socket()
        connect(socket)
        socket.stop()
        assertFalse(socket.sendEvent("sync.status", buildJsonObject { put("state", "syncing") }))
        withTimeout(5_000) { serverSide.closed.await() }
        assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
    }

    @Test
    fun stop_during_authentication_closes_the_in_flight_socket_without_resurrection() = runBlocking {
        val socket = socket()
        socket.start()
        assertEquals("Bearer tok", server.takeRequest(5, TimeUnit.SECONDS)?.getHeader("Authorization"))
        val hello = serverSide.takeFrame()
        assertEquals("hello", hello["type"]!!.jsonPrimitive.content)

        socket.stop()

        withTimeout(5_000) { serverSide.closed.await() }
        assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
        assertFalse(socket.sendEvent("sync.status", buildJsonObject { put("state", "syncing") }))
    }
}
