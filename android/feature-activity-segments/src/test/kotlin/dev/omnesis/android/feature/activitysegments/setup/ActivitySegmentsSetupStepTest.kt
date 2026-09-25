// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.setup

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsIntegration
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSessionProvider
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSettings
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncCoordinator
import dev.omnesis.android.feature.activitysegments.ActivityTransitionBuffer
import dev.omnesis.android.feature.activitysegments.InMemoryKeyValueStore
import dev.omnesis.android.transport.ActivationStep
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Activity Segments setup page's explicit enable against a mock gateway.
 * All fixture values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class ActivitySegmentsSetupStepTest {

    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var settings: ActivitySegmentsSettings
    private lateinit var step: ActivitySegmentsSetupStep

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        settings = ActivitySegmentsSettings(store)
        val integration = ActivitySegmentsIntegration(context, settings, ActivityTransitionBuffer(context))
        val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
        val sessions = object : ActivitySegmentsSessionProvider {
            override fun coordinator(): ActivitySegmentsSyncCoordinator? = null
            override fun deviceId(): String = DEVICE_ID
        }
        step = ActivitySegmentsSetupStep(
            integration = integration,
            settings = settings,
            sessions = sessions,
            membership = SourceMembership(
                admin = { admin },
                deviceId = { DEVICE_ID },
                outbox = MembershipOutbox(read = store::get, write = store::put),
                scope = CoroutineScope(Dispatchers.Unconfined),
                registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
            ),
            permissionHealth = PermissionHealthCoordinator({ emptySet() }, { null }, CoroutineScope(Dispatchers.Unconfined)),
            sessionScopes = { null },
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    @Test
    fun a_contract_refusal_names_the_device_that_must_update_and_leaves_the_source_off() = runBlocking {
        val source =
            """{"items":[{"id":"${ActivitySegmentsSyncCoordinator.SOURCE_ID}","type":"android-activity-segments",""" +
                """"deviceId":"device-desk","enabled":true,"members":["device-desk"],"multiDeviceMode":"exclusive"}]}"""
        server.enqueue(MockResponse().setBody(source))
        assertEquals(ActivationStep.Ready, withTimeout(10_000) { step.actions.inspect(null) })

        server.enqueue(MockResponse().setBody(source))
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody(
                    """{"error":"device \"Hallway Phone\" does not support the partitioned contract; update the device","code":"MULTI_DEVICE_CONTRACT_UNSUPPORTED"}""",
                ),
        )
        val committed = withTimeout(10_000) { step.actions.commit(null) }

        assertTrue(committed is ActivationStep.Failed)
        val message = (committed as ActivationStep.Failed).message
        assertTrue(message.contains("Hallway Phone"))
        assertTrue(message.contains("update the device"))
        assertFalse(message.contains("Check the connection"))
        assertFalse(settings.activitySegmentsEnabled)
    }

    private companion object {
        const val DEVICE_ID = "device-9"
    }
}
