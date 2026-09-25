// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.setup

import android.Manifest
import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.calllog.CallLogIntegration
import dev.omnesis.android.feature.calllog.CallLogSessionProvider
import dev.omnesis.android.feature.calllog.CallLogSettings
import dev.omnesis.android.feature.calllog.CallLogSyncCoordinator
import dev.omnesis.android.feature.calllog.CallLogSyncScheduler
import dev.omnesis.android.feature.calllog.InMemoryKeyValueStore
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The Call Log setup page's enable and its re-read on resume, against a mock
 * gateway. All fixture values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class CallLogSetupStepTest {

    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var settings: CallLogSettings
    private lateinit var step: CallLogSetupStep

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        server.start()
        val store = InMemoryKeyValueStore()
        settings = CallLogSettings(store)
        val integration = CallLogIntegration(context, settings)
        val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
        val sessions = object : CallLogSessionProvider {
            override fun coordinator(): CallLogSyncCoordinator? = null
            override fun deviceId(): String = DEVICE_ID
        }
        step = CallLogSetupStep(
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
    fun androids_prompt_is_asked_for_before_membership_or_the_local_opt_in() {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"${CallLogSyncCoordinator.SOURCE_ID}","type":"android-call-log","deviceId":"device-other","enabled":true,"members":["device-other"],"multiDeviceMode":"exclusive"}]}""",
            ),
        )

        step.sequence.start()
        runBlocking { withTimeout(10_000) { step.sequence.launchRequest.first { it != null } } }

        assertEquals(1, server.requestCount)
        assertFalse(settings.callLogEnabled)
        assertTrue(
            WorkManager.getInstance(context).getWorkInfosForUniqueWork(CallLogSyncScheduler.UNIQUE_WORK_NAME).get().isEmpty(),
        )
    }

    @Test
    fun resuming_re_reads_the_grant_of_an_enabled_source_and_leaves_an_off_one_alone() = runBlocking {
        assertEquals(SetupOutcome.Skipped, step.refreshOutcome(SetupOutcome.Skipped))

        settings.callLogEnabled = true
        assertEquals(SetupOutcome.NotAllowed, step.refreshOutcome(SetupOutcome.On))

        shadowOf(context as Application).grantPermissions(Manifest.permission.READ_CALL_LOG)
        assertEquals(SetupOutcome.On, step.refreshOutcome(SetupOutcome.NotAllowed))
    }

    private companion object {
        const val DEVICE_ID = "device-9"
    }
}
