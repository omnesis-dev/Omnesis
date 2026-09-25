// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsIntegration
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSessionProvider
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSettings
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncCoordinator
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncScheduler
import dev.omnesis.android.feature.activitysegments.ActivityTransitionBuffer
import dev.omnesis.android.feature.activitysegments.InMemoryKeyValueStore
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.MembershipRefusalCoordinator
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus
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
import org.robolectric.annotation.Config

/**
 * The Activity Segments settings view model against real collaborators: a real
 * [ActivitySegmentsIntegration] over WorkManager's test harness, and a real
 * [SourceMembership] over MockWebServer. All fixture values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class ActivitySegmentsViewModelTest {

    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var settings: ActivitySegmentsSettings
    private lateinit var outbox: MembershipOutbox
    private lateinit var integration: ActivitySegmentsIntegration
    private lateinit var membership: SourceMembership

    private class FakeSessionProvider(private val deviceId: String?) : ActivitySegmentsSessionProvider {
        /** Unpaired for sync purposes: a refused resume never reaches a sync anyway. */
        override fun coordinator(): ActivitySegmentsSyncCoordinator? = null

        override fun deviceId(): String? = deviceId
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
        server.start()
        val store = InMemoryKeyValueStore()
        settings = ActivitySegmentsSettings(store)
        outbox = MembershipOutbox(read = store::get, write = store::put)
        integration = ActivitySegmentsIntegration(context, settings, ActivityTransitionBuffer(context))
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

    private fun vm(
        sessions: ActivitySegmentsSessionProvider,
        authoritativeStatus: SourceSyncStatus? = null,
    ) = ActivitySegmentsViewModel(
        settings = settings,
        integration = integration,
        sessions = sessions,
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
            .getWorkInfosForUniqueWork(ActivitySegmentsSyncScheduler.UNIQUE_WORK_NAME)
            .get()

    @Test
    fun reopening_settings_restores_the_gateway_sync_status() {
        val persisted = SourceSyncStatus(
            sourceId = ActivitySegmentsSyncCoordinator.SOURCE_ID,
            state = "synced",
            lastSyncAt = "2026-09-03T08:00:00.000Z",
        )

        val vm = vm(FakeSessionProvider(deviceId = null), persisted)

        assertEquals(persisted, vm.state.value.authoritativeStatus)
    }

    @Test
    fun a_refused_resume_puts_the_switch_back_off_and_says_why() {
        // The row exists and another device holds it, so the join is refused
        // for good: this phone would host nothing however its switch reads.
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"${ActivitySegmentsSyncCoordinator.SOURCE_ID}","type":"android-activity-segments",""" +
                    """"deviceId":"device-desk","enabled":true,"members":["device-desk"]}]}""",
            ),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":"already hosted","code":"SOURCE_ALREADY_HOSTED"}"""),
        )

        val vm = vm(FakeSessionProvider(deviceId = DEVICE_ID))
        integration.optIn(membership) {}

        val settled = runBlocking {
            withTimeout(10_000) { vm.state.first { it.membershipRefusal != null } }
        }
        assertFalse(settled.enabled)
        assertFalse(settings.activitySegmentsEnabled)
        assertTrue(settled.membershipRefusal!!.contains("Another device already syncs"))
        // The background worker the opt-in scheduled goes with the switch.
        assertEquals(WorkInfo.State.CANCELLED, workInfos()[0].state)
        // A refusal settles the intent — retrying it would earn the same answer.
        assertTrue(outbox.pending().isEmpty())
    }

    private companion object {
        const val DEVICE_ID = "device-9"
    }
}
