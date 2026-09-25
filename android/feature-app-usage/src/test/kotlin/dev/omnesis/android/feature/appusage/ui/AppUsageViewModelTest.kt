// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.appusage.AppUsageIntegration
import dev.omnesis.android.feature.appusage.AppUsageSessionProvider
import dev.omnesis.android.feature.appusage.AppUsageSettings
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.feature.appusage.AppUsageSyncScheduler
import dev.omnesis.android.feature.appusage.InMemoryKeyValueStore
import dev.omnesis.android.transport.MembershipIntent
import dev.omnesis.android.transport.MembershipOp
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.MembershipRefusalCoordinator
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
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
 * The App Usage settings view model against real collaborators: a real
 * [AppUsageIntegration] over WorkManager's test harness, a real
 * [SourceMembership] over MockWebServer, and the app-scoped
 * [MembershipRefusalCoordinator] that acts on a refusal in production. All
 * fixture values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class AppUsageViewModelTest {

    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var settings: AppUsageSettings
    private lateinit var outbox: MembershipOutbox
    private lateinit var integration: AppUsageIntegration
    private lateinit var membership: SourceMembership

    /** Requests the gateway saw, so a screen that talks to it can be told from one that does not. */
    private val gatewayWrites = AtomicInteger()

    /** Unpaired for sync purposes: nothing here reaches a sync. */
    private object Sessions : AppUsageSessionProvider {
        override fun coordinator(): AppUsageSyncCoordinator? = null

        override fun deviceId(): String = DEVICE_ID
    }

    @Before
    fun setUp() {
        // viewModelScope dispatches to Main; an unconfined test dispatcher runs
        // the coroutines inline (and lets MockWebServer resume them on OkHttp
        // threads without a paused scheduler in the way).
        Dispatchers.setMain(UnconfinedTestDispatcher())
        context = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        server = MockWebServer()
        // Another device holds the row and every join is refused for good, so
        // a resume that should never happen gets an answer instead of blocking.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method != "GET") gatewayWrites.incrementAndGet()
                return when {
                    request.method == "POST" && request.path.orEmpty().contains("/members") ->
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
        integration = AppUsageIntegration(context, settings)
        membership = SourceMembership(
            admin = { admin() },
            deviceId = { DEVICE_ID },
            outbox = outbox,
            scope = CoroutineScope(Dispatchers.Unconfined),
            registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
        )
        // The app's own consumer of refusals, alive for the whole test the way
        // it is alive for the whole process — no screen is required for it.
        MembershipRefusalCoordinator(
            membership = membership,
            optIns = { setOf(integration) },
            scope = CoroutineScope(Dispatchers.Unconfined),
        ).start()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun admin() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    /** A settings screen being opened. */
    private fun vm(authoritativeStatus: SourceSyncStatus? = null) = AppUsageViewModel(
        settings = settings,
        integration = integration,
        sessions = Sessions,
        permissionHealth = PermissionHealthCoordinator(
            reporters = { emptySet() },
            admin = { null },
            scope = CoroutineScope(Dispatchers.Unconfined),
        ),
        membership = membership,
        syncStatusReader = SourceSyncStatusReader { authoritativeStatus },
    )

    private fun workInfos(): List<WorkInfo> =
        WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(AppUsageSyncScheduler.UNIQUE_WORK_NAME)
            .get()

    @Test
    fun reopening_settings_restores_the_gateway_sync_status() {
        val persisted = SourceSyncStatus(
            sourceId = AppUsageSyncCoordinator.SOURCE_ID,
            state = "error",
            errorMessage = "Background sync failed",
        )

        val vm = vm(persisted)

        assertEquals(persisted, vm.state.value.authoritativeStatus)
    }

    @Test
    fun opening_settings_with_the_usage_grant_leaves_app_usage_off() {
        val vm = vm()
        assertTrue("the grant is the precondition this test is about", vm.state.value.hasUsageAccess)

        vm.refresh()
        runBlocking { delay(800) }

        assertFalse(vm.state.value.enabled)
        assertFalse(settings.appUsageEnabled)
        assertEquals("the screen must not ask the gateway anything", 0, gatewayWrites.get())
        assertTrue(workInfos().isEmpty())
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun a_refusal_drained_with_no_screen_open_still_turns_the_source_off() {
        // What every foreground does: carry out whatever the gateway is still
        // owed. No view model exists here, and none is needed — the opt-in and
        // the periodic worker have to go either way.
        settings.appUsageEnabled = true
        integration.scheduleBackgroundSync()
        outbox.record(MembershipOp(AppUsageSyncCoordinator.SOURCE_ID, DEVICE_ID, MembershipIntent.RESUME))

        runBlocking { withTimeout(10_000) { membership.drain() } }

        assertFalse(settings.appUsageEnabled)
        assertEquals(WorkInfo.State.CANCELLED, workInfos()[0].state)
        assertTrue(outbox.pending().isEmpty())
    }

    private companion object {
        const val DEVICE_ID = "device-9"
    }
}
