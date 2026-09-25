// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.setup

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.appusage.AppUsageIntegration
import dev.omnesis.android.feature.appusage.AppUsageSessionProvider
import dev.omnesis.android.feature.appusage.AppUsageSettings
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.feature.appusage.AppUsageSyncScheduler
import dev.omnesis.android.feature.appusage.InMemoryKeyValueStore
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.transport.ACTIVATION_COMMIT_FAILED
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
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
 * The App Usage setup page's enable against a gateway where another device
 * already hosts the source: a refused join or a contract this phone cannot
 * move to ends the enable as a failure that says why, with App Usage still
 * off and nothing scheduled or owed. All fixture values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class AppUsageSetupStepTest {
    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var settings: AppUsageSettings
    private lateinit var outbox: MembershipOutbox
    private lateinit var step: AppUsageSetupStep
    private val refuseContractTransition = AtomicBoolean()
    private val collectors = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private object Sessions : AppUsageSessionProvider {
        override fun coordinator(): AppUsageSyncCoordinator? = null
        override fun deviceId(): String = DEVICE_ID
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "PATCH" && path.contains("/admin/sources/") ->
                        if (refuseContractTransition.get()) {
                            MockResponse()
                                .setResponseCode(409)
                                .setBody(
                                    """{"error":"device \"Hallway Phone\" does not support the partitioned contract; update the device","code":"MULTI_DEVICE_CONTRACT_UNSUPPORTED"}""",
                                )
                        } else {
                            MockResponse().setBody(
                                """{"source":{"id":"${AppUsageSyncCoordinator.SOURCE_ID}","type":"android-app-usage","deviceId":"device-desk","enabled":true,"members":["device-desk"],"multiDeviceMode":"partitioned"}}""",
                            )
                        }
                    request.method == "POST" && path.contains("/members") ->
                        MockResponse()
                            .setResponseCode(409)
                            .setBody("""{"error":"already hosted","code":"SOURCE_ALREADY_HOSTED"}""")
                    else -> MockResponse().setBody(
                        """{"items":[{"id":"${AppUsageSyncCoordinator.SOURCE_ID}","type":"android-app-usage",""" +
                            """"deviceId":"device-desk","enabled":true,"members":["device-desk"]}]}""",
                    )
                }
            }
        }
        server.start()
        val store = InMemoryKeyValueStore()
        settings = AppUsageSettings(store)
        outbox = MembershipOutbox(read = store::get, write = store::put)
        val integration = AppUsageIntegration(context, settings)
        val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
        step = AppUsageSetupStep(
            integration = integration,
            settings = settings,
            sessions = Sessions,
            membership = SourceMembership(
                admin = { admin },
                deviceId = { DEVICE_ID },
                outbox = outbox,
                scope = CoroutineScope(Dispatchers.Unconfined),
                registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
            ),
            permissionHealth = PermissionHealthCoordinator({ emptySet() }, { null }, CoroutineScope(Dispatchers.Unconfined)),
            sessionScopes = { null },
            hasUsageAccess = { true },
        )
    }

    @After
    fun tearDown() {
        collectors.cancel()
        Dispatchers.resetMain()
        server.shutdown()
    }

    /** Agrees on the page, with usage access already granted, and returns how the enable ended. */
    private fun agree(): SetupOutcome.Failed {
        val outcomes = CopyOnWriteArrayList<SetupOutcome?>()
        collectors.launch { step.outcomes.collect { outcomes += it } }
        step.sequence.start()
        runBlocking { withTimeout(10_000) { while (outcomes.isEmpty()) delay(10) } }
        val outcome = outcomes.single()
        assertTrue("expected a failure, got $outcome", outcome is SetupOutcome.Failed)
        return outcome as SetupOutcome.Failed
    }

    private fun assertNothingChanged() {
        assertFalse(settings.appUsageEnabled)
        assertFalse(settings.explicitEnablePending)
        assertTrue(
            WorkManager.getInstance(context).getWorkInfosForUniqueWork(AppUsageSyncScheduler.UNIQUE_WORK_NAME).get().isEmpty(),
        )
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun aRefusedJoinFailsTheEnableAndLeavesAppUsageOff() {
        assertEquals(ACTIVATION_COMMIT_FAILED, agree().message)
        assertNothingChanged()
    }

    @Test
    fun aContractRefusalNamesTheDeviceThatMustUpdate() {
        refuseContractTransition.set(true)

        val message = agree().message.orEmpty()

        assertTrue(message.contains("Hallway Phone"))
        assertTrue(message.contains("update the device"))
        assertFalse(message.contains("Check the connection"))
        assertNothingChanged()
    }

    private companion object {
        const val DEVICE_ID = "device-9"
    }
}
