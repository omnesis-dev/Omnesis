// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import dev.omnesis.android.feature.health.setup.healthConsentGrantsAccess
import android.content.Context
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.feature.health.HealthCategory
import dev.omnesis.android.feature.health.HealthConnectSource
import dev.omnesis.android.feature.health.HealthIntegration
import dev.omnesis.android.feature.health.HealthSessionProvider
import dev.omnesis.android.feature.health.HealthSettings
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.feature.health.HealthSyncScheduler
import dev.omnesis.android.feature.health.HealthTypeCatalog
import dev.omnesis.android.feature.health.InMemoryKeyValueStore
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.feature.health.di.HealthConnectStatusReader
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.MembershipIntent
import dev.omnesis.android.transport.MembershipOp
import dev.omnesis.android.transport.MembershipOutbox
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The health settings view model against real collaborators: a real
 * [HealthIntegration] over WorkManager's test harness (so "worker scheduled"
 * is asserted on actual unique work, not a mock), and a real
 * [HealthSyncCoordinator] over MockWebServer for the sync path. All fixture
 * values invented.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class, ExperimentalMindfulnessSessionApi::class)
class HealthViewModelTest {

    private lateinit var context: Context
    private lateinit var server: MockWebServer
    private lateinit var store: InMemoryKeyValueStore
    private lateinit var settings: HealthSettings
    private lateinit var outbox: MembershipOutbox
    private lateinit var integration: HealthIntegration
    private lateinit var membership: SourceMembership

    private class FakeStatusReader(
        var availability: HealthConnectAvailability = HealthConnectAvailability.Available,
        var granted: Set<String> = emptySet(),
        var unavailableFeatures: Set<Int> = emptySet(),
    ) : HealthConnectStatusReader {
        override fun availability(): HealthConnectAvailability = availability

        override suspend fun grantedPermissions(): Set<String> = granted

        override fun featureAvailable(feature: Int): Boolean = feature !in unavailableFeatures
    }

