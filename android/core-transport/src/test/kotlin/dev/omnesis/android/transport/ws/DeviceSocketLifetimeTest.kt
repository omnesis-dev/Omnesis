// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import dev.omnesis.android.transport.routing.DirectGatewayRoute
import dev.omnesis.android.transport.routing.DirectGatewayProbing
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress

/** SDK callback order is controlled here; real TLS/pin/hostname and WS tests remain separate. */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceSocketLifetimeTest {
    private val origin = "https://gateway.example.test"
    private fun route() = DirectGatewayRoute.maintained(origin, emptyList()).also { it.connected(InetSocketAddress("127.0.0.1", 9443)) }

    @Test fun `stop during SDK factory handoff closes the resource before any hello and rejects late events`() = runTest {
        val factory = Factory()
        lateinit var socket: DeviceSocket
        socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true, webSockets = factory)
        factory.beforeReturn = { socket.stop() }
        socket.start(); runCurrent()
        val connection = factory.connections.single()
        assertEquals(1, connection.cancelled)
        connection.open()
        connection.listener.onMessage(connection, "{}")
        connection.listener.onFailure(connection, IOException("late SDK close"), null)
        connection.listener.onClosed(connection, 1000, "closed")
        assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
        assertTrue(connection.sent.isEmpty())
        assertEquals(2, connection.cancelled)
        socket.stop()
    }

    @Test fun `early open authenticates once and old SDK callbacks cannot mutate a restarted session`() = runTest {
        val factory = Factory()
        factory.beforeReturn = { it.open() }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true, expectedDeviceId = "device", webSockets = factory)
        socket.start(); runCurrent()
        val old = factory.connections.single()
        old.authenticate()
        assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
        assertEquals("Bearer device-token", old.request().header("Authorization"))
        assertEquals("https://gateway.example.test/device/ws", old.request().url.toString())
        assertTrue(old.request().isHttps)
        socket.stop()
        socket.start(); runCurrent()
        val current = factory.connections.last()
        current.authenticate()
        val accepted = socket.state.value
        old.open()
        old.authenticate()
        old.listener.onClosing(old, 1000, "late closing")
        old.listener.onClosed(old, 1000, "late closed")
        old.listener.onFailure(old, IOException("late SDK failure"), null)
        assertEquals(accepted, socket.state.value)
        assertFalse(current.cancelled > 0)
        socket.stop()
    }

    @Test fun `probe completion cannot promote after authentication ended or its parent job stopped`() = runTest {
        for (cancelScope in listOf(false, true)) {
            val factory = Factory()
            val job = SupervisorJob()
            val owner = CoroutineScope(job + StandardTestDispatcher(testScheduler))
            val started = CompletableDeferred<Unit>()
            val result = CompletableDeferred<Boolean>()
            val probe = object : DirectGatewayProbing {
                override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean { started.complete(Unit); return result.await() }
            }
            val socket = DeviceSocket(OkHttpClient(), origin, "device-token", owner, cloudRelay = true, directRoute = route(), directProbe = probe,
                expectedDeviceId = "device", webSockets = factory)
            try {
                socket.start(); runCurrent()
                val connection = factory.connections.single()
                connection.open(); connection.authenticate()
                val promoting = async { socket.promoteDirectPath() }
                runCurrent(); started.await()
                if (cancelScope) job.cancel() else connection.listener.onFailure(connection, IOException("connection ended"), null)
                runCurrent()
                val before = factory.connections.size
                result.complete(true)
                promoting.await(); runCurrent()
                assertEquals(before, factory.connections.size)
                assertFalse(socket.state.value is DeviceSocket.ConnectionState.Connected)
            } finally { socket.stop(); job.cancel(); runCurrent() }
        }
    }

    @Test fun `foreground wakes failed backoff and preserves identity while late callbacks and stopped visits cannot reconnect`() = runTest {
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true, expectedDeviceId = "device", webSockets = factory)
        socket.start(); runCurrent()
        val old = factory.connections.single()
        old.authenticate()
        socket.recoverAfterInterruption(); runCurrent()
        val replacement = factory.connections.last()
        assertEquals(2, factory.connections.size)
        replacement.authenticate()
        old.listener.onFailure(old, IOException("late interruption"), null)
        assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
        assertEquals(old.request().header("Authorization"), replacement.request().header("Authorization"))
        replacement.listener.onFailure(replacement, IOException("owned outage"), null); runCurrent()
        socket.recoverAfterInterruption(); runCurrent()
        assertEquals(3, factory.connections.size)
        socket.recoverAfterInterruption() // queued wake must be drained by terminal stop
        socket.stop(); runCurrent()
        socket.recoverAfterInterruption(); advanceTimeBy(60_000); runCurrent()
        assertEquals(3, factory.connections.size)
        assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
    }

    @Test fun `foreground before first dispatch and during factory handoff closes obsolete resource and keeps the replacement`() = runTest {
        val factory = Factory()
        lateinit var socket: DeviceSocket
        socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true, webSockets = factory)
        socket.start()
        socket.start()
        socket.recoverAfterInterruption() // active runner has not created its first SDK task yet
        factory.beforeReturn = { connection ->
            if (factory.connections.size == 1) socket.recoverAfterInterruption() else connection.open()
        }
        try {
            runCurrent()
            assertEquals(2, factory.connections.size)
            assertEquals(1, factory.connections.first().cancelled)
            assertTrue(factory.connections.first().sent.isEmpty())
            val replacement = factory.connections.last()
            replacement.authenticate()
            assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
            replacement.listener.onClosed(replacement, 1001, "owned peer close")
            socket.stop() // SDK closed, before the runner receives its close callback
            runCurrent()
            assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
        } finally { socket.stop(); runCurrent() }
    }

    @Test fun `a cancelled parent ignores later foreground and metadata maintenance callbacks`() = runTest {
        val job = SupervisorJob()
        val owner = CoroutineScope(job + StandardTestDispatcher(testScheduler))
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", owner, cloudRelay = true, webSockets = factory)
        try {
            socket.start(); runCurrent()
            factory.connections.single().authenticate()
            job.cancel(); runCurrent()
            socket.recoverAfterInterruption()
            socket.refreshDirectPath()
            assertEquals(1, factory.connections.size)
            assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
        } finally { socket.stop(); job.cancel(); runCurrent() }
    }

    @Test fun `promotion refuses a changed generation even when the replacement has the same authenticated identity`() = runTest {
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val result = CompletableDeferred<Boolean>()
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient) = result.await()
        }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true, directRoute = route(),
            directProbe = probe, expectedDeviceId = "device", webSockets = factory)
        try {
            socket.start(); runCurrent()
            factory.connections.single().authenticate()
            val promoting = async { socket.promoteDirectPath() }
            runCurrent()
            socket.recoverAfterInterruption(); runCurrent()
            val replacement = factory.connections.last()
            replacement.authenticate()
            result.complete(true); promoting.await()
            assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
            assertEquals(0, replacement.cancelled)
        } finally { socket.stop(); runCurrent() }
    }

    @Test fun `a completed probe observes parent cancellation before the queued socket cleanup`() = runTest {
        val ownerJob = SupervisorJob()
        val owner = CoroutineScope(ownerJob + StandardTestDispatcher(testScheduler))
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val result = CompletableDeferred<Boolean>()
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient) = result.await()
        }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", owner, cloudRelay = true, directRoute = route(),
            directProbe = probe, expectedDeviceId = "device", webSockets = factory)
        try {
            socket.start(); runCurrent()
            val connection = factory.connections.single()
            connection.authenticate()
            val promoting = async(UnconfinedTestDispatcher(testScheduler)) { socket.promoteDirectPath() }
            val sentBeforeCancellation = connection.sent.size
            ownerJob.cancel()
            connection.authenticate() // queued provider frame must not re-authenticate a cancelled owner
            assertEquals(sentBeforeCancellation, connection.sent.size)
            result.complete(true)
            promoting.await()
            assertEquals(0, connection.cancelled) // cancellation cleanup has not dispatched yet
            runCurrent()
            assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
        } finally { socket.stop(); ownerJob.cancel(); runCurrent() }
    }

    @Test fun `peer close between authenticated probe and handoff follows the ordinary reconnect policy`() = runTest {
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val result = CompletableDeferred<Boolean>()
        val probe = object : DirectGatewayProbing {
            override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient) = result.await()
        }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true, directRoute = route(),
            directProbe = probe, expectedDeviceId = "device", webSockets = factory)
        try {
            socket.start(); runCurrent()
            val connection = factory.connections.single()
            connection.authenticate()
            val promoting = async(UnconfinedTestDispatcher(testScheduler)) { socket.promoteDirectPath() }
            connection.listener.onClosed(connection, 1001, "owned peer restart")
            result.complete(true); promoting.await()
            runCurrent()
            assertTrue(socket.state.value is DeviceSocket.ConnectionState.Reconnecting)
            socket.recoverAfterInterruption(); runCurrent()
            assertEquals(2, factory.connections.size)
        } finally { socket.stop(); runCurrent() }
    }

    @Test fun `parent cancellation during SDK factory registration refuses its new resource and never starts maintenance`() = runTest {
        val ownerJob = SupervisorJob()
        val owner = CoroutineScope(ownerJob + UnconfinedTestDispatcher(testScheduler))
        val factory = Factory().also { it.beforeReturn = { ownerJob.cancel() } }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", owner, cloudRelay = true, directRoute = route(), webSockets = factory)
        try {
            socket.start()
            assertEquals(1, factory.connections.single().cancelled)
            assertTrue(factory.connections.single().sent.isEmpty())
            socket.refreshDirectPath()
        } finally { socket.stop(); ownerJob.cancel(); runCurrent() }
    }

    @Test fun `a synchronous SDK stop prevents the retired runner from attaching periodic route maintenance`() = runTest {
        val ownerJob = SupervisorJob()
        val owner = CoroutineScope(ownerJob + UnconfinedTestDispatcher(testScheduler))
        val factory = Factory()
        lateinit var socket: DeviceSocket
        socket = DeviceSocket(OkHttpClient(), origin, "device-token", owner, cloudRelay = true, directRoute = route(), webSockets = factory)
        factory.beforeReturn = { socket.stop() }
        try {
            socket.start()
            assertEquals(1, factory.connections.single().cancelled)
            assertTrue(factory.connections.single().sent.isEmpty())
            assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
            advanceTimeBy(60_000); runCurrent()
            assertEquals(1, factory.connections.size)
        } finally { socket.stop(); ownerJob.cancel(); runCurrent() }
    }

    @Test fun `absent or non-object authenticated identity never publishes connected or advisory telemetry`() = runTest {
        for (result in listOf("null", "[]", "42", "{}", "{\"deviceId\":null}", "{\"deviceId\":{}}")) {
            val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
            val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true,
                directRoute = route(), expectedDeviceId = "device", webSockets = factory)
            try {
                socket.start(); runCurrent()
                val connection = factory.connections.single()
                val hello = Json.parseToJsonElement(connection.sent.single()).jsonObject
                connection.listener.onMessage(connection,
                    """{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":$result}""")
                runCurrent()
                assertEquals(DeviceSocket.ConnectionState.Failed(DeviceSocket.FailureKind.AUTHENTICATION, "Gateway returned a different device identity"), socket.state.value)
                assertEquals(1, connection.sent.size)
            } finally { socket.stop(); runCurrent() }
        }
    }

    @Test fun `authority retirement during metadata completion ends maintenance without later probes or reconnection`() = runTest {
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        lateinit var socket: DeviceSocket
        var refreshed = 0
        socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true,
            directRoute = route(), refreshHints = { refreshed++; socket.stop() }, webSockets = factory)
        try {
            socket.start(); runCurrent()
            factory.connections.single().authenticate()
            advanceTimeBy(30_000); runCurrent()
            assertEquals(1, refreshed)
            assertEquals(DeviceSocket.ConnectionState.Disconnected, socket.state.value)
            advanceTimeBy(60_000); runCurrent()
            assertEquals(1, refreshed)
            assertEquals(1, factory.connections.size)
        } finally { socket.stop(); runCurrent() }
    }

    @Test fun `hello cannot advertise a physical path before routing has selected one`() = runTest {
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true,
            directRoute = DirectGatewayRoute.maintained(origin, emptyList()), expectedDeviceId = "device", webSockets = factory)
        try {
            socket.start(); runCurrent()
            val connection = factory.connections.single()
            connection.authenticate()
            assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
            assertEquals(1, connection.sent.size) // hello only, no invented local/relay event
        } finally { socket.stop(); runCurrent() }
    }

    @Test fun `promotion network restoration and foreground share the same exhausted attempt budget`() = runTest {
        val factory = Factory().also { it.beforeReturn = { ws -> ws.open() } }
        val paths = kotlinx.coroutines.flow.MutableSharedFlow<NetworkPathSnapshot>(extraBufferCapacity = 20)
        val socket = DeviceSocket(OkHttpClient(), origin, "device-token", backgroundScope, cloudRelay = true,
            directRoute = route(), expectedDeviceId = "device", webSockets = factory,
            directProbe = object : DirectGatewayProbing {
                override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient) = true
            },
            pathObserver = object : NetworkPathObserver { override fun paths() = paths },
            limits = DeviceSocketReconnectLimits(attemptBurst = 1, attemptRefillIntervalMs = 60_000),
            nowMs = { testScheduler.currentTime }, randomUnit = { 0.0 })
        try {
            socket.start(); runCurrent()
            factory.connections.single().authenticate()
            socket.promoteDirectPath(); runCurrent()
            repeat(4) {
                paths.emit(NetworkPathSnapshot(isUsable = false)); runCurrent()
                paths.emit(NetworkPathSnapshot(isUsable = true)); runCurrent()
                socket.appDidBecomeActive(); runCurrent()
            }
            assertEquals(1, factory.connections.size)
            advanceTimeBy(59_999); runCurrent()
            assertEquals(1, factory.connections.size)
            advanceTimeBy(1); runCurrent()
            assertEquals(2, factory.connections.size)
            factory.connections.last().authenticate()
            assertTrue(socket.state.value is DeviceSocket.ConnectionState.Connected)
        } finally { socket.stop(); runCurrent() }
    }

    private class Factory : WebSocket.Factory {
        val connections = mutableListOf<Connection>()
        var beforeReturn: (Connection) -> Unit = {}
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket = Connection(request, listener).also {
            connections += it
            beforeReturn(it)
        }
    }
    private class Connection(private val request: Request, val listener: WebSocketListener) : WebSocket {
        val sent = mutableListOf<String>()
        var cancelled = 0
        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { sent += text; return true }
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?) = true
        override fun cancel() { cancelled++ }
        fun open() { listener.onOpen(this, Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("Switching Protocols").build()) }
        fun authenticate() {
            val hello = Json.parseToJsonElement(sent.first()).jsonObject
            listener.onMessage(this, """{"kind":"response","correlationId":"${hello["id"]!!.jsonPrimitive.content}","ok":true,"result":{"deviceId":"device","deviceName":"Test phone","scopes":["read"]}}""")
        }
    }
}
