// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.os.RemoteException
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.health.connect.client.units.Mass
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.transport.RefusalPolicy
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.SkippedPush
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.Instant
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The coordinator's gateway contract, exercised end-to-end: a real
 * [AnalyticsClient]/[AdminClient] against MockWebServer on one side, the
 * androidx [FakeHealthConnectClient] under [HealthConnectSource] on the other.
 * All fixture values invented.
 */
class HealthSyncCoordinatorTest {

    private lateinit var server: MockWebServer
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private val fixedNow = Instant.parse("2030-01-01T00:00:00Z")
    private val t0 = Instant.parse("2026-06-10T08:00:00Z")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        events.clear()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun grantAllFake() =
        FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = true))

    private fun enabledSettings() =
        HealthSettings(InMemoryKeyValueStore()).apply { healthConnectEnabled = true }

    private fun coordinator(
        fake: HealthConnectClient,
        settings: HealthSettings = enabledSettings(),
        availability: HealthConnectAvailability = HealthConnectAvailability.Available,
        now: Instant = fixedNow,
    ): HealthSyncCoordinator {
        val http = GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")
        return HealthSyncCoordinator(
            sourceFactory = {
                HealthConnectSource(
                    client = fake,
                    accountId = HealthConnectSource.ACCOUNT_ID_LOCAL,
                    selfPackageName = "dev.omnesis.android",
                    settings = settings,
                    clock = { fixedNow },
                )
            },
            analytics = AnalyticsClient(http),
            settings = settings,
            availability = { availability },
            sendEvent = { type, payload -> synchronized(events) { events += type to payload } },
            clock = { now },
        )
    }

    private fun weight(kg: Double, at: Instant = t0) = WeightRecord(
        time = at,
        zoneOffset = null,
        weight = Mass.kilograms(kg),
        metadata = Metadata.manualEntry(),
    )

    private fun steps(count: Long, start: Instant = t0) =
        androidx.health.connect.client.records.StepsRecord(
            startTime = start,
            startZoneOffset = null,
            endTime = start.plusSeconds(3600),
            endZoneOffset = null,
            count = count,
            metadata = Metadata.manualEntry(),
        )

    private fun body(request: RecordedRequest): JsonObject =
        OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject

    private fun eventStates(): List<String> =
        synchronized(events) { events.map { it.second["state"]!!.jsonPrimitive.content } }

    private fun enqueueOk(json: String = """{"ok":true}""") {
        server.enqueue(MockResponse().setBody(json))
    }

    // ── registration ──────────────────────────────────────────────────



    @Test
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun ordinary_startup_never_admin_registers_an_enabled_source() = runTest {
        val settings = enabledSettings()
        val reader = object : dev.omnesis.android.feature.health.di.HealthConnectStatusReader {
            override fun availability() = HealthConnectAvailability.NotInstalled
            override suspend fun grantedPermissions(): Set<String> = emptySet()
        }
        val integration = HealthIntegration(android.content.ContextWrapper(null), settings, reader)
        integration.launchInitialSync(coordinator(grantAllFake(), settings, HealthConnectAvailability.NotInstalled), this)
        advanceUntilIdle()
        assertEquals(0, server.requestCount)
        assertTrue(settings.healthConnectEnabled)
    }

    // ── happy path: 404 → baseline, label+icon on the state write ─────

    @Test
    fun first_sync_baselines_from_404_and_persists_cursor_with_label_and_icon() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        fake.insertRecords(listOf(steps(8200)))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk()

        val result = coordinator(fake).syncNow()

        assertEquals(HealthSyncCoordinator.SyncResult.Success(2), result)
        assertEquals(4, server.requestCount)

        val get = server.takeRequest()
        assertEquals("GET", get.method)
        assertEquals("/sync-state/health-connect:local", get.path)

        // Catalog order: Weight (hc_body) pages before Steps (hc_activity).
        val ingestBody = body(server.takeRequest())
        assertEquals("hc_body", ingestBody["tableName"]!!.jsonPrimitive.content)
        assertEquals("health-connect:local", ingestBody["sourceId"]!!.jsonPrimitive.content)
        assertEquals(1, ingestBody["records"]!!.jsonArray.size)
        assertEquals("hc_body", ingestBody["schema"]!!.jsonObject["tableName"]!!.jsonPrimitive.content)
        assertNull(ingestBody["deletedIds"])
        assertNull(ingestBody["deleteKeyColumn"])

        val ingestActivity = body(server.takeRequest())
        assertEquals("hc_activity", ingestActivity["tableName"]!!.jsonPrimitive.content)
        assertEquals("hc_activity", ingestActivity["schema"]!!.jsonObject["tableName"]!!.jsonPrimitive.content)

        val setState = server.takeRequest()
        assertEquals("POST", setState.method)
        assertEquals("/sync-state/health-connect:local", setState.path)
        val state = body(setState)
        assertEquals("Health Connect", state["label"]!!.jsonPrimitive.content)
        assertEquals(HEALTH_CONNECT_ICON_DATA_URI, state["icon"]!!.jsonPrimitive.content)
        val tokens = state["cursor"]!!.jsonObject["tokens"]!!.jsonObject
        for (entry in HealthTypeCatalog.entries) {
            assertNotNull("missing token for ${entry.name}", tokens[entry.name])
        }
        assertNotNull(state["cursor"]!!.jsonObject["lastFullSyncAt"])

        // sync.status sequence: syncing → completed, iOS field names.
        assertEquals(listOf("syncing", "completed"), eventStates())
        val syncing = events[0].second
        assertEquals("health-connect:local", syncing["sourceId"]!!.jsonPrimitive.content)
        assertEquals(fixedNow.toEpochMilli().toString(), syncing["startedAt"]!!.jsonPrimitive.content)
        val completed = events[1].second
        assertEquals("health-connect:local", completed["sourceId"]!!.jsonPrimitive.content)
        assertEquals(fixedNow.toEpochMilli().toString(), completed["completedAt"]!!.jsonPrimitive.content)
        assertEquals("2", completed["progress"]!!.jsonObject["processed"]!!.jsonPrimitive.content)
    }

    // ── delta: cursor round-trips, tombstones carry the delete key ────

    @Test
    fun provider_read_failure_reports_error_after_saving_healthy_progress_and_recovers() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(68.0), steps(2500)))
        var failWeight = true
        val client = object : HealthConnectClient by fake {
            override suspend fun getChangesToken(request: ChangesTokenRequest): String {
                if (failWeight && WeightRecord::class in request.recordTypes) {
                    throw RemoteException("Provider read failed")
                }
                return fake.getChangesToken(request)
            }
        }
        val c = coordinator(client)
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk()

        val failed = c.syncNow()
        assertTrue(failed is HealthSyncCoordinator.SyncResult.Failed)
        failed as HealthSyncCoordinator.SyncResult.Failed
        assertTrue(failed.retryable)
        assertEquals(HealthSyncCoordinator.FailureOrigin.SOURCE_READ, failed.origin)
        assertTrue(failed.message.contains("Weight"))
        assertEquals(listOf("syncing", "error"), eventStates())
        assertEquals("1", events.last().second["progress"]!!.jsonObject["processed"]!!.jsonPrimitive.content)
        server.takeRequest()
        assertEquals("hc_activity", body(server.takeRequest())["tableName"]!!.jsonPrimitive.content)
        val partialCursor = body(server.takeRequest())["cursor"]!!
        val parsed = HealthCursor.fromJsonElement(partialCursor)
        assertNull(parsed.tokenFor("Weight"))
        assertNotNull(parsed.tokenFor("Steps"))
        assertNull(parsed.lastFullSyncAt)

        failWeight = false
        enqueueOk(buildJsonObject { put("cursor", partialCursor) }.toString())
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk()
        assertEquals(HealthSyncCoordinator.SyncResult.Success(1), c.syncNow())
        assertEquals(listOf("syncing", "error", "syncing", "completed"), eventStates())
        server.takeRequest()
        assertEquals("hc_body", body(server.takeRequest())["tableName"]!!.jsonPrimitive.content)
        val recovered = HealthCursor.fromJsonElement(body(server.takeRequest())["cursor"])
        assertNotNull(recovered.tokenFor("Weight"))
        assertNotNull(recovered.lastFullSyncAt)
    }

    @Test
    fun delivery_retry_reports_local_read_failure_without_claiming_gateway_unreachable() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(steps(1700)))
        val client = object : HealthConnectClient by fake {
            override suspend fun getChangesToken(request: ChangesTokenRequest): String {
                if (WeightRecord::class in request.recordTypes) throw RemoteException("Provider read failed")
                return fake.getChangesToken(request)
            }
        }
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk()

        assertEquals(RetryOutcome.INCOMPLETE, coordinator(client).retryDelivery())
        assertEquals(listOf("syncing", "error"), eventStates())
        assertEquals(3, server.requestCount)
        server.takeRequest()
        assertEquals("hc_activity", body(server.takeRequest())["tableName"]!!.jsonPrimitive.content)
        assertEquals("/sync-state/health-connect:local", server.takeRequest().path)
    }

    @Test
    fun delta_sync_round_trips_the_cursor_and_sends_tombstones() = runTest {
        val fake = grantAllFake()
        val ids = fake.insertRecords(listOf(weight(70.0), weight(70.4, t0.plusSeconds(3600)))).recordIdsList

        // Pass 1: baseline.
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":2,"deleted":0}""")
        enqueueOk()
        val c = coordinator(fake)
        assertEquals(HealthSyncCoordinator.SyncResult.Success(2), c.syncNow())
        server.takeRequest() // GET
        server.takeRequest() // ingest
        val persistedCursor = body(server.takeRequest())["cursor"]!!

        // Pass 2: the gateway hands the persisted cursor back; one record was deleted.
        fake.deleteRecords(WeightRecord::class, recordIdsList = listOf(ids[0]), clientRecordIdsList = emptyList())
        enqueueOk("""{"cursor":$persistedCursor,"lastSyncedAt":"2026-06-10T09:00:00Z"}""")
        enqueueOk("""{"ingested":0,"deleted":1}""")
        enqueueOk()

        assertEquals(HealthSyncCoordinator.SyncResult.Success(1), c.syncNow())

        server.takeRequest() // GET
        val ingest = body(server.takeRequest())
        assertEquals("hc_body", ingest["tableName"]!!.jsonPrimitive.content)
        assertEquals(0, ingest["records"]!!.jsonArray.size)
        assertEquals(
            listOf(ids[0]),
            ingest["deletedIds"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals("record_id", ingest["deleteKeyColumn"]!!.jsonPrimitive.content)
        // Tokens advanced → the new cursor is written.
        val rewrite = server.takeRequest()
        assertEquals("POST", rewrite.method)
        assertEquals("/sync-state/health-connect:local", rewrite.path)
        assertNotNull(body(rewrite)["cursor"])

        assertEquals(listOf("syncing", "completed", "syncing", "completed"), eventStates())
        assertEquals(
            "1",
            events[3].second["progress"]!!.jsonObject["processed"]!!.jsonPrimitive.content,
        )
    }

    // ── sync-state write elision ──────────────────────────────────────

    @Test
    fun unchanged_cursor_with_existing_state_elides_the_write() = runTest {
        // No permission granted anywhere → every type skips, cursor untouched.
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = false))
        enqueueOk("""{"cursor":{},"lastSyncedAt":"2026-06-01T00:00:00Z"}""")

        val result = coordinator(fake).syncNow()

        assertEquals(HealthSyncCoordinator.SyncResult.Success(0), result)
        // Only the GET — no ingest, and crucially no sync-state POST.
        assertEquals(1, server.requestCount)
        assertEquals("GET", server.takeRequest().method)
        assertEquals(listOf("syncing", "completed"), eventStates())
    }

    @Test
    fun first_pass_writes_the_state_even_when_everything_skipped() = runTest {
        // Same all-skip drain, but no pre-existing sync-state row: the write
        // happens so the gateway learns the source's label/icon.
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = false))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk()

        val result = coordinator(fake).syncNow()

        assertEquals(HealthSyncCoordinator.SyncResult.Success(0), result)
        assertEquals(2, server.requestCount)
        server.takeRequest()
        val state = body(server.takeRequest())
        assertEquals("Health Connect", state["label"]!!.jsonPrimitive.content)
        assertEquals(HEALTH_CONNECT_ICON_DATA_URI, state["icon"]!!.jsonPrimitive.content)
    }

    // ── failure: partial cursor persists before the error surfaces ────

    @Test
    fun mid_sync_failure_persists_the_partial_cursor_before_surfacing() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        fake.insertRecords(listOf(steps(8200)))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""") // hc_body page lands
        server.enqueue(MockResponse().setResponseCode(500).setBody("boom")) // hc_activity page dies
        enqueueOk() // the partial-cursor persist

        val result = coordinator(fake).syncNow()

        assertEquals(HealthSyncCoordinator.SyncResult.Failed("server error 500", retryable = true), result)
        assertEquals(4, server.requestCount)
        server.takeRequest() // GET
        server.takeRequest() // ingest hc_body
        server.takeRequest() // ingest hc_activity (500)
        val persist = server.takeRequest()
        assertEquals("POST", persist.method)
        assertEquals("/sync-state/health-connect:local", persist.path)
        val tokens = body(persist)["cursor"]!!.jsonObject["tokens"]!!.jsonObject
        // Weight finished before the failure — its token is on the persisted
        // cursor. Steps was mid-flight — no token, the next pass re-reads it.
        assertNotNull(tokens["Weight"])
        assertNull(tokens["Steps"])

        assertEquals(listOf("syncing", "error"), eventStates())
        val error = events[1].second
        assertEquals("health-connect:local", error["sourceId"]!!.jsonPrimitive.content)
        assertTrue(error["errorMessage"]!!.jsonPrimitive.content.isNotBlank())
    }

    @Test
    fun unauthorized_maps_to_needs_attention() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}""")) // persist attempt

        val result = coordinator(fake).syncNow()

        assertTrue("expected NeedsAttention, got $result", result is HealthSyncCoordinator.SyncResult.NeedsAttention)
        assertEquals(listOf("syncing", "error"), eventStates())
    }

    // ── giving up on a unit the gateway will never accept ─────────────

    /**
     * One pass whose first page — Weight's baseline, the first catalog entry
     * with data — the gateway answers with [status]. The trailing OK is the
     * partial-cursor persist the aborted pass does on its way out.
     */
    private suspend fun refusedPass(
        fake: FakeHealthConnectClient,
        settings: HealthSettings,
        at: Instant,
        status: Int = 400,
    ): HealthSyncCoordinator.SyncResult {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":"refused"}"""))
        enqueueOk()
        return coordinator(fake, settings, now = at).syncNow()
    }

    /** A cursor's token for [typeName], or null — an all-empty `tokens` map is omitted from the JSON. */
    private fun tokenFor(cursor: JsonObject, typeName: String) =
        cursor["tokens"]?.jsonObject?.get(typeName)

    /** Every cursor written back to `/sync-state` so far. Drains the recorded requests. */
    private fun persistedCursors(): List<JsonObject> {
        val cursors = mutableListOf<JsonObject>()
        repeat(server.requestCount) {
            val request = server.takeRequest()
            if (request.method == "POST" && request.path == "/sync-state/health-connect:local") {
                cursors += body(request)["cursor"]!!.jsonObject
            }
        }
        return cursors
    }

    @Test
    fun a_refused_type_is_skipped_once_the_budget_and_grace_are_spent_and_the_rest_of_the_catalog_syncs() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        fake.insertRecords(listOf(steps(8200)))
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS) {
            val result = refusedPass(fake, settings, fixedNow)
            assertEquals(HealthSyncCoordinator.SyncResult.Failed("server error 400", retryable = false), result)
        }

        // The budget is spent but the grace window is not: a fix on the gateway
        // has not had its chance yet, so nothing is skipped and Weight's token
        // never appears on a persisted cursor.
        assertEquals(RefusalPolicy.MAX_REFUSALS, settings.pushRefusals.openRun?.count)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"refused"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""") // Steps, the type behind the refused one
        enqueueOk()

        val result = coordinator(fake, settings, now = fixedNow.plus(RefusalPolicy.GRACE)).syncNow()

        // The pass no longer dies at Weight: Weight is skipped and Steps — which
        // had starved behind it on every earlier pass — syncs.
        assertEquals(HealthSyncCoordinator.SyncResult.Success(1), result)
        assertNull(settings.pushRefusals.openRun)
        val skipped = settings.pushRefusals.skipped.single()
        assertEquals(HealthSyncCoordinator.SOURCE_ID, skipped.sourceId)
        assertEquals("Weight — the type's full history", skipped.unit)
        assertEquals(RefusalPolicy.MAX_REFUSALS + 1, skipped.refusals)

        val cursors = persistedCursors()
        for (partial in cursors.dropLast(1)) {
            assertNull("an aborted pass must not advance Weight", tokenFor(partial, "Weight"))
        }
        val advanced = cursors.last()
        assertNotNull("Weight resumes from a token instead of re-reading its history", tokenFor(advanced, "Weight"))
        assertNotNull(tokenFor(advanced, "Steps"))
    }

    @Test
    fun an_outage_never_costs_data_however_long_it_lasts() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        val settings = enabledSettings()

        // Well past both the attempt budget and the grace window.
        repeat(RefusalPolicy.MAX_REFUSALS * 3) { attempt ->
            val at = fixedNow.plus(RefusalPolicy.GRACE.multipliedBy(attempt.toLong()))
            val result = refusedPass(fake, settings, at, status = 503)
            assertEquals(HealthSyncCoordinator.SyncResult.Failed("server error 503", retryable = true), result)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        for (cursor in persistedCursors()) {
            assertNull(tokenFor(cursor, "Weight"))
        }
    }

    @Test
    fun a_rate_limited_push_is_a_retry_not_a_verdict_on_the_payload() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        val settings = enabledSettings()

        repeat(RefusalPolicy.MAX_REFUSALS * 2) { attempt ->
            val at = fixedNow.plus(RefusalPolicy.GRACE.multipliedBy(attempt.toLong()))
            val result = refusedPass(fake, settings, at, status = 429)
            assertEquals(HealthSyncCoordinator.SyncResult.Failed("server error 429", retryable = true), result)
        }

        assertNull(settings.pushRefusals.openRun)
        assertEquals(emptyList<SkippedPush>(), settings.pushRefusals.skipped)
        for (cursor in persistedCursors()) {
            assertNull(tokenFor(cursor, "Weight"))
        }
    }

    // ── gates ─────────────────────────────────────────────────────────

    @Test
    fun disabled_settings_skip_without_touching_the_gateway() = runTest {
        val settings = HealthSettings(InMemoryKeyValueStore()) // enabled defaults to false
        val result = coordinator(grantAllFake(), settings = settings).syncNow()
        assertTrue(result is HealthSyncCoordinator.SyncResult.Skipped)
        assertEquals(0, server.requestCount)
        assertTrue(events.isEmpty())
    }

    @Test
    fun unavailable_provider_skips_without_touching_the_gateway() = runTest {
        val result = coordinator(
            grantAllFake(),
            availability = HealthConnectAvailability.NotInstalled,
        ).syncNow()
        assertTrue(result is HealthSyncCoordinator.SyncResult.Skipped)
        assertEquals(0, server.requestCount)
        assertTrue(events.isEmpty())
    }

    // ── coalescing ────────────────────────────────────────────────────

    @Test
    fun concurrent_sync_now_calls_coalesce_into_a_single_drain() = runBlocking {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        // Exactly one drain's worth of responses.
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":1,"deleted":0}""")
        enqueueOk()

        val c = coordinator(fake)
        // UNDISPATCHED runs each call up to its first suspension (the HTTP
        // await), so the second is guaranteed to land while the first drain
        // is in flight.
        val a = async(start = CoroutineStart.UNDISPATCHED) { c.syncNow() }
        val b = async(start = CoroutineStart.UNDISPATCHED) { c.syncNow() }

        val ra = a.await()
        val rb = b.await()
        assertEquals(HealthSyncCoordinator.SyncResult.Success(1), ra)
        assertEquals(ra, rb)
        assertEquals(3, server.requestCount)
        // One drain → one syncing/completed pair, not two.
        assertEquals(listOf("syncing", "completed"), eventStates())
    }

    // ── a later sync after coalescing is a fresh drain ────────────────

    @Test
    fun sequential_sync_now_calls_each_run_their_own_drain() = runTest {
        val fake = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = false))
        enqueueOk("""{"cursor":{},"lastSyncedAt":"2026-06-01T00:00:00Z"}""")
        enqueueOk("""{"cursor":{},"lastSyncedAt":"2026-06-01T00:00:00Z"}""")

        val c = coordinator(fake)
        assertEquals(HealthSyncCoordinator.SyncResult.Success(0), c.syncNow())
        assertEquals(HealthSyncCoordinator.SyncResult.Success(0), c.syncNow())
        assertEquals(2, server.requestCount)
    }

    // ── push rejection: source removed / paused in Omnesis ────────────

    @Test
    fun removed_rejection_disables_syncing_locally() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        val settings = enabledSettings()
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        // 200 + rejected: the gateway accepts the request but declines the source.
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"health-connect:local","reason":"removed"}]}""")
        // Spare OKs in case a setState slips through (it shouldn't for removed).
        enqueueOk()
        enqueueOk()

        val result = coordinator(fake, settings = settings).syncNow()

        assertEquals(
            HealthSyncCoordinator.SyncResult.SourceRemoved("Health Connect was removed in Omnesis"),
            result,
        )
        // The coordinator disabled syncing so the source stops producing.
        assertEquals(false, settings.healthConnectEnabled)
    }

    @Test
    fun paused_rejection_retains_enabled_and_is_retryable() = runTest {
        val fake = grantAllFake()
        fake.insertRecords(listOf(weight(70.0)))
        val settings = enabledSettings()
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        enqueueOk("""{"ingested":0,"rejected":[{"sourceId":"health-connect:local","reason":"paused"}]}""")
        enqueueOk()
        enqueueOk()

        val result = coordinator(fake, settings = settings).syncNow()

        assertEquals(
            HealthSyncCoordinator.SyncResult.SourcePaused("Health Connect is paused in Omnesis"),
            result,
        )
        // A pause is resumable — the source stays enabled.
        assertEquals(true, settings.healthConnectEnabled)
    }
}
