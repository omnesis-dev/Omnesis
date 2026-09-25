// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.AnalyticsColumn
import dev.omnesis.android.transport.dto.AnalyticsIngestBody
import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.SourceFamilyBody
import dev.omnesis.android.transport.dto.SyncStateBody
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Wire contract for the structured-source push surface, against the gateway's
 * zod schema (`analyticsIngestBody`): `{ tableName, records, schema?, sourceId?,
 * deletedIds? }` → `{ ingested, deleted }`, plus the opaque sync-state cursor.
 * Mirrors the iOS `GatewayClientTests.testAnalyticsIngestSendsSchemaAndRecords`.
 */
class AnalyticsClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() =
        AnalyticsClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private val schema = AnalyticsTableSchema(
        tableName = "hc_body",
        displayName = "Body Measurements",
        description = "Weight, height, body fat.",
        columns = listOf(
            AnalyticsColumn("id", "VARCHAR", "Health Connect record id"),
            AnalyticsColumn("value", "DOUBLE", "Reading", nullable = true),
        ),
        primaryKey = listOf("id"),
    )

    @Test
    fun ingest_sends_schema_records_and_source_id() = runTest {
        server.enqueue(MockResponse().setBody("""{"ingested":2,"deleted":0}"""))

        val response = client().ingest(
            AnalyticsIngestBody(
                tableName = "hc_body",
                records = listOf(
                    buildJsonObject {
                        put("id", "rec-1")
                        put("value", 72.4)
                        put("metadata", JsonNull)
                    }.toMap(),
                    buildJsonObject {
                        put("id", "rec-2")
                        put("value", 74.0)
                    }.toMap(),
                ),
                schema = schema,
                sourceId = "health-connect:local",
            ),
        )
        assertEquals(2, response.ingested)
        assertEquals(0, response.deleted)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/analytics/ingest", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))

        val body = OmnesisJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("hc_body", body["tableName"]!!.jsonPrimitive.content)
        assertEquals("health-connect:local", body["sourceId"]!!.jsonPrimitive.content)
        // `deletedIds` is absent (explicitNulls=false), matching the optional zod field.
        assertNull(body["deletedIds"])

        val records = body["records"]!!.jsonArray
        assertEquals(2, records.size)
        val first = records[0].jsonObject
        assertEquals("rec-1", first["id"]!!.jsonPrimitive.content)
        assertEquals(72.4, first["value"]!!.jsonPrimitive.content.toDouble(), 1e-9)
        // Explicit JSON null survives in records (column-level null, not a dropped field).
        assertTrue(first["metadata"] is JsonNull)

        val schemaJson = body["schema"]!!.jsonObject
        assertEquals("hc_body", schemaJson["tableName"]!!.jsonPrimitive.content)
        assertEquals("id", schemaJson["primaryKey"]!!.jsonArray[0].jsonPrimitive.content)
        val valueCol = schemaJson["columns"]!!.jsonArray[1].jsonObject
        assertEquals(true, valueCol["nullable"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun ingest_sends_tombstones_and_decodes_deleted_count() = runTest {
        server.enqueue(MockResponse().setBody("""{"ingested":0,"deleted":2}"""))

        val response = client().ingest(
            AnalyticsIngestBody(
                tableName = "hc_body",
                records = emptyList(),
                sourceId = "health-connect:local",
                deletedIds = listOf("gone-1", "gone-2"),
            ),
        )
        assertEquals(2, response.deleted)

        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        val ids = body["deletedIds"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("gone-1", "gone-2"), ids)
        assertEquals(0, body["records"]!!.jsonArray.size)
        // No fan-out column requested → field absent → gateway deletes by primary key.
        assertNull(body["deleteKeyColumn"])
    }

    @Test
    fun ingest_sends_delete_key_column_for_fanned_out_rows() = runTest {
        server.enqueue(MockResponse().setBody("""{"ingested":0,"deleted":4}"""))

        client().ingest(
            AnalyticsIngestBody(
                tableName = "hc_vitals",
                records = emptyList(),
                deletedIds = listOf("hr-record-1"),
                deleteKeyColumn = "record_id",
            ),
        )

        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("record_id", body["deleteKeyColumn"]!!.jsonPrimitive.content)
    }

    @Test
    fun ingest_tolerates_legacy_response_without_deleted_field() = runTest {
        // An older gateway replies `{ingested}` only — the client must not crash.
        server.enqueue(MockResponse().setBody("""{"ingested":1}"""))
        val response = client().ingest(
            AnalyticsIngestBody(tableName = "hc_body", records = emptyList()),
        )
        assertEquals(1, response.ingested)
        assertEquals(0, response.deleted)
    }

    @Test
    fun get_sync_state_returns_cursor_and_percent_encodes_nothing_extra() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"cursor":{"tokens":{"Steps":"tok-a"}},"lastSyncedAt":"2026-06-01T00:00:00Z"}""",
            ),
        )
        val state = client().getSyncState("health-connect:local")!!
        assertEquals("2026-06-01T00:00:00Z", state.lastSyncedAt)
        assertEquals(
            "tok-a",
            state.cursor!!.jsonObject["tokens"]!!.jsonObject["Steps"]!!.jsonPrimitive.content,
        )

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/sync-state/health-connect:local", req.path)
    }

    @Test
    fun get_sync_state_maps_404_to_null() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        assertNull(client().getSyncState("health-connect:local"))
    }

    @Test
    fun set_sync_state_posts_cursor_with_label_and_icon() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().setSyncState(
            "health-connect:local",
            SyncStateBody(
                cursor = buildJsonObject { put("cycleIndex", 3) },
                label = "Health Connect",
                icon = "data:image/svg+xml;base64,Zm9v",
            ),
        )
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/sync-state/health-connect:local", req.path)
        val body = OmnesisJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(3, body["cursor"]!!.jsonObject["cycleIndex"]!!.jsonPrimitive.content.toInt())
        assertEquals("Health Connect", body["label"]!!.jsonPrimitive.content)
    }

    /**
     * A phone-hosted source has no provider package, so what this request
     * carries is the whole of its type's declared identity. A family field
     * that never reaches the body leaves a client grouping the corpus by type
     * with the raw source id to show.
     */
    @Test
    fun set_sync_state_sends_the_declared_family_identity() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().setSyncState(
            "health-connect:local",
            SyncStateBody(
                cursor = buildJsonObject { put("cycleIndex", 3) },
                label = "Health Connect",
                icon = "data:image/svg+xml;base64,Zm9v",
                family =
                    SourceFamilyBody(
                        label = "Health Connect",
                        icon = "data:image/svg+xml;base64,Zm9v",
                    ),
            ),
        )
        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        val family = body["family"]!!.jsonObject
        assertEquals("Health Connect", family["label"]!!.jsonPrimitive.content)
        assertEquals("data:image/svg+xml;base64,Zm9v", family["icon"]!!.jsonPrimitive.content)
    }

    /**
     * A source that declares no family sends none, rather than an empty object
     * the gateway would have to tell apart from a real declaration.
     */
    @Test
    fun set_sync_state_omits_the_family_when_none_is_declared() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().setSyncState(
            "health-connect:local",
            SyncStateBody(cursor = buildJsonObject { put("cycleIndex", 3) }),
        )
        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertNull(body["family"])
    }
}

/** `buildJsonObject {}` produces a JsonObject; ingest records are plain maps. */
private fun JsonObject.toMap(): Map<String, kotlinx.serialization.json.JsonElement> = this