    private class FakeSessionProvider(
        private val coordinator: HealthSyncCoordinator? = null,
        private val deviceId: String? = null,
    ) : HealthSessionProvider {
        override fun coordinator(): HealthSyncCoordinator? = coordinator

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
        store = InMemoryKeyValueStore()
        settings = HealthSettings(store)
        outbox = MembershipOutbox(read = store::get, write = store::put)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun coordinator(): HealthSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))
        return HealthSyncCoordinator(
            sourceFactory = {
                HealthConnectSource(
                    client = fake,
                    accountId = HealthConnectSource.ACCOUNT_ID_LOCAL,
                    selfPackageName = "dev.omnesis.android",
                    settings = settings,
                )
            },
            analytics = AnalyticsClient(http),
            settings = settings,
            availability = { HealthConnectAvailability.Available },
            sendEvent = { _, _ -> },
        )
    }

    private fun admin() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private fun vm(
        sessions: HealthSessionProvider = FakeSessionProvider(),
        reader: FakeStatusReader = FakeStatusReader(),
        authoritativeStatus: SourceSyncStatus? = null,
    ): HealthViewModel {
        integration = HealthIntegration(context, settings, reader)
        // The membership holder talks to the same MockWebServer as the
        // coordinator, and is paired exactly when the session provider is.
        membership = SourceMembership(
            admin = { sessions.deviceId()?.let { admin() } },
            deviceId = sessions::deviceId,
            outbox = outbox,
            scope = CoroutineScope(Dispatchers.Unconfined),
            registerAbsentSource = { op, client -> integration.registerForResume(client, op.deviceId) },
        )
        return HealthViewModel(
            settings = settings,
            integration = integration,
            status = reader,
            sessions = sessions,
            permissionHealth = PermissionHealthCoordinator(
                reporters = { emptySet() },
                admin = { null },
                scope = CoroutineScope(Dispatchers.Unconfined),
            ),
            membership = membership,
            syncStatusReader = SourceSyncStatusReader { authoritativeStatus },
        )
    }

    /**
     * The local half of the setup page's enable, once the gateway accepted
     * this phone, with the section's own sync as its first run.
     */
    private fun optIn(vm: HealthViewModel) {
        integration.optIn(membership) { vm.syncNow() }
        vm.refresh()
    }

    private fun workInfos(): List<WorkInfo> =
        WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork(HealthSyncScheduler.UNIQUE_WORK_NAME)
            .get()

    @Test
    fun reopening_settings_restores_the_gateway_sync_status() {
        val persisted = SourceSyncStatus(
            sourceId = HealthSyncCoordinator.SOURCE_ID,
            state = "error",
            errorMessage = "Background sync could not reach the gateway",
        )

        val vm = vm(authoritativeStatus = persisted)

        assertEquals(persisted, vm.state.value.authoritativeStatus)
        assertNull(vm.state.value.lastResult)
    }

    // ── enable ───────────────────────────────────────────────────────

    @Test
    fun enable_flips_settings_schedules_worker_and_kicks_sync() {
        // Enable first resumes membership (the source list: no row yet, so
        // nothing to rejoin or unpause), then one drain with no records:
        // register, GET sync-state (404 → first pass), then the cursor persist.
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"health-connect:local","type":"health-connect"}}"""))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))

        val vm = vm(sessions = FakeSessionProvider(coordinator(), deviceId = "device-9"))
        optIn(vm)

        val settled = runBlocking {
            withTimeout(10_000) { vm.state.first { !it.syncing && it.lastResult != null } }
        }
        assertTrue(settings.healthConnectEnabled)
        assertTrue(settled.enabled)
        assertEquals(HealthSyncCoordinator.SyncResult.Success(0), settled.lastResult)

        // Membership was checked before registration, which carried this device's id.
        assertEquals("GET", server.takeRequest().method)
        val register = server.takeRequest()
        assertEquals("POST", register.method)
        assertEquals("/admin/sources", register.path)
        val sent = OmnesisJson.parseToJsonElement(register.body.readUtf8()).jsonObject
        assertEquals("device-9", sent["deviceId"]!!.jsonPrimitive.content)

        // The hourly worker is enqueued under its unique name.
        val infos = workInfos()
        assertEquals(1, infos.size)
        assertEquals(WorkInfo.State.ENQUEUED, infos[0].state)
    }

    @Test
    fun sync_now_without_a_session_is_a_no_op() {
        val vm = vm(sessions = FakeSessionProvider(coordinator = null))
        vm.syncNow()
        assertFalse(vm.state.value.syncing)
        assertNull(vm.state.value.lastResult)
        assertEquals(0, server.requestCount)
    }

    // ── grants ───────────────────────────────────────────────────────

    @Test
    fun partial_grant_counts_only_the_granted_subset() {
        val subset = setOf(
            HealthTypeCatalog.readPermissionFor(HealthTypeCatalog.entries[0]),
            HealthTypeCatalog.readPermissionFor(HealthTypeCatalog.entries[1]),
        )
        val vm = vm(reader = FakeStatusReader(granted = subset))

        assertEquals(2, vm.state.value.grantedPermissions)
        assertTrue(vm.state.value.grantedPermissions < vm.state.value.totalPermissions)
    }

    @Test
    fun unsupported_record_types_are_not_requested_or_reported_missing() {
        val reader = FakeStatusReader(
            granted = HealthTypeCatalog.allPermissionsToRequest,
            unavailableFeatures = setOf(HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION),
        )
        val mindfulnessPermission = HealthTypeCatalog.readPermissionFor(
            HealthTypeCatalog.entries.single { it.name == "MindfulnessSession" },
        )
        reader.granted -= mindfulnessPermission

        val vm = vm(reader = reader)

        assertFalse(mindfulnessPermission in vm.permissionsToRequest(HealthCategory.entries.toSet()))
        assertEquals(vm.state.value.totalTypePermissions, vm.state.value.grantedTypePermissions)
        assertEquals(vm.state.value.totalPermissions, vm.state.value.grantedPermissions)
    }

    @Test
    fun denied_health_consent_does_not_commit_phone_activation() {
        val requested = setOf("fictional.permission.READ_STEPS")
        assertFalse(healthConsentGrantsAccess(emptySet(), requested))
        assertFalse(healthConsentGrantsAccess(setOf("fictional.permission.READ_IN_BACKGROUND"), requested))
        assertTrue(healthConsentGrantsAccess(requested, requested))
    }

    // ── category toggles ─────────────────────────────────────────────

    @Test
    fun toggle_category_updates_state_and_persists_to_the_store() {
        val vm = vm()

        vm.toggleCategory(HealthCategory.VITALS, false)

        assertFalse(HealthCategory.VITALS in vm.state.value.enabledCategories)
        // A fresh HealthSettings over the same store sees the change.
        assertEquals(
            HealthCategory.entries.toSet() - HealthCategory.VITALS,
            HealthSettings(store).enabledCategories,
        )

        vm.toggleCategory(HealthCategory.VITALS, true)
        assertEquals(HealthCategory.entries.toSet(), HealthSettings(store).enabledCategories)
    }

    @Test
    fun enable_unpauses_existing_source_without_redundant_registration() {
        // The row exists, paused, with this device its only host: resume
        // PATCHes it back on, then drains without creating the source again.
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"health-connect:local","type":"health-connect","deviceId":"device-9","enabled":false,"members":["device-9"]}]}""",
            ),
        )
        server.enqueue(MockResponse().setBody("""{"source":{"id":"health-connect:local","type":"health-connect","enabled":true}}"""))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))

        val vm = vm(sessions = FakeSessionProvider(coordinator(), deviceId = "device-9"))
        optIn(vm)
        runBlocking { withTimeout(10_000) { vm.state.first { !it.syncing && it.lastResult != null } } }

        assertEquals("/admin/sources", server.takeRequest().path)
        val unpause = server.takeRequest()
        assertEquals("PATCH", unpause.method)
        assertEquals("/admin/sources/health-connect:local", unpause.path)
        assertEquals("""{"enabled":true}""", unpause.body.readUtf8())
        val drain = server.takeRequest()
        assertEquals("GET", drain.method)
        assertTrue(drain.path.orEmpty().startsWith("/sync-state/"))
        assertTrue(outbox.pending().isEmpty())
    }

    @Test
    fun enable_restores_membership_even_while_a_sync_is_in_flight() {
        // Sync now is running — its cursor read is held open, so the view
        // model's `syncing` flag stays up. The user turns the source off
        // (queuing a detach the gateway refuses) and straight back on. What
        // the switch now means is a resume, and it must replace that queued
        // detach: leave it queued and the next foreground carries it out,
        // pausing a source whose switch reads on.
        val holdCursor = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "GET" && path.startsWith("/sync-state/") -> {
                        holdCursor.await(30, TimeUnit.SECONDS)
                        MockResponse().setResponseCode(404).setBody("""{"error":"not found"}""")
                    }
                    // The opt-out's detach, refused so that it stays queued.
                    request.method == "DELETE" ->
                        MockResponse().setResponseCode(503).setBody("""{"error":"writer busy"}""")
                    // Resume observes the existing enabled membership.
                    path == "/admin/sources" -> MockResponse().setBody("""{"items":[{"id":"health-connect:local","type":"health-connect","deviceId":"device-9","enabled":true,"members":["device-9"]}]}""")
                    else -> MockResponse().setBody("""{"ok":true}""")
                }
            }
        }

        settings.healthConnectEnabled = true
        val vm = vm(sessions = FakeSessionProvider(coordinator(), deviceId = "device-9"))
        vm.syncNow()
        runBlocking { withTimeout(10_000) { while (server.requestCount < 1) delay(10) } }
        assertTrue(vm.state.value.syncing)

        vm.disable()
        runBlocking { withTimeout(10_000) { while (server.requestCount < 2) delay(10) } }
        assertEquals(
            listOf(MembershipOp("health-connect:local", "device-9", MembershipIntent.DETACH)),
            outbox.pending(),
        )

        optIn(vm)
        // The detach is gone because the resume replaced it and the gateway
        // answered — not because it was never recorded.
        runBlocking { withTimeout(10_000) { while (outbox.pending().isNotEmpty()) delay(10) } }
        assertTrue(vm.state.value.syncing)

        // Let the held cursor read through so nothing is in flight at teardown.
        holdCursor.countDown()
        runBlocking { withTimeout(10_000) { vm.state.first { !it.syncing } } }
    }

    // ── disable ──────────────────────────────────────────────────────

    @Test
    fun disable_flips_settings_cancels_the_worker_and_detaches_this_device() {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        server.enqueue(MockResponse().setBody("""{"source":{"id":"health-connect:local","type":"health-connect"}}"""))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        val vm = vm(sessions = FakeSessionProvider(coordinator(), deviceId = "device-9"))
        optIn(vm)
        runBlocking { withTimeout(10_000) { vm.state.first { !it.syncing && it.lastResult != null } } }
        repeat(4) { server.takeRequest() }

        assertTrue(settings.healthConnectEnabled)
        assertEquals(WorkInfo.State.ENQUEUED, workInfos()[0].state)

        server.enqueue(MockResponse().setBody("""{"source":{"id":"health-connect:local","type":"health-connect"},"members":[]}"""))
        vm.disable()

        assertFalse(settings.healthConnectEnabled)
        assertFalse(vm.state.value.enabled)
        assertNull(vm.state.value.lastResult)
        assertEquals(WorkInfo.State.CANCELLED, workInfos()[0].state)
        // The detach targets this device on the source's member route.
        val detach = server.takeRequest()
        assertEquals("DELETE", detach.method)
        assertEquals("/admin/sources/health-connect:local/members/device-9", detach.path)
        // The answer settles the op on an OkHttp thread; wait for it to clear.
        runBlocking { withTimeout(10_000) { while (outbox.pending().isNotEmpty()) delay(10) } }
    }

    @Test
    fun disable_keeps_the_detach_queued_when_the_gateway_is_unreachable() {
        val vm = vm(sessions = FakeSessionProvider(coordinator(), deviceId = "device-9"))
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"writer busy"}"""))

        vm.disable()

        assertEquals("DELETE", server.takeRequest().method)
        assertEquals(
            listOf(MembershipOp("health-connect:local", "device-9", MembershipIntent.DETACH)),
            outbox.pending(),
        )
    }

    @Test
    fun disable_while_unpaired_records_no_membership_change() {
        val vm = vm()
        optIn(vm) // no session → no sync, but the worker is scheduled
        assertEquals(WorkInfo.State.ENQUEUED, workInfos()[0].state)

        vm.disable()

        assertFalse(settings.healthConnectEnabled)
        assertEquals(WorkInfo.State.CANCELLED, workInfos()[0].state)
        assertTrue(outbox.pending().isEmpty())
        assertEquals(0, server.requestCount)
    }

    // ── refresh ──────────────────────────────────────────────────────

    @Test
    fun refresh_snapshots_availability_and_grants() {
        val reader = FakeStatusReader(
            availability = HealthConnectAvailability.NotInstalled,
            granted = emptySet(),
        )
        val vm = vm(reader = reader)
        assertEquals(HealthConnectAvailability.NotInstalled, vm.state.value.availability)

        reader.availability = HealthConnectAvailability.Available
        reader.granted = HealthTypeCatalog.allPermissionsToRequest
        vm.refresh()

        assertEquals(HealthConnectAvailability.Available, vm.state.value.availability)
        assertEquals(
            HealthTypeCatalog.allPermissionsToRequest.size,
            vm.state.value.grantedPermissions,
        )
    }
}
