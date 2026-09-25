// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.http.GatewayHttp
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PermissionHealthCoordinatorTest {

    private class Reporter(
        var active: Boolean = true,
        override val sourceId: String = "fictional-source:local",
    ) : PermissionHealthReporter {
        override val enabled get() = active
        override suspend fun permissionHealth(nowMillis: Long) = PermissionHealthSnapshot(
            checkedAt = nowMillis,
            capabilities = listOf(
                PermissionCapability(
                    "required", "Fictional permission", PermissionCapabilityState.PERMISSION_DEGRADED,
                    PermissionRequirement.REQUIRED, repairAction = PermissionRepairAction.OPEN_SOURCE_SETTINGS,
                ),
            ),
        )
    }

    /**
     * Counts permission-health PUTs by source id and source-list reads. The
     * ids in [missing] are answered 404 with [missingBody]; the source list is
     * [sourcesJson].
     */
    private class CountingGateway(
        private val missing: Set<String> = emptySet(),
        private val missingBody: String = """{"error":"source not found"}""",
        private val sourcesJson: String = """{"items":[]}""",
    ) : Dispatcher() {
        val puts = ConcurrentHashMap<String, AtomicInteger>()
        val sourceLists = AtomicInteger()
        var beforeAnswer: (String) -> Unit = {}

        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path.orEmpty()
            if (request.method == "GET" && path.substringBefore('?') == "/admin/sources") {
                sourceLists.incrementAndGet()
                return MockResponse().setBody(sourcesJson)
            }
            val sourceId = path.removePrefix("/admin/sources/").substringBefore("/").replace("%3A", ":")
            puts.getOrPut(sourceId) { AtomicInteger() }.incrementAndGet()
            beforeAnswer(sourceId)
            return if (sourceId in missing) {
                MockResponse().setResponseCode(404).setBody(missingBody)
            } else {
                MockResponse().setBody("""{"ok":true}""")
            }
        }

        fun count(sourceId: String): Int = puts[sourceId]?.get() ?: 0
    }

    private fun MockWebServer.admin() = AdminClient(GatewayHttp(OkHttpClient(), url("/").toString(), "tok"))

    @Test fun requests_made_before_a_run_starts_share_it() = runTest {
        val gateway = CountingGateway()
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        try {
            val alpha = Reporter(sourceId = "alpha:local")
            val beta = Reporter(sourceId = "beta:local")
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator({ listOf(alpha, beta) }, { admin }, TestScope(testScheduler))

            // Screens and workers asking in the same moment, before any run has started.
            repeat(6) { coordinator.refresh() }
            coordinator.refreshNow()

            assertEquals(1, gateway.count(alpha.sourceId))
            assertEquals(1, gateway.count(beta.sourceId))
        } finally { server.shutdown() }
    }

    @Test fun requests_made_while_a_run_is_on_the_wire_get_exactly_one_more_run() = runBlocking {
        val firstAnswerHeld = CountDownLatch(1)
        val release = CountDownLatch(1)
        val gateway = CountingGateway().apply {
            beforeAnswer = { id ->
                if (id == "alpha:local") {
                    firstAnswerHeld.countDown()
                    release.await(5, TimeUnit.SECONDS)
                }
            }
        }
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val alpha = Reporter(sourceId = "alpha:local")
            val beta = Reporter(sourceId = "beta:local")
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator({ listOf(alpha, beta) }, { admin }, scope)

            val first = coordinator.refresh()
            assertTrue(firstAnswerHeld.await(5, TimeUnit.SECONDS))
            val duringRun = List(6) { coordinator.refresh() }
            release.countDown()
            (duringRun + first).joinAll()

            assertEquals("one run, then one more for everything asked during it", 2, gateway.count(alpha.sourceId))
            assertEquals(2, gateway.count(beta.sourceId))
            assertEquals(listOf(alpha.sourceId, beta.sourceId), coordinator.state.value.map { it.sourceId })
        } finally {
            scope.cancel()
            server.shutdown()
        }
    }

    @Test fun a_source_turned_on_while_a_foreground_run_is_reporting_is_reported_by_the_run_after_it() = runBlocking {
        val alphaHeld = CountDownLatch(1)
        val release = CountDownLatch(1)
        val gateway = CountingGateway().apply {
            beforeAnswer = { id ->
                if (id == "alpha:local") {
                    alphaHeld.countDown()
                    release.await(5, TimeUnit.SECONDS)
                }
            }
        }
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val photos = Reporter(active = false, sourceId = "photos:local")
            val alpha = Reporter(sourceId = "alpha:local")
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator({ listOf(photos, alpha) }, { admin }, scope)

            val foreground = coordinator.refresh()
            assertTrue(alphaHeld.await(5, TimeUnit.SECONDS))
            // Photos' opt-in completes while that run is past Photos and reporting another source.
            photos.active = true
            coordinator.resetReporting()
            val afterOptIn = coordinator.refresh()
            release.countDown()
            listOf(foreground, afterOptIn).joinAll()

            assertEquals("Photos is reported once it is on", 1, gateway.count(photos.sourceId))
            assertTrue(coordinator.state.value.any { it.sourceId == photos.sourceId })
        } finally {
            scope.cancel()
            server.shutdown()
        }
    }

    @Test fun a_stale_opt_in_the_gateway_never_registered_for_this_phone_is_turned_off() = runTest {
        // A phone paired to a new gateway with Activity Segments still on locally from before, never registered there.
        val activity = "android-activity-segments:local"
        val gateway = CountingGateway(missing = setOf(activity))
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        try {
            val reporter = Reporter(sourceId = activity)
            val forgotten = mutableListOf<String>()
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator(
                { listOf(reporter) }, { admin }, TestScope(testScheduler),
                deviceId = { "phone-58" },
                forgetSource = { id ->
                    forgotten += id
                    reporter.active = false
                },
            )

            coordinator.refreshNow()
            assertEquals(listOf(activity), forgotten)
            assertEquals("one look at the source list", 1, gateway.sourceLists.get())

            repeat(3) { coordinator.refreshNow() }
            assertEquals("the stale source is never reported again", 1, gateway.count(activity))
            assertTrue(coordinator.state.value.isEmpty())
        } finally { server.shutdown() }
    }

    @Test fun a_source_this_phone_does_host_is_reported_again_once_and_never_turned_off() = runTest {
        val gateway = CountingGateway(
            missing = setOf("shared:local"),
            sourcesJson = """{"items":[{"id":"shared:local","type":"shared","deviceId":"phone-58"}]}""",
        )
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        try {
            val reporter = Reporter(sourceId = "shared:local")
            val forgotten = mutableListOf<String>()
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator(
                { listOf(reporter) }, { admin }, TestScope(testScheduler),
                deviceId = { "phone-58" },
                forgetSource = { forgotten += it },
            )

            repeat(4) { coordinator.refreshNow() }

            assertTrue(forgotten.isEmpty())
            assertEquals("reported again once after the check, then left alone", 2, gateway.count("shared:local"))
            assertEquals(1, gateway.sourceLists.get())
        } finally { server.shutdown() }
    }

    @Test fun a_404_from_a_gateway_without_permission_health_only_stops_reporting() = runTest {
        val gateway = CountingGateway(missing = setOf("known:local"), missingBody = """{"error":"not found"}""")
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        try {
            val reporter = Reporter(sourceId = "known:local")
            val forgotten = mutableListOf<String>()
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator(
                { listOf(reporter) }, { admin }, TestScope(testScheduler),
                deviceId = { "phone-58" },
                forgetSource = { forgotten += it },
            )

            repeat(3) { coordinator.refreshNow() }

            assertTrue(forgotten.isEmpty())
            assertEquals(0, gateway.sourceLists.get())
            assertEquals(1, gateway.count("known:local"))
            assertEquals(1, coordinator.state.value.single().actionable.size)
        } finally { server.shutdown() }
    }

    @Test fun a_404_stops_reporting_that_source_until_its_registration_may_have_changed() = runTest {
        val gateway = CountingGateway(missing = setOf("missing:local"))
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        try {
            val missing = Reporter(sourceId = "missing:local")
            val known = Reporter(sourceId = "known:local")
            val admin = server.admin()
            val coordinator = PermissionHealthCoordinator({ listOf(missing, known) }, { admin }, TestScope(testScheduler))

            repeat(3) { coordinator.refreshNow() }
            coordinator.refreshSource(missing.sourceId)

            assertEquals("a 404 is not retried", 1, gateway.count(missing.sourceId))
            assertEquals(3, gateway.count(known.sourceId))
            assertEquals(
                "the unregistered source's local remediation stays visible",
                listOf(known.sourceId, missing.sourceId),
                coordinator.state.value.map { it.sourceId },
            )

            coordinator.resetReporting()
            coordinator.refreshNow()
            assertEquals(2, gateway.count(missing.sourceId))
        } finally { server.shutdown() }
    }

    @Test fun a_new_session_or_turning_the_source_back_on_reports_it_again() = runTest {
        val gateway = CountingGateway(missing = setOf("missing:local"))
        val server = MockWebServer().also { it.dispatcher = gateway; it.start() }
        try {
            val missing = Reporter(sourceId = "missing:local")
            var admin = server.admin()
            val coordinator = PermissionHealthCoordinator({ listOf(missing) }, { admin }, TestScope(testScheduler))

            coordinator.refreshNow()
            coordinator.refreshNow()
            assertEquals(1, gateway.count(missing.sourceId))

            admin = server.admin()
            coordinator.refreshNow()
            assertEquals("a new session starts with nothing ruled out", 2, gateway.count(missing.sourceId))

            missing.active = false
            coordinator.refreshNow()
            missing.active = true
            coordinator.refreshNow()
            assertEquals("turning the source back on goes through registration again", 3, gateway.count(missing.sourceId))
        } finally { server.shutdown() }
    }

    @Test fun old_gateway_404_keeps_local_remediation_visible() = runTest {
        val server = MockWebServer().also { it.start(); it.enqueue(MockResponse().setResponseCode(404)) }
        try {
            val reporter = Reporter()
            val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
            val coordinator = PermissionHealthCoordinator({ listOf(reporter) }, { admin }, TestScope(testScheduler))
            coordinator.refreshNow()
            assertEquals(1, coordinator.state.value.single().actionable.size)
        } finally { server.shutdown() }
    }

    @Test fun disabled_source_does_not_report_and_removes_local_alert() = runTest {
        val server = MockWebServer().also { it.start() }
        try {
            val reporter = Reporter(active = false)
            val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
            val coordinator = PermissionHealthCoordinator({ listOf(reporter) }, { admin }, TestScope(testScheduler))
            coordinator.refreshNow()
            assertTrue(coordinator.state.value.isEmpty())
            assertEquals(0, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun disabling_after_a_report_removes_the_entry_without_retracting_as_healthy() = runTest {
        val server = MockWebServer().also {
            it.start()
            it.enqueue(MockResponse().setBody("""{"ok":true}"""))
        }
        try {
            val reporter = Reporter()
            val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
            val coordinator = PermissionHealthCoordinator({ listOf(reporter) }, { admin }, TestScope(testScheduler))
            coordinator.refreshNow()
            assertEquals(1, server.requestCount)
            reporter.active = false
            coordinator.refreshSource(reporter.sourceId)
            assertTrue(coordinator.state.value.isEmpty())
            assertEquals(1, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun unknown_is_not_presented_as_permission_remediation() {
        val entry = PermissionHealthEntry(
            "fictional-source:local",
            PermissionHealthSnapshot(
                1,
                capabilities = listOf(
                    PermissionCapability(
                        "check", "Permission check", PermissionCapabilityState.UNKNOWN,
                        PermissionRequirement.REQUIRED, repairAction = PermissionRepairAction.NONE,
                    ),
                ),
            ),
        )
        assertTrue(entry.actionable.isEmpty())
    }

    @Test fun reporter_cancellation_is_never_converted_to_best_effort_failure() = runTest {
        val reporter = object : PermissionHealthReporter {
            override val sourceId = "fictional-source:local"
            override val enabled = true
            override suspend fun permissionHealth(nowMillis: Long): PermissionHealthSnapshot {
                throw CancellationException("cancelled")
            }
        }
        val coordinator = PermissionHealthCoordinator({ listOf(reporter) }, { null }, TestScope(testScheduler))
        try {
            coordinator.refreshNow()
            throw AssertionError("Expected cancellation")
        } catch (_: CancellationException) {
            // Expected: structured cancellation must escape the best-effort layer.
        }
    }
}
