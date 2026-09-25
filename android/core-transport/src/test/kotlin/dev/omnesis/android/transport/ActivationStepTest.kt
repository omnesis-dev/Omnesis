// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class ActivationStepTest {
    private lateinit var server: MockWebServer
    private var sourcesBody = """{"items":[]}"""
    private var sourcesStatus = 200

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.path == "/admin/sources") {
                    MockResponse().setResponseCode(sourcesStatus).setBody(sourcesBody)
                } else {
                    MockResponse().setBody("""{"ok":true}""")
                }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun membership(): SourceMembership {
        val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "test-token"))
        val store = mutableMapOf<String, String>()
        return SourceMembership(
            admin = { admin },
            deviceId = { "device-a" },
            outbox = MembershipOutbox(read = store::get, write = { k, v -> if (v == null) store.remove(k) else store[k] = v }),
            scope = CoroutineScope(Dispatchers.Unconfined),
        )
    }

    @Test
    fun anAbsentSourceIsReadyOnBothHalves() = runBlocking {
        assertEquals(ActivationStep.Ready, membership().inspectActivationStep("fictional:local", SourceMultiDeviceMode.PARTITIONED))
        assertEquals(ActivationStep.Ready, membership().commitActivationStep("fictional:local", SourceMultiDeviceMode.PARTITIONED))
    }

    @Test
    fun anExclusiveSourceHeldElsewhereAsksForAChoiceBeforeAccessAndFailsAfterIt() = runBlocking {
        sourcesBody = """{"items":[{"id":"fictional:local","type":"fictional","deviceId":"device-b","multiDeviceMode":"exclusive"}]}"""
        assertEquals(
            ActivationStep.ChoiceRequired(SourceMultiDeviceMode.EXCLUSIVE),
            membership().inspectActivationStep("fictional:local", SourceMultiDeviceMode.EXCLUSIVE),
        )
        assertEquals(
            ActivationStep.KeptOther,
            membership().inspectActivationStep("fictional:local", SourceMultiDeviceMode.EXCLUSIVE, ActivationChoice.KEEP_OTHER),
        )
        assertEquals(
            ActivationStep.Failed(ACTIVATION_COMMIT_FAILED),
            membership().commitActivationStep("fictional:local", SourceMultiDeviceMode.EXCLUSIVE),
        )
    }

    @Test
    fun anIncompatibleModeFailsWithItsExplanation() = runBlocking {
        sourcesBody = """{"items":[{"id":"fictional:local","type":"fictional","deviceId":"device-b","multiDeviceMode":"replicated"}]}"""
        assertEquals(
            ActivationStep.Failed(ACTIVATION_INCOMPATIBLE),
            membership().inspectActivationStep("fictional:local", SourceMultiDeviceMode.PARTITIONED),
        )
    }

    @Test
    fun anUnreachableGatewayFoldsIntoTheFallbackMessage() = runBlocking {
        sourcesStatus = 503
        sourcesBody = """{"error":"unavailable"}"""
        assertEquals(
            ActivationStep.Failed(ACTIVATION_PREPARE_FAILED),
            membership().inspectActivationStep("fictional:local", SourceMultiDeviceMode.PARTITIONED),
        )
        assertEquals(
            ActivationStep.Failed(ACTIVATION_COMMIT_FAILED),
            membership().commitActivationStep("fictional:local", SourceMultiDeviceMode.PARTITIONED),
        )
    }
}
