// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.PermissionCapability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.PermissionRequirement
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.activationFailureMessage
import dev.omnesis.android.transport.dto.AccessAuthorizationDecision
import dev.omnesis.android.transport.dto.AccessAuthorizationSelection
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessSourceBoundary
import dev.omnesis.android.transport.dto.AccessSourceMode
import dev.omnesis.android.transport.dto.InternalSource
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Route/shape contract for the mutating source actions (OkHttp MockWebServer). */
class AdminClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    @Test fun model_behavior_patch_binds_values_to_the_current_assignment() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveModelBehavior(
            "agent", "northstar/reasoner-v1",
            ModelBehaviorValues(reasoningEnabled = true, reasoningEffort = "high"),
        )
        server.takeRequest().also {
            assertEquals("PATCH", it.method)
            assertEquals("/admin/models/behavior/agent", it.path)
            assertEquals("Bearer tok", it.getHeader("Authorization"))
            assertEquals(
                """{"assignment":"northstar/reasoner-v1","values":{"reasoningEnabled":true,"reasoningEffort":"high"}}""",
                it.body.readUtf8(),
            )
        }
    }

    @Test fun reset_model_behavior_patch_sends_an_empty_values_object() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveModelBehavior("agent", "northstar/reasoner-v1", ModelBehaviorValues())
        assertEquals(
            """{"assignment":"northstar/reasoner-v1","values":{}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun behavior_patch_sends_the_confirmed_baseline_for_conflict_detection() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveModelBehavior(
            "agent", "northstar/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = "high"),
            expectedValues = ModelBehaviorValues(reasoningEffort = "low"),
        )
        assertEquals(
            """{"assignment":"northstar/reasoner-v1","values":{"reasoningEffort":"high"},"expectedValues":{"reasoningEffort":"low"}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun provider_logo_is_fetched_only_from_the_authenticated_gateway() = runTest {
        val svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>"""
        server.enqueue(MockResponse().setBody(svg).setHeader("Content-Type", "image/svg+xml"))
        assertEquals(svg, client().providerLogo("northstar"))
        server.takeRequest().also {
            assertEquals("/model-logos/northstar.svg", it.path)
            assertEquals("Bearer tok", it.getHeader("Authorization"))
            assertEquals("image/svg+xml", it.getHeader("Accept"))
        }
    }

    @Test fun access_authorization_lookup_and_overview_use_admin_routes() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"request":{"id":"request_example","approvalId":"approval_example","status":"pending","clientId":"client_example","clientName":"Northstar Assistant","redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp","scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false}}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"principals":[],"sources":[{"id":"notes:fictional","name":"Fictional Notes"}],"policyFamilies":[],"defaultPolicyFamilyId":null,"oauth":{"resource":"ignored"}}""",
            ),
        )
        val envelope = client().lookupAccessAuthorization("ABCD-EFGH")
        assertEquals("Northstar Assistant", envelope.request.clientName)
        assertNull(envelope.reconnect)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/admin/access/authorizations/lookup", it.path)
            assertEquals("{\"code\":\"ABCD-EFGH\"}", it.body.readUtf8())
            assertEquals("Bearer tok", it.getHeader("Authorization"))
        }
        assertEquals("notes:fictional", client().accessOverview().sources.single().id)
        assertEquals("/admin/access", server.takeRequest().path)
    }

    @Test fun access_authorization_lookup_by_id_reads_the_request_route_without_a_code() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"request":{"id":"request/example","approvalId":"approval_example","status":"pending","clientId":"client_example","clientName":"Aurora Planner","redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp","scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false},"reconnect":{"matchedBy":"name","principal":{"id":"principal_example","name":"Aurora Planner"},"grant":{"id":"grant_example","name":"Aurora Planner access","revision":1,"rules":[{"capability":"notes","sources":{"mode":"all","sourceIds":[]}}],"credentials":[]}}}""",
            ),
        )
        val envelope = client().lookupAccessAuthorizationById("request/example")
        assertEquals("Aurora Planner", envelope.request.clientName)
        assertEquals("grant_example", envelope.reconnect?.grant?.id)
        server.takeRequest().also {
            assertEquals("GET", it.method)
            assertEquals("/admin/access/authorizations/request%2Fexample", it.path)
            assertEquals("Bearer tok", it.getHeader("Authorization"))
        }

        // A request that is unknown or no longer pending is a 404, mapped like the code lookup's.
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not-found"}"""))
        val error = runCatching { client().lookupAccessAuthorizationById("request_gone") }.exceptionOrNull()
        assertTrue(error is GatewayException.NotFound)
    }

    @Test fun access_authorization_lookup_decodes_a_committed_request_for_reconciliation() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"request":{"id":"request_example","approvalId":"approval_example","status":"approved","clientId":"client_example","clientName":"Northstar Assistant","redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp","scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false}}""",
            ),
        )

        assertEquals("approved", client().lookupAccessAuthorization("ABCD-EFGH").request.status)
        assertEquals("/admin/access/authorizations/lookup", server.takeRequest().path)
    }

    @Test fun access_authorization_lookup_decodes_the_reconnect_proposal() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"request":{"id":"request_example","approvalId":"approval_example","status":"pending","clientId":"client_example","clientName":"Northstar Assistant","redirectOrigin":"http://127.0.0.1:10000","resource":"https://gateway.example.com/mcp","scope":"omnesis:access","expiresAt":2000000000000,"requiresAnswer":false},"reconnect":{"matchedBy":"name","principal":{"id":"principal_example","name":"Northstar Assistant"},"grant":{"id":"grant_example","name":"Northstar Assistant access","revision":1,"rules":[{"capability":"direct","sources":{"mode":"all","sourceIds":[]}}],"credentials":[],"createdAt":1,"updatedAt":1,"expiresAt":null,"revokedAt":null}}}""",
            ),
        )

        val reconnect = requireNotNull(client().lookupAccessAuthorization("ABCD-EFGH").reconnect)
        assertEquals("name", reconnect.matchedBy)
        assertEquals("principal_example", reconnect.principal.id)
        assertEquals(AccessSourceMode.ALL, reconnect.grant.rules.single().sources.mode)
    }

    @Test fun access_authorization_decision_encodes_dynamic_id_and_discards_envelope() = runTest {
        server.enqueue(MockResponse().setBody("""{"request":{"status":"approved"}}"""))
        client().decideAccessAuthorization(
            "approval/example",
            AccessAuthorizationDecision.Approve(
                AccessAuthorizationSelection.Connect(
                    rules = listOf(AccessGrantRule.direct(
                        AccessSourceBoundary(AccessSourceMode.ALLOWLIST, listOf("notes:fictional")),
                    )),
                    credentialLabel = "Northstar Assistant",
                ),
            ),
        )
        server.takeRequest().also {
            assertEquals("/admin/access/authorizations/approval%2Fexample/decision", it.path)
            assertEquals(
                OmnesisJson.parseToJsonElement(
                    """{"decision":"approve","selection":{"kind":"connect","credentialLabel":"Northstar Assistant","rules":[{"capability":"direct","sources":{"mode":"allowlist","sourceIds":["notes:fictional"]}}]}}""",
                ),
                OmnesisJson.parseToJsonElement(it.body.readUtf8()),
            )
        }
    }

    @Test fun access_authorization_maps_auth_not_found_and_conflict_failures() = runTest {
        listOf(401, 403, 404, 409).forEach { status ->
            server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":"invalid-selection"}"""))
            val error = runCatching { client().lookupAccessAuthorization("ABCD-EFGH") }.exceptionOrNull()
            when (status) {
                401 -> assertTrue(error is GatewayException.Unauthorized)
                403 -> assertTrue(error is GatewayException.Forbidden)
                404 -> assertTrue(error is GatewayException.NotFound)
                409 -> assertTrue(error is GatewayException.ServerError && error.body == "invalid-selection")
            }
        }
    }

    @Test
    fun permission_health_put_uses_the_strict_canonical_wire_shape() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().putPermissionHealth(
            "photos:local",
            PermissionHealthSnapshot(
                checkedAt = 123,
                validForMs = 456,
                capabilities = listOf(
                    PermissionCapability(
                        id = "library",
                        label = "Photo library",
                        state = PermissionCapabilityState.BACKGROUND_ACCESS_MISSING,
                        requirement = PermissionRequirement.OPTIONAL,
                        impact = "Updates pause in the background.",
                        remediation = "Allow background access.",
                        repairAction = PermissionRepairAction.OPEN_SOURCE_SETTINGS,
                    ),
                ),
            ),
        )
        server.takeRequest().also {
            assertEquals("PUT", it.method)
            assertEquals("/admin/sources/photos:local/permission-health", it.path)
            assertEquals(
                """{"checkedAt":123,"validForMs":456,"capabilities":[{"id":"library","label":"Photo library","state":"background-access-missing","requirement":"optional","impact":"Updates pause in the background.","remediation":"Allow background access.","repairAction":"open-source-settings"}]}""",
                it.body.readUtf8(),
            )
        }
    }

    @Test
    fun permission_health_put_includes_the_default_validity_window() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().putPermissionHealth(
            "photos:local",
            PermissionHealthSnapshot(
                checkedAt = 123,
                capabilities = emptyList(),
            ),
        )

        server.takeRequest().also {
            assertEquals(
                """{"checkedAt":123,"validForMs":21600000,"capabilities":[]}""",
                it.body.readUtf8(),
            )
        }
    }

    @Test
    fun create_source_posts_type_account_device_and_returns_record() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"health-connect:local","type":"health-connect","accountId":"local","deviceId":"d1","enabled":true}}""",
            ),
        )
        val created = client().createSource(
            type = "health-connect",
            accountId = "local",
            deviceId = "d1",
        )
        assertEquals("health-connect:local", created.id)
        assertTrue(created.enabled)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/sources", req.path)
        assertEquals(
            """{"type":"health-connect","accountId":"local","deviceId":"d1","enabled":true}""",
            req.body.readUtf8(),
        )
    }

    @Test
    fun sync_source_posts_to_sync_route_with_empty_body() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"result":{}}"""))
        client().syncSource("notes:local")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/sources/notes:local/sync", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun one_source_sync_status_uses_the_authoritative_detail_route() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"sourceId":"photos:local","state":"synced","lastSyncAt":"2026-09-03T08:00:00.000Z"}""",
            ),
        )

        val status = client().syncStatus("photos:local")

        assertEquals("photos:local", status.sourceId)
        assertEquals("synced", status.state)
        assertEquals("/admin/sync/status/photos:local", server.takeRequest().path)
    }

    @Test
    fun descriptors_read_the_cross_collector_union() = runTest {
        // One collector's own registry (`/admin/sources/descriptors`) refuses to
        // choose once a second collector is online; the union route is the same
        // registry whatever the number of hosts, and each item's `devices` is
        // left undecoded.
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"notes","name":"Notes","icon":{"sfSymbol":"note.text","color":"#ffcc00"},"devices":[{"id":"d1","name":"Host one"},{"id":"d2","name":"Host two"}]}],"hasMore":false,"limit":1}""",
            ),
        )

        val descriptors = client().descriptors()

        assertEquals(listOf("notes"), descriptors.map { it.typeId })
        assertEquals("note.text", descriptors.single().icon?.sfSymbol)
        assertEquals("/admin/source-descriptors", server.takeRequest().path)
    }

    @Test
    fun patch_source_pause_sends_enabled_false_and_returns_record() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"notes:local","type":"notes","accountId":"local","deviceId":"d1","enabled":false}}""",
            ),
        )
        val updated = client().patchSource("notes:local", enabled = false)
        assertFalse(updated.enabled)
        assertEquals("notes:local", updated.id)

        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/sources/notes:local", req.path)
        // explicitNulls=false drops `config`, so only `enabled` is on the wire.
        assertEquals("""{"enabled":false}""", req.body.readUtf8())
    }

    @Test
    fun patch_source_resume_sends_enabled_true() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"notes:local","type":"notes","enabled":true}}""",
            ),
        )
        val updated = client().patchSource("notes:local", enabled = true)
        assertTrue(updated.enabled)
        assertEquals("""{"enabled":true}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun patch_source_sends_mobile_lifecycle_fields() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"health-connect:local","type":"health-connect","deviceId":"new-phone","enabled":true,"multiDeviceMode":"partitioned"}}""",
            ),
        )
        client().patchSource(
            "health-connect:local",
            deviceId = "new-phone",
            multiDeviceMode = SourceMultiDeviceMode.PARTITIONED,
        )
        assertEquals(
            """{"deviceId":"new-phone","multiDeviceMode":"partitioned"}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test
    fun a_gateway_that_ignores_the_requested_mode_is_not_a_successful_transition() = runTest {
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos","multiDeviceMode":"exclusive"}}"""))
        val failure = runCatching {
            client().patchSource("photos:local", multiDeviceMode = SourceMultiDeviceMode.PARTITIONED)
        }.exceptionOrNull()
        assertTrue("HTTP success must not substitute for persisted mode confirmation", failure is IllegalStateException)
        assertEquals(
            "The gateway did not confirm partitioned mode. Update the gateway, then try again.",
            activationFailureMessage(failure!!, "connection failure"),
        )
    }

    @Test
    fun a_gateway_without_mode_in_its_response_cannot_activate_partitioned_storage() = runTest {
        server.enqueue(MockResponse().setBody("""{"source":{"id":"photos:local","type":"photos"}}"""))
        val failure = runCatching {
            client().patchSource("photos:local", multiDeviceMode = SourceMultiDeviceMode.PARTITIONED)
        }.exceptionOrNull()
        assertTrue("a missing acknowledgment must fail closed", failure is IllegalStateException)
        assertEquals(
            "The gateway did not confirm partitioned mode. Update the gateway, then try again.",
            activationFailureMessage(failure!!, "connection failure"),
        )
    }

    @Test
    fun remove_source_issues_delete() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().removeSource("notes:local")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/sources/notes:local", req.path)
    }

    // ── source membership + device forget ─────────────────────────────

    @Test
    fun join_source_member_posts_the_device_and_decodes_source_plus_members() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"photos:local","type":"photos","deviceId":"dev-owner","enabled":true,"members":["dev-owner","dev-phone"],"multiDeviceMode":"partitioned"},"members":["dev-owner","dev-phone"]}""",
            ),
        )
        val resp = client().joinSourceMember("photos:local", "dev-phone")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/sources/photos:local/members", req.path)
        assertEquals("""{"deviceId":"dev-phone"}""", req.body.readUtf8())
        assertEquals(listOf("dev-owner", "dev-phone"), resp.members)
        assertEquals(listOf("dev-owner", "dev-phone"), resp.source.hostDeviceIds())
        assertEquals("partitioned", resp.source.multiDeviceMode)
        assertTrue(resp.source.hosts("dev-phone"))
    }

    @Test
    fun detach_source_member_issues_delete_on_the_member_path() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"source":{"id":"photos:local","type":"photos","deviceId":"dev-owner","members":["dev-owner"]},"members":["dev-owner"]}""",
            ),
        )
        val resp = client().detachSourceMember("photos:local", "dev-phone")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/sources/photos:local/members/dev-phone", req.path)
        assertEquals(listOf("dev-owner"), resp.members)
        assertFalse(resp.source.hosts("dev-phone"))
    }

    @Test
    fun detach_surfaces_the_last_member_and_not_member_codes() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"dev-phone is the only host of photos:local","code":"LAST_MEMBER"}"""),
        )
        val last = runCatching { client().detachSourceMember("photos:local", "dev-phone") }.exceptionOrNull()
        assertEquals("LAST_MEMBER", (last as GatewayException.ServerError).code)
        assertEquals(409, last.status)

        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"device dev-phone does not host photos:local","code":"DEVICE_NOT_MEMBER"}"""),
        )
        val notMember = runCatching { client().detachSourceMember("photos:local", "dev-phone") }.exceptionOrNull()
        assertEquals("DEVICE_NOT_MEMBER", (notMember as GatewayException.ServerError).code)
    }

    @Test
    fun a_source_record_without_members_still_knows_its_owner_hosts_it() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[{"id":"photos:local","type":"photos","deviceId":"dev-phone"}]}"""))
        val row = client().sources().single()
        assertTrue(row.members.isEmpty())
        assertEquals(listOf("dev-phone"), row.hostDeviceIds())
        assertTrue(row.hosts("dev-phone"))
        assertFalse(row.hosts("dev-other"))
    }

    @Test
    fun forget_device_deletes_with_the_forget_query() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"forgotten":true}"""))
        client().forgetDevice("dev-old")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/devices/dev-old?forget=true", req.path)
    }

    @Test
    fun forget_device_surfaces_the_still_hosts_sources_refusal() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(409).setBody(
                """{"code":"DEVICE_STILL_HOSTS_SOURCES","error":"device \"Old Laptop\" still hosts 1 source(s): notes:local. Move them (omnesis sources move) or remove them first.","sources":["notes:local"]}""",
            ),
        )
        val err = runCatching { client().forgetDevice("dev-old") }.exceptionOrNull() as GatewayException.ServerError
        assertEquals("DEVICE_STILL_HOSTS_SOURCES", err.code)
        assertTrue(err.body!!.startsWith("device \"Old Laptop\" still hosts 1 source(s)"))
    }

    @Test
    fun revoke_device_stays_a_plain_delete_without_the_forget_query() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"revoked":true}"""))
        client().revokeDevice("dev-old")
        assertEquals("/admin/devices/dev-old", server.takeRequest().path)
    }

    @Test
    fun device_record_decodes_revoked_at() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"dev-a","name":"Studio","kind":"collector","pairedAt":1,"revokedAt":1772446500000,"online":true},{"id":"dev-b","name":"Phone","kind":"android","pairedAt":2,"revokedAt":null}]}""",
            ),
        )
        val devices = client().devices()
        assertEquals(1_772_446_500_000L, devices[0].revokedAt)
        assertTrue(devices[0].revoked)
        assertNull(devices[1].revokedAt)
        assertFalse(devices[1].revoked)
    }

    @Test
    fun source_debug_pretty_prints_freeform_json() = runTest {
        server.enqueue(MockResponse().setBody("""{"cursor":"abc","docs":42}"""))
        val pretty = client().sourceDebug("notes:local")
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/admin/sources/notes:local/debug", req.path)
        // Pretty-printed: indented, multi-line, key/values preserved.
        assertTrue(pretty.contains("\n"))
        assertTrue(pretty.contains("\"cursor\": \"abc\""))
        assertTrue(pretty.contains("\"docs\": 42"))
    }

    @Test
    fun source_debug_returns_raw_when_unparseable() = runTest {
        // A genuinely malformed payload (lenient parse fails) falls back to the raw body.
        server.enqueue(MockResponse().setBody("""{"unbalanced": """))
        assertEquals("""{"unbalanced": """, client().sourceDebug("notes:local"))
    }

    @Test
    fun delete_all_for_source_posts_and_decodes_counts() = runTest {
        server.enqueue(MockResponse().setBody("""{"deleted":128,"analyticsDropped":["health_body"]}"""))
        val resp = client().deleteAllForSource("notes:local")
        assertEquals(128, resp.deleted)
        assertEquals(listOf("health_body"), resp.analyticsDropped)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/documents/delete-all/source/notes:local", req.path)
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun delete_all_tolerates_missing_analytics_field() = runTest {
        server.enqueue(MockResponse().setBody("""{"deleted":0}"""))
        val resp = client().deleteAllForSource("notes:local")
        assertEquals(0, resp.deleted)
        assertTrue(resp.analyticsDropped.isEmpty())
    }

    @Test
    fun patch_source_with_config_serializes_object() = runTest {
        server.enqueue(MockResponse().setBody("""{"source":{"id":"s","type":"notes","enabled":true}}"""))
        client().patchSource("s", config = JsonObject(mapOf("folder" to JsonPrimitive("Inbox"))))
        // No `enabled` key (null dropped); config object present.
        assertEquals("""{"config":{"folder":"Inbox"}}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun devices_decodes_page_with_capabilities_and_online() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[
                  {"id":"d1","name":"Studio Desktop","kind":"collector","pairedAt":1000,"lastSeenAt":2000,
                   "capabilities":{"hostname":"studio-desktop.local"},"online":true},
                  {"id":"d2","name":"Northstar Agent","kind":"agent","pairedAt":900,
                   "capabilities":{"agentIntegration":{"harness":"openclaw","deliveryProtocolMin":2,
                   "deliveryProtocolMax":2,"maxConcurrentRuns":2}},"online":false}
                ],"pageInfo":{"hasMore":false,"limit":2}}""",
            ),
        )
        val devices = client().devices()
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/admin/devices", req.path)
        assertEquals(2, devices.size)
        assertEquals("studio-desktop.local", devices[0].capabilities?.hostname)
        assertTrue(devices[0].online == true)
        assertEquals("openclaw", devices[1].capabilities?.agentIntegration?.harness)
        assertEquals(2, devices[1].capabilities?.agentIntegration?.maxConcurrentRuns)
    }

    @Test
    fun tokens_filters_by_device_id_and_decodes_scopes() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[
                  {"id":"t1","deviceId":"d1","name":"initial","scopes":["admin","write:*"],"createdAt":1000,"lastUsedAt":2000},
                  {"id":"t2","deviceId":"d1","name":null,"scopes":["read"],"createdAt":1500,"lastUsedAt":null}
                ],"pageInfo":{"hasMore":false,"limit":2}}""",
            ),
        )
        val tokens = client().tokens("d1")
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        // deviceId rides in the query string per the route's filter convention.
        assertEquals("/admin/tokens?deviceId=d1", req.path)
        assertEquals(2, tokens.size)
        assertEquals(listOf("admin", "write:*"), tokens[0].scopes)
        assertEquals("initial", tokens[0].name)
        assertNull(tokens[1].name)
        assertNull(tokens[1].lastUsedAt)
    }

    @Test
    fun create_token_posts_scopes_and_returns_minted_value_once() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"id":"t9","deviceId":"d1","scopes":["read","write:*"],"name":"ci","token":"omn_secret","expiresAt":null}""",
            ),
        )
        val minted = client().createToken("d1", listOf("read", "write:*"), "ci")
        assertEquals("omn_secret", minted.token)
        assertEquals(listOf("read", "write:*"), minted.scopes)
        assertNull(minted.expiresAt)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/tokens", req.path)
        assertEquals("""{"deviceId":"d1","scopes":["read","write:*"],"name":"ci"}""", req.body.readUtf8())
    }

    @Test
    fun create_token_drops_null_name() = runTest {
        server.enqueue(MockResponse().setBody("""{"id":"t9","deviceId":"d1","token":"x"}"""))
        client().createToken("d1", listOf("read"), null)
        assertEquals("""{"deviceId":"d1","scopes":["read"]}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun revoke_token_issues_delete() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().revokeToken("t9")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/tokens/t9", req.path)
    }

    @Test
    fun revoke_device_issues_delete() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().revokeDevice("d1")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/devices/d1", req.path)
    }

    @Test
    fun create_pairing_posts_kind_only_and_returns_code() = runTest {
        server.enqueue(MockResponse().setBody("""{"pairingCode":"7K3M-9QX2","expiresAt":99999,"name":"x","kind":"ios","scopes":["admin"]}"""))
        val pending = client().createPairing("ios")
        assertEquals("7K3M-9QX2", pending.pairingCode)
        assertEquals(99999L, pending.expiresAt)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/devices/pair", req.path)
        // The gateway fills in the kind's canonical grant; no scope set is sent.
        assertEquals("""{"kind":"ios"}""", req.body.readUtf8())
    }

    @Test
    fun create_repair_pairing_binds_existing_device() = runTest {
        server.enqueue(MockResponse().setBody("""{"pairingCode":"7K3M-9QX2","expiresAt":99999}"""))
        client().createPairing("android", "device_existing")
        val req = server.takeRequest()
        assertEquals(
            """{"kind":"android","repairDeviceId":"device_existing"}""",
            req.body.readUtf8(),
        )
    }

    @Test
    fun build_pair_qr_posts_code_and_url_and_returns_payload() = runTest {
        server.enqueue(MockResponse().setBody("""{"qrPayload":"{\"v\":3}"}"""))
        val payload = client().buildPairQr("7K3M-9QX2", "https://host.example:7600")
        assertEquals("""{"v":3}""", payload)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/devices/pair-qr", req.path)
        assertEquals(
            """{"pairingCode":"7K3M-9QX2","gatewayUrl":"https://host.example:7600","trustMode":"auto"}""",
            req.body.readUtf8(),
        )
    }

    @Test
    fun build_pair_qr_falls_back_for_an_older_gateway() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(400).setBody(
                """{"error":"Validation failed","code":"VALIDATION_ERROR","detail":[{"path":"/trustMode"}]}""",
            ),
        )
        server.enqueue(MockResponse().setBody("""{"qrPayload":"{\"v\":3}"}"""))
        assertEquals("""{"v":3}""", client().buildPairQr("7K3M-9QX2", "https://host.example:7600"))
        server.takeRequest()
        assertEquals(
            """{"pairingCode":"7K3M-9QX2","gatewayUrl":"https://host.example:7600"}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test
    fun network_identities_decodes_page() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"address":"192.0.2.42","label":"LAN (en0)","kind":"lan","offLan":false},
                  {"address":"198.51.100.7","label":"Tailscale","kind":"tailscale","offLan":true}],
                  "pageInfo":{"hasMore":false,"limit":2}}""",
            ),
        )
        val ids = client().networkIdentities()
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/admin/network-identities", req.path)
        assertEquals(2, ids.size)
        assertTrue(ids[1].offLan)
    }

    @Test
    fun model_overview_decodes_inference_catalog_and_installed() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"assignmentDisplays":{"agent":{"providerId":"anthropic","providerLabel":"Anthropic","modelName":"Claude","available":true,"configured":true}},
                  "capabilities":[{"role":"agent","title":"Agent","description":"d","icon":"bot"}],
                  "inference":{"backends":{"nstar":{"type":"http","status":"ok","url":"http://x/v1","models":["m1"],"modelRoles":{"m1":["agent"]},"hasApiKey":false}},
                    "codex":{"type":"codex","configured":true,"status":"ok","loggedIn":true,
                      "models":["gpt-example-frontier"],
                      "modelDetails":[{"id":"gpt-example-frontier","name":"GPT Example Frontier","recommended":true}],
                      "runtime":{"source":"managed","command":"/tmp/codex","packageName":"@openai/codex","packageVersion":"0.142.4","version":"0.142.4","supported":true},
                      "discovery":"app-server",
                      "modelRoles":{"gpt-example-frontier":["agent","background-agent"]},"refreshedAt":"2026-07-03T12:00:00Z"},
                    "assignments":{"agent":{"kind":"anthropic","available":true}}},
                  "catalog":[{"kind":"anthropic-api","id":"anthropic/claude","name":"Claude","roles":["agent"]},
                    {"kind":"gguf","id":"example-embed-v1.Q4_K_M","name":"example-embed-v1","roles":["embed"],
                     "sizeBytes":512000000,"minRamGb":8,"recommendedRamGb":12,"quant":"Q4_K_M","params":"560M","recommended":true}],
                  "installed":[{"id":"nomic.Q8"}],"presets":[],"modelsDir":"/m",
                  "activeDownloads":[{"downloadId":"dl-1","modelId":"example-embed-v1.Q4_K_M","filename":"example-embed-v1.Q4_K_M.gguf",
                    "startedAt":"2026-01-01T00:00:00Z","progress":{"downloadedBytes":215000000,"totalBytes":512000000,"speedBytesPerSec":8400000,"etaMs":35000}}]}""",
            ),
        )
        val overview = client().modelOverview()
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/admin/models", req.path)
        assertEquals("Claude", overview.assignmentDisplays["agent"]?.modelName)
        assertEquals("agent", overview.capabilities.first().role)
        assertEquals(listOf("agent"), overview.inference.backends["nstar"]?.modelRoles?.get("m1"))
        assertEquals(true, overview.inference.codex?.configured)
        assertEquals("GPT Example Frontier", overview.inference.codex?.modelDetails?.first()?.name)
        assertEquals("managed", overview.inference.codex?.runtime?.source)
        assertEquals("app-server", overview.inference.codex?.discovery)
        assertEquals(listOf("agent", "background-agent"), overview.inference.codex?.modelRoles?.get("gpt-example-frontier"))
        assertEquals("anthropic", overview.inference.assignments["agent"]?.kind)
        assertEquals("anthropic/claude", overview.catalog.first().id)
        assertEquals("nomic.Q8", overview.installed.first().id)
        // The GGUF entry's lifecycle/fit fields decode.
        val gguf = overview.catalog.first { it.kind == "gguf" }
        assertEquals(512_000_000L, gguf.sizeBytes)
        assertEquals(8.0, gguf.minRamGb!!, 0.0)
        assertEquals("Q4_K_M", gguf.quant)
        assertEquals(true, gguf.recommended)
        // activeDownloads decode (id + progress snapshot).
        assertEquals(1, overview.activeDownloads.size)
        assertEquals("example-embed-v1.Q4_K_M", overview.activeDownloads.first().modelId)
        assertEquals(512_000_000L, overview.activeDownloads.first().progress.totalBytes)
    }

    @Test
    fun model_overview_defaults_active_downloads_when_absent() = runTest {
        // An older gateway omits `activeDownloads` — it must default to empty.
        server.enqueue(
            MockResponse().setBody(
                """{"assignmentDisplays":{},"capabilities":[],"inference":{"backends":{},"assignments":{}},
                  "catalog":[],"installed":[],"presets":[],"modelsDir":"/m"}""",
            ),
        )
        val overview = client().modelOverview()
        server.takeRequest()
        assertTrue(overview.activeDownloads.isEmpty())
    }

    @Test
    fun system_info_decodes_fit_fields() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"platform":"linux","arch":"arm64","cpuModel":"x","cpuCount":8,
                  "totalRamGb":16,"freeRamGb":6.5,"metalSupported":false,"cudaSupported":true,
                  "modelsDir":"/m","modelsDirFreeGb":40.25}""",
            ),
        )
        val info = client().systemInfo()
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/admin/system-info", req.path)
        assertEquals(16.0, info.totalRamGb, 0.0)
        assertEquals(6.5, info.freeRamGb, 0.0)
        assertEquals(40.25, info.modelsDirFreeGb, 0.0)
    }

    @Test
    fun install_model_posts_id_and_decodes_download_id() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"downloadId":"dl-9"}"""))
        val id = client().installModel("example-embed-v1.Q4_K_M")
        val req = server.takeRequest()
        assertEquals("dl-9", id)
        assertEquals("POST", req.method)
        assertEquals("/admin/models/install", req.path)
        assertEquals("""{"id":"example-embed-v1.Q4_K_M"}""", req.body.readUtf8())
    }

    @Test
    fun cancel_download_posts_id_and_decodes_cancelled() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"cancelled":true}"""))
        val cancelled = client().cancelModelDownload("example-embed-v1.Q4_K_M")
        val req = server.takeRequest()
        assertTrue(cancelled)
        assertEquals("POST", req.method)
        assertEquals("/admin/models/cancel-download", req.path)
        assertEquals("""{"id":"example-embed-v1.Q4_K_M"}""", req.body.readUtf8())
    }

    @Test
    fun uninstall_model_sends_delete_to_id() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().uninstallModel("example-embed-v1.Q4_K_M")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/models/example-embed-v1.Q4_K_M", req.path)
    }

    @Test
    fun activate_model_posts_id_and_catalog_role() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().activateModel("nomic.Q8", "embed")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/models/activate", req.path)
        assertEquals("""{"id":"nomic.Q8","role":"embed"}""", req.body.readUtf8())
    }

    @Test
    fun activate_privacy_reviewer_preserves_agent_assignment_target() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().activateModel("example-agent-v1", "agent", "privacy-reviewer")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/models/activate", req.path)
        assertEquals(
            """{"id":"example-agent-v1","role":"agent","capability":"privacy-reviewer"}""",
            req.body.readUtf8(),
        )
    }

    @Test
    fun privacy_policy_families_route_lists_every_family_with_a_nullable_archive_instant() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"policies":[{"id":"00000000-0000-4000-8000-000000000001","name":"Everyday policy","currentRevision":"0123456789abcdef0123456789abcdef","currentVersion":3,"updatedAt":42,"archivedAt":null,"affectedGrantIds":["grant-a","grant-b"]},{"id":"family-archived","name":"Old policy","currentRevision":"fedcba9876543210","currentVersion":1,"updatedAt":7,"archivedAt":99,"affectedGrantIds":[],"futureField":true}]}""",
            ),
        )
        val families = client().privacyPolicyFamilies()
        assertEquals(listOf("Everyday policy", "Old policy"), families.map { it.name })
        assertNull(families[0].archivedAt)
        assertEquals(99L, families[1].archivedAt)
        assertEquals(listOf("grant-a", "grant-b"), families[0].affectedGrantIds)
        assertEquals(3, families[0].currentVersion)
        server.takeRequest().also { request ->
            assertEquals("GET", request.method)
            assertEquals("no-store", request.getHeader("Cache-Control"))
            assertEquals("/admin/privacy/policies", request.path)
        }
    }

    @Test
    fun privacy_policy_family_route_reads_one_named_document() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"policy":"# Everyday policy","revision":"revision-example","updatedAt":42}""",
            ),
        )
        val policy = client().privacyPolicyFamily("policy/example?#")
        assertEquals("# Everyday policy", policy.policy)
        server.takeRequest().also { request ->
            assertEquals("GET", request.method)
            assertEquals("no-store", request.getHeader("Cache-Control"))
            assertEquals("/admin/privacy/policies/policy%2Fexample%3F%23", request.path)
        }
    }

    @Test
    fun privacy_approval_page_carries_the_exact_total_from_a_single_row() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"approvals":[{"id":"approval-example","taskId":"task-example","workflowId":"workflow-example","conversationId":"conversation-example","workflowName":"Example workflow","externalAgent":{"displayName":"Northstar Assistant","source":"token"},"status":"pending","createdAt":100,"expiresAt":200,"resolvedAt":null}],"nextCursor":"cursor-example","totalCount":7}""",
            ),
        )
        val page = client().privacyApprovals(limit = 1)
        assertEquals("approval-example", page.approvals.single().id)
        assertEquals("Northstar Assistant", page.approvals.single().externalAgent.displayName)
        assertEquals(7, page.totalCount)
        assertEquals("cursor-example", page.nextCursor)
        server.takeRequest().also { request ->
            assertEquals("no-store", request.getHeader("Cache-Control"))
            assertEquals("/admin/privacy/approvals?status=pending&limit=1", request.path)
        }
    }

    @Test
    fun privacy_approval_page_without_a_total_is_a_decode_failure_not_a_count() = runTest {
        server.enqueue(MockResponse().setBody("""{"approvals":[{"id":"approval-example"}]}"""))
        val failure = runCatching { client().privacyApprovals() }.exceptionOrNull()
        assertTrue(failure is GatewayException.Decoding)
        assertEquals("/admin/privacy/approvals?status=pending&limit=50", server.takeRequest().path)
    }

    @Test
    fun privacy_approval_page_size_is_capped_at_the_gateway_maximum() = runTest {
        server.enqueue(MockResponse().setBody("""{"approvals":[],"nextCursor":null,"totalCount":0}"""))
        client().privacyApprovals(limit = 5_000, cursor = "cursor/example")
        assertEquals(
            "/admin/privacy/approvals?status=pending&limit=500&cursor=cursor%2Fexample",
            server.takeRequest().path,
        )
    }

    @Test
    fun privacy_approval_route_decodes_the_held_candidate_and_its_review() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"approval":{"id":"approval-example","taskId":"task-example","workflowId":"workflow-example","conversationId":"conversation-example","workflowName":"Example workflow","externalAgent":{"displayName":"OpenClaw","source":"token"},"status":"pending","createdAt":100,"expiresAt":200,"resolvedAt":null,"workflowPurpose":"Prepare a project update","question":"What changed?","candidateAnswer":"The invented project shipped.","sharedAt":null,"review":{"recipeVersion":"v1","provider":"example","model":"reviewer-v1","confidence":0.9,"policyRevision":"rev","fallbackCause":"policy_requires_review","findings":[],"rationale":"Requires user review."}}}""",
            ),
        )
        val detail = client().privacyApproval("approval-example")
        assertEquals("The invented project shipped.", detail.candidateAnswer)
        assertEquals("reviewer-v1", detail.review.model)
        assertEquals("policy_requires_review", detail.review.fallbackCause)
        assertEquals("/admin/privacy/approvals/approval-example", server.takeRequest().path)
    }

    @Test
    fun approval_lists_decode_legacy_envelopes_without_pagination_metadata() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"approvals":[{"id":"watch-approval-example"}]}""",
            ),
        )
        val watches = client().privacySubscriptionApprovals()
        assertEquals("watch-approval-example", watches.approvals.single().id)
        assertEquals(1, watches.totalCount)
        assertEquals(null, watches.nextCursor)
        server.takeRequest()
    }

    @Test
    fun privacy_resolution_uses_expected_route() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"status":"released","workflowId":"workflow-example","conversationId":"conversation-example","taskId":"task-example","releaseId":"release-example","answer":"Approved answer","reductions":[]}""",
            ),
        )
        assertEquals("released", client().approvePrivacyApproval("approval-example").status)
        server.takeRequest().also { request ->
            assertEquals("/admin/privacy/approvals/approval-example/approve", request.path)
            assertEquals("{}", request.body.readUtf8())
        }

    }

    @Test
    fun push_plan_and_unified_android_registrations_use_expected_contracts() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"transport":"relay","relayUrl":"https://push.example.test"}""",
            ),
        )
        val plan = client().pushPlan(
            "android-example",
            "dev.omnesis.android",
        )
        assertEquals("relay", plan.transport)
        assertEquals("https://push.example.test", plan.relayUrl)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/devices/android-example/push-plan?platform=android&appId=dev.omnesis.android",
                request.path,
            )
        }

        server.enqueue(
            MockResponse().setBody(
                """{"transport":"unavailable","reason":"Relay needs permission.","reasonCode":"relay-disabled"}""",
            ),
        )
        val unavailable = client().pushPlan("android-example", "dev.omnesis.android")
        assertEquals("relay-disabled", unavailable.reasonCode)
        server.takeRequest()

        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().grantRelayPushConsent("android-example", "dev.omnesis.android")
        server.takeRequest().also { request ->
            assertEquals("/admin/devices/android-example/push-relay-consent", request.path)
            assertEquals(
                """{"platform":"android","appId":"dev.omnesis.android"}""",
                request.body.readUtf8(),
            )
        }

        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().setDirectFcmPushRegistration(
            "android-example",
            "opaque-registration-token",
            "fictional-project",
        )
        server.takeRequest().also { request ->
            assertEquals("/admin/devices/android-example/push-registration", request.path)
            assertEquals(
                """{"transport":"direct-fcm","registrationToken":"opaque-registration-token","projectId":"fictional-project"}""",
                request.body.readUtf8(),
            )
        }

        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().setRelayPushRegistration(
            "android-example",
            "https://push.example.test",
            "relay-credential",
        )
        server.takeRequest().also { request ->
            assertEquals("/admin/devices/android-example/push-registration", request.path)
            assertEquals(
                """{"transport":"relay","relayUrl":"https://push.example.test","credential":"relay-credential"}""",
                request.body.readUtf8(),
            )
        }
    }

    @Test
    fun privacy_conversation_routes_are_no_store_and_encode_dynamic_segments_once() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"conversation":{"id":"conversation/example?#","workflowId":"workflow-example","workflowName":"Example workflow","workflowPurpose":"Prepare an invented update","externalAgent":{"displayName":"OpenClaw","source":"token"},"title":"What changed?","createdAt":100,"updatedAt":200,"taskCount":2,"latestStatus":"released","latestOutcome":"ready","pendingApprovalCount":0,"workflowStatus":"active","workflowExpiresAt":500}}""",
            ),
        )
        val conversation = client().privacyConversation("conversation/example?#")
        assertEquals("active", conversation.workflowStatus)
        assertEquals("released", conversation.latestStatus)
        assertEquals("ready", conversation.latestOutcome)
        server.takeRequest().also { request ->
            assertEquals("/admin/privacy/conversations/conversation%2Fexample%3F%23", request.path)
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"exchanges":[{"taskId":"task-example","conversationId":"conversation/example?#","workflowId":"workflow-example","externalAgent":{"displayName":"OpenClaw","source":"token"},"workflow":{"name":"Example workflow","purpose":"Prepare an invented update"},"question":"What changed?","status":"released","outcome":"shared","createdAt":100,"resolvedAt":200,"sharedAt":250,"sharedAnswer":"The invented project shipped.","pendingCandidate":null,"reductions":[],"approval":null,"userDecision":null,"review":{"fallbackCause":null,"findings":[],"rationale":"Allowed."}}],"previousCursor":"older/example"}""",
            ),
        )
        val exchanges = client().privacyConversationExchanges("conversation/example?#")
        assertEquals("The invented project shipped.", exchanges.exchanges.single().sharedAnswer)
        assertEquals(250L, exchanges.exchanges.single().sharedAt)
        assertEquals(null, exchanges.exchanges.single().pendingCandidate)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/conversations/conversation%2Fexample%3F%23/exchanges?limit=50",
                request.path,
            )
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"exchanges":[{"taskId":"task-ready","conversationId":"conversation/example?#","workflowId":"workflow-example","externalAgent":{"displayName":"OpenClaw","source":"token"},"workflow":{"name":"Example workflow","purpose":"Prepare an invented update"},"question":"What is ready?","status":"released","outcome":"ready","createdAt":300,"resolvedAt":400,"sharedAt":null,"sharedAnswer":null,"pendingCandidate":null,"reductions":[],"approval":{"id":"approval-ready","status":"approved","expiresAt":500,"resolvedAt":400},"userDecision":"approved","review":{"fallbackCause":"policy_requires_review","findings":[],"rationale":"Approved once."}}],"previousCursor":null}""",
            ),
        )
        val ready = client().privacyConversationExchanges("conversation/example?#").exchanges.single()
        assertEquals("ready", ready.outcome)
        assertEquals(null, ready.sharedAt)
        assertEquals(null, ready.sharedAnswer)
        assertEquals("approved", ready.userDecision)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/conversations/conversation%2Fexample%3F%23/exchanges?limit=50",
                request.path,
            )
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"status":"attention","recentOperationalFailureCount":3,"lastFailureAt":300}""",
            ),
        )
        assertEquals("attention", client().privacyReviewerHealth().status)
        server.takeRequest().also { request ->
            assertEquals("/admin/privacy/reviewer-health", request.path)
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        // The payload metadata is deliberately still on the wire here: the app no
        // longer renders digests or byte counts, and must decode a gateway that
        // still sends them.
        server.enqueue(
            MockResponse().setBody(
                """{"events":[{"id":"event/example","taskId":"task-example","kind":"privacy_review","createdAt":300,"display":{"title":"Privacy review","text":"Approval is required.","status":{"code":"held","label":"Held for you"}},"payloadAvailable":true,"payloadDigest":"abc","payloadBytes":120,"originalPayloadBytes":120,"payloadTruncated":false}],"previousCursor":null}""",
            ),
        )
        val events = client().privacyConversationEvents("conversation/example?#")
        assertEquals("privacy_review", events.events.single().kind)
        assertEquals("held", events.events.single().display.status?.code)
        assertEquals("Held for you", events.events.single().display.status?.label)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/conversations/conversation%2Fexample%3F%23/events?limit=50",
                request.path,
            )
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(MockResponse().setBody("""{"deleted":true}"""))
        client().deletePrivacyConversation("conversation/example?#")
        server.takeRequest().also { request ->
            assertEquals("DELETE", request.method)
            assertEquals("/admin/privacy/conversations/conversation%2Fexample%3F%23", request.path)
        }
    }

    @Test
    fun exchanges_carry_agent_traces_only_for_the_requested_task() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"exchanges":[{"taskId":"task-example","conversationId":"conversation-example","workflowId":"workflow-example","externalAgent":{"displayName":"Atlas","source":"token"},"workflow":{"name":"Example workflow","purpose":"Prepare an invented update"},"question":"What changed?","status":"released","outcome":"shared","createdAt":100,"resolvedAt":200,"sharedAt":250,"agentTraces":[{"attempt":1,"provider":"example-provider","model":"example-model","sessionId":"session-example","messages":[{"role":"assistant","parts":[{"kind":"tool_use","toolCallId":"call-example","tool":"list_loops","args":{}}]}],"terminalStopReason":null,"createdAt":150,"truncated":false,"omittedParts":null}],"agentTraceOmittedAttempts":2}],"previousCursor":null}""",
            ),
        )
        val traced = client().privacyConversationExchanges(
            "conversation-example",
            includeAgentTracesTaskId = "task-example",
        ).exchanges.single()
        assertEquals(1, traced.agentTraces.single().attempt)
        assertEquals("example-provider", traced.agentTraces.single().provider)
        assertEquals(2, traced.agentTraceOmittedAttempts)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/conversations/conversation-example/exchanges?limit=50&includeAgentTracesTaskId=task-example",
                request.path,
            )
        }

        server.enqueue(MockResponse().setBody("""{"exchanges":[],"previousCursor":null}"""))
        val untraced = client().privacyConversationExchanges("conversation-example")
        assertTrue(untraced.exchanges.isEmpty())
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/conversations/conversation-example/exchanges?limit=50",
                request.path,
            )
        }
    }

    @Test
    fun direct_audit_routes_list_sessions_events_and_delete_by_segment() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"sessions":[{"id":"direct_session_one","ownerId":"owner_example","principalId":"principal_example","principalName":"Atlas","credentialId":"credential_example","grantId":"grant_example","explicitKey":null,"heuristicKey":"principal_example|credential_example","createdAt":1700000000000,"lastEventAt":1700000000000,"eventCount":1}]}""",
            ),
        )
        val sessions = client().directAuditSessions(limit = 50)
        assertEquals("direct_session_one", sessions.single().id)
        assertEquals("Atlas", sessions.single().principalName)
        assertEquals(1, sessions.single().eventCount)
        server.takeRequest().also { request ->
            assertEquals("/admin/privacy/direct/sessions?limit=50", request.path)
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"events":[{"sequence":1,"id":"directevent_one","sessionId":"direct_session_one","tool":"search_many","outcome":"ok","requestId":"request_example","display":{"title":"Direct search_many","text":"Raw corpus read finished with outcome ok."},"payloadTruncated":false,"payloadBytes":120,"originalPayloadBytes":120,"createdAt":1700000000000}]}""",
            ),
        )
        val events = client().directAuditSessionEvents("direct/session?#")
        assertEquals("search_many", events.single().tool)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/direct/sessions/direct%2Fsession%3F%23/events?limit=100",
                request.path,
            )
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"event":{"sequence":1,"id":"directevent_one","sessionId":"direct_session_one","tool":"search_many","outcome":"ok","requestId":"request_example","display":{"title":"Direct search_many"},"payloadTruncated":false,"payloadBytes":120,"originalPayloadBytes":120,"createdAt":1700000000000,"payload":{"tool":"search_many","args":{"query":"fictional schedule"},"result":{"documents":[]},"outcome":"ok"}}}""",
            ),
        )
        val detail = client().directAuditEvent("directevent/one?#")
        assertEquals("directevent_one", detail.id)
        server.takeRequest().also { request ->
            assertEquals(
                "/admin/privacy/direct/events/directevent%2Fone%3F%23",
                request.path,
            )
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }

        server.enqueue(MockResponse().setBody("""{"deleted":true}"""))
        client().deleteDirectAuditSession("direct/session?#")
        server.takeRequest().also { request ->
            assertEquals("DELETE", request.method)
            assertEquals("/admin/privacy/direct/sessions/direct%2Fsession%3F%23", request.path)
        }
    }

    @Test
    fun direct_audit_routes_map_404_to_not_found() = runTest {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not found"}"""))
        try {
            client().directAuditSessions()
            throw AssertionError("expected not found")
        } catch (e: GatewayException.NotFound) {
            // An old gateway has no Direct routes — callers map this to an unsupported state.
        }
    }

    @Test
    fun subscription_privacy_routes_decode_metadata_and_encode_opaque_ids() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"approvals":[{"id":"approval-example","subscriptionId":"subscription-example","workflowHandle":"workflow-example","integration":{"displayName":"OpenClaw","source":"token"},"status":"pending","interpretedCondition":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"revisionId":"revision-example","revision":1,"createdAt":100,"expiresAt":200,"resolvedAt":null}],"nextCursor":"next/example","totalCount":63}""",
            ),
        )
        val approvals = client().privacySubscriptionApprovals(limit = 25, cursor = "cursor/example")
        assertEquals("existence", approvals.approvals.single().interpretedCondition.pushDetail)
        assertEquals("next/example", approvals.nextCursor)
        assertEquals(63, approvals.totalCount)
        server.takeRequest().also {
            assertEquals(
                "/admin/privacy/subscription-approvals?status=pending&limit=25&cursor=cursor%2Fexample",
                it.path,
            )
            assertEquals("no-store", it.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"approval":{"id":"approval-example","subscriptionId":"subscription-example","workflowHandle":"workflow-example","integration":{"displayName":"OpenClaw","source":"token"},"status":"pending","interpretedCondition":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"interpretation":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"workflowId":"workflow-example","integrationDeviceId":"integration-device-example","integrationDevice":{"id":"integration-device-example","name":"Fictional OpenClaw integration","kind":"agent"},"workflow":{"id":"workflow-example","name":"Fictional workflow","purpose":"Review invented project updates"},"revisionId":"revision-example","revision":1,"createdAt":100,"expiresAt":200,"resolvedAt":null,"condition":{"kind":"natural-language","description":"A fictional condition"},"reaction":{"kind":"agent-workflow","instruction":"Prepare an invented checklist."},"categories":["documents"],"policyRevision":"policy-example"}}""",
            ),
        )
        val approval = client().privacySubscriptionApproval("approval/example")
        assertEquals("A fictional condition", approval.condition.description)
        assertEquals("Fictional workflow", approval.workflow.name)
        server.takeRequest().also {
            assertEquals(
                "/admin/privacy/subscription-approvals/approval%2Fexample",
                it.path,
            )
            assertEquals("no-store", it.getHeader("Cache-Control"))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"firings":[{"id":"firing-example","subscriptionId":"subscription-example","revisionId":"revision-example","workflowHandle":"workflow-example","createdAt":150,"deliveryStatus":"delivered","acceptedAt":151}],"nextCursor":null}""",
            ),
        )
        val firings = client().privacySubscriptionFirings(
            "subscription/example?#",
            cursor = "firing/cursor",
        )
        assertEquals("delivered", firings.firings.single().deliveryStatus)
        server.takeRequest().also {
            assertEquals(
                "/admin/privacy/subscriptions/subscription%2Fexample%3F%23/firings?limit=50&cursor=firing%2Fcursor",
                it.path,
            )
            assertEquals("no-store", it.getHeader("Cache-Control"))
        }
    }

    @Test
    fun subscription_approval_detail_fails_closed_on_partial_trusted_payload() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"approval":{"id":"approval-example","status":"pending"}}""",
            ),
        )
        val missingFields = runCatching {
            client().privacySubscriptionApproval("approval-example")
        }.exceptionOrNull()
        assertTrue(missingFields != null)

        server.enqueue(
            MockResponse().setBody(
                """{"approval":{"id":"approval-example","subscriptionId":"subscription-example","workflowHandle":"workflow-example","integration":{},"status":"pending","interpretedCondition":{},"revisionId":"revision-example","revision":1,"createdAt":100,"expiresAt":200,"condition":{},"reaction":{},"categories":[],"policyRevision":""}}""",
            ),
        )
        val unsafeDefaults = runCatching {
            client().privacySubscriptionApproval("approval-example")
        }.exceptionOrNull()
        assertTrue(unsafeDefaults != null)

        server.enqueue(
            MockResponse().setBody(
                """{"approval":{"id":"approval-example","subscriptionId":"subscription-example","workflowHandle":"workflow-example","integration":{"displayName":"OpenClaw","source":"token"},"status":"pending","interpretedCondition":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"interpretation":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"workflowId":"workflow-example","integrationDeviceId":"integration-device-example","integrationDevice":{"id":"integration-device-example","name":"Fictional OpenClaw integration","kind":"agent"},"workflow":{"id":"workflow-example","name":"Fictional workflow","purpose":"Review invented project updates"},"revisionId":"revision-example","revision":1,"createdAt":100,"expiresAt":200,"condition":{"kind":"natural-language","description":"A fictional condition"},"reaction":{"kind":"agent-workflow","instruction":"Prepare an invented checklist."},"categories":[],"policyRevision":"policy-example"}}""",
            ),
        )
        val missingCategories = runCatching {
            client().privacySubscriptionApproval("approval-example")
        }.exceptionOrNull()
        assertTrue(missingCategories != null)

        server.enqueue(
            MockResponse().setBody(
                """{"approval":{"id":"approval-example","subscriptionId":"subscription-example","workflowHandle":"workflow-example","integration":{"displayName":"OpenClaw","source":"token"},"status":"pending","interpretedCondition":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"interpretation":{"summary":"A fictional update requests a decision","pushDetail":"existence"},"workflowId":"workflow-example","integrationDeviceId":"integration-device-example","integrationDevice":{"id":"different-device","name":"Fictional OpenClaw integration","kind":"agent"},"workflow":{"id":"workflow-example","name":"Fictional workflow","purpose":"Review invented project updates"},"revisionId":"revision-example","revision":1,"createdAt":100,"expiresAt":200,"condition":{"kind":"natural-language","description":"A fictional condition"},"reaction":{"kind":"agent-workflow","instruction":"Prepare an invented checklist."},"categories":["documents"],"policyRevision":"policy-example"}}""",
            ),
        )
        val mismatchedIdentity = runCatching {
            client().privacySubscriptionApproval("approval-example")
        }.exceptionOrNull()
        assertTrue(mismatchedIdentity != null)
    }

    @Test
    fun subscription_approval_list_clamps_to_gateway_limit() = runTest {
        server.enqueue(MockResponse().setBody("""{"approvals":[],"nextCursor":null,"totalCount":0}"""))
        client().privacySubscriptionApprovals(limit = 500)
        assertEquals(
            "/admin/privacy/subscription-approvals?status=pending&limit=50",
            server.takeRequest().path,
        )
    }

    @Test
    fun subscription_privacy_mutations_use_distinct_trusted_routes() = runTest {
        repeat(2) { server.enqueue(MockResponse().setBody("{}")) }
        server.enqueue(
            MockResponse().setBody(
                """{"subscription":{"id":"subscription-example","status":"revoked"}}""",
            ),
        )
        val client = client()

        client.approvePrivacySubscription("approval/example")
        client.denyPrivacySubscription("approval/example")
        client.revokePrivacySubscription("subscription/example")

        val requests = List(3) { server.takeRequest() }
        assertEquals(
            listOf(
                "/admin/privacy/subscription-approvals/approval%2Fexample/resolve",
                "/admin/privacy/subscription-approvals/approval%2Fexample/resolve",
                "/admin/privacy/subscriptions/subscription%2Fexample/revoke",
            ),
            requests.map { it.path },
        )
        assertEquals("""{"decision":"approve"}""", requests[0].body.readUtf8())
        assertEquals("""{"decision":"deny"}""", requests[1].body.readUtf8())
    }

    @Test
    fun assign_capability_patches_backend_value() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().assignCapability("ocr", "nstar/dots-ocr")
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/config", req.path)
        assertEquals("""{"inference":{"assignments":{"ocr":"nstar/dots-ocr"}}}""", req.body.readUtf8())
    }

    @Test
    fun clear_capability_patches_explicit_null() = runTest {
        // explicitNulls=false would DROP a String? null — the JsonNull element
        // forces `{"ocr":null}` so the patch actually clears.
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().assignCapability("ocr", null)
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("""{"inference":{"assignments":{"ocr":null}}}""", req.body.readUtf8())
    }

    @Test
    fun add_http_backend_patches_typed_config() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().addHttpBackend("my-vllm", "https://backend.example/v1", "sk-example-secret", "/v1beta/openai")
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/config", req.path)
        assertEquals(
            """{"inference":{"backends":{"my-vllm":{"type":"http","url":"https://backend.example/v1","apiKey":"sk-example-secret","apiPathPrefix":"/v1beta/openai"}}}}""",
            req.body.readUtf8(),
        )
    }

    @Test
    fun add_http_backend_omits_blank_optional_fields() = runTest {
        // explicitNulls=false drops the null apiKey / apiPathPrefix; a keyless
        // local server sends just url + type.
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().addHttpBackend("local-srv", "http://192.0.2.5:8000/v1")
        assertEquals(
            """{"inference":{"backends":{"local-srv":{"type":"http","url":"http://192.0.2.5:8000/v1"}}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test
    fun remove_http_backend_patches_explicit_null() = runTest {
        // Like the capability clear, the backend key must be an explicit null
        // (a missing key is a no-op patch, not a removal).
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().removeHttpBackend("my-vllm")
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/config", req.path)
        assertEquals("""{"inference":{"backends":{"my-vllm":null}}}""", req.body.readUtf8())
    }

    @Test
    fun probe_backend_posts_and_decodes_result() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"status":"ok","models":["m1","m2"]}"""))
        val result = client().probeBackend("my-vllm")
        assertTrue(result.ok)
        assertEquals("ok", result.status)
        assertEquals(listOf("m1", "m2"), result.models)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/inference/backends/my-vllm/probe", req.path)
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun probe_backend_decodes_unreachable_reason() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":false,"status":"unreachable","models":[],"reason":"connection refused"}"""))
        val result = client().probeBackend("down")
        assertFalse(result.ok)
        assertEquals("unreachable", result.status)
        assertEquals("connection refused", result.reason)
    }

    @Test
    fun verify_model_posts_model_role_and_decodes_verdict() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"role":"embedder","model":"example-embed-v1","supported":true,"detail":"embeddings endpoint · dim 1024"}""",
            ),
        )
        val verdict = client().verifyModel("my-vllm", "example-embed-v1", "embedder")
        assertTrue(verdict.supported)
        assertEquals("embedder", verdict.role)
        assertEquals("example-embed-v1", verdict.model)
        assertEquals("embeddings endpoint · dim 1024", verdict.detail)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/inference/backends/my-vllm/verify", req.path)
        // force defaults to false → encodeDefaults=false omits it from the wire.
        assertEquals("""{"model":"example-embed-v1","role":"embedder"}""", req.body.readUtf8())
    }

    @Test
    fun verify_model_sends_force_when_re_verifying() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"role":"agent","model":"example-chat-v1","supported":false,"detail":"HTTP 404: model not found"}""",
            ),
        )
        val verdict = client().verifyModel("my-vllm", "example-chat-v1", "agent", force = true)
        assertFalse(verdict.supported)
        assertEquals("HTTP 404: model not found", verdict.detail)
        assertEquals(
            """{"model":"example-chat-v1","role":"agent","force":true}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test
    fun refresh_codex_backend_posts_refresh_endpoint() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"type":"codex","configured":true,"status":"ok","loggedIn":true,
                  "models":["gpt-example-frontier"],"modelRoles":{"gpt-example-frontier":["agent","background-agent"]}}""",
            ),
        )
        val status = client().refreshCodexBackend()
        val req = server.takeRequest()
        assertEquals(true, status.configured)
        assertEquals(listOf("gpt-example-frontier"), status.models)
        assertEquals("POST", req.method)
        assertEquals("/admin/inference/codex/refresh", req.path)
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun start_codex_login_decodes_device_flow() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"id":"flow_1","status":"pending","verificationUri":"https://auth.openai.com/codex/device",
                  "userCode":"ABCD-12345","expiresAt":"2026-07-03T12:15:00Z"}""",
            ),
        )
        val flow = client().startCodexLogin()
        val req = server.takeRequest()
        assertEquals("ABCD-12345", flow.userCode)
        assertEquals("POST", req.method)
        assertEquals("/admin/inference/codex/login", req.path)
        assertEquals("{}", req.body.readUtf8())
    }

    @Test
    fun get_and_cancel_codex_login_target_login_endpoint() = runTest {
        server.enqueue(MockResponse().setBody("""{"flow":{"id":"flow_1","status":"pending","userCode":"ABCD-12345"}}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"canceled":true,"flow":{"id":"flow_1","status":"canceled"}}"""))
        val flow = client().getCodexLogin()
        val cancel = client().cancelCodexLogin()
        val getReq = server.takeRequest()
        val deleteReq = server.takeRequest()
        assertEquals("ABCD-12345", flow?.userCode)
        assertTrue(cancel.canceled)
        assertEquals("GET", getReq.method)
        assertEquals("/admin/inference/codex/login", getReq.path)
        assertEquals("DELETE", deleteReq.method)
        assertEquals("/admin/inference/codex/login", deleteReq.path)
    }

    @Test
    fun remove_codex_backend_deletes_codex_endpoint() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"ok":true,"status":{"type":"codex","configured":false,"status":"unreachable",
                  "loggedIn":false,"models":[],"reason":"Codex login removed."},"clearedAssignments":["agent"]}""",
            ),
        )
        val result = client().removeCodexBackend()
        val req = server.takeRequest()
        assertEquals(false, result.status.configured)
        assertEquals(listOf("agent"), result.clearedAssignments)
        assertEquals("DELETE", req.method)
        assertEquals("/admin/inference/codex", req.path)
    }

    @Test
    fun model_credentials_decodes_entries_and_drops_hostname() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """
                {"items":[{
                  "fileKey":"anthropic","providerType":"anthropic","providerName":"Anthropic",
                  "spec":{"fileKey":"anthropic","required":true,"publicClient":false,
                    "fields":[{"name":"apiKey","label":"API Key","placeholder":"sk-ant-…",
                      "secret":true,"pattern":"^sk-ant-.+$","patternHint":"starts with sk-ant-"}],
                    "wizard":{"intro":"","why":"","estMinutes":1,"steps":[]}},
                  "configured":true
                }],
                "pageInfo":{"hasMore":false,"limit":1},"hostname":"gateway-host"}
                """.trimIndent(),
            ),
        )
        val entries = client().modelCredentials()
        assertEquals(1, entries.size)
        assertEquals("anthropic", entries[0].fileKey)
        assertEquals("Anthropic", entries[0].providerName)
        assertTrue(entries[0].configured)
        assertEquals(1, entries[0].spec.fields.size)
        assertEquals("apiKey", entries[0].spec.fields[0].name)
        assertEquals(true, entries[0].spec.fields[0].secret)
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/admin/model-credentials", req.path)
    }

    @Test
    fun set_model_credentials_posts_fields_to_file_key() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"fileKey":"anthropic"}"""))
        client().setModelCredentials("anthropic", mapOf("apiKey" to "sk-ant-example0000"))
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/admin/model-credentials/anthropic", req.path)
        assertEquals("""{"fields":{"apiKey":"sk-ant-example0000"}}""", req.body.readUtf8())
    }

    @Test
    fun clear_model_credentials_deletes_file_key() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"fileKey":"anthropic"}"""))
        client().clearModelCredentials("anthropic")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/admin/model-credentials/anthropic", req.path)
    }

    @Test
    fun action_maps_404_to_typed_error() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        val err = runCatching { client().syncSource("missing") }.exceptionOrNull()
        assertEquals(GatewayException.NotFound::class.java, err?.javaClass)
    }

    @Test
    fun remove_maps_unauthorized() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        val err = runCatching { client().removeSource("s") }.exceptionOrNull()
        assertEquals(GatewayException.Unauthorized::class.java, err?.javaClass)
        assertNull((err as? GatewayException.ServerError)?.status)
    }

    @Test
    fun gateway_origin_exposes_the_clients_scheme_host_and_port() {
        // Pairing-QR URL building swaps a chosen host into this origin while
        // preserving the gateway's real scheme + port (mirrors the portal).
        val admin = AdminClient(GatewayHttp(OkHttpClient(), "https://mac.local:17600/", "tok"))
        assertEquals("https", admin.gatewayOrigin.scheme)
        assertEquals("mac.local", admin.gatewayOrigin.host)
        assertEquals(17600, admin.gatewayOrigin.port)
    }

    @Test
    fun privacy_exchange_feed_is_flat_newest_first_and_carries_a_forward_cursor() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"exchanges":[{"taskId":"task-two","conversationId":"conversation/example?#","workflowId":"workflow-example","externalAgent":{"displayName":"Atlas (openclaw)","source":"token"},"workflow":{"name":"Example workflow","purpose":"Prepare an invented update"},"question":"What is the next milestone?","status":"approval_required","outcome":"needs_review","createdAt":300,"resolvedAt":null,"sharedAt":null,"sharedAnswer":null,"pendingCandidate":"An invented held answer.","reductions":[],"approval":{"id":"approval-example","status":"pending","expiresAt":900,"resolvedAt":null},"userDecision":null,"review":{"fallbackCause":"policy_requires_review","findings":[],"rationale":"Requires your review."},"failure":null},{"taskId":"task-one","conversationId":"conversation/example?#","workflowId":"workflow-example","externalAgent":{"displayName":"Atlas (openclaw)","source":"token"},"workflow":{"name":"Example workflow","purpose":"Prepare an invented update"},"question":"What changed?","status":"failed","outcome":"failed","createdAt":100,"resolvedAt":200,"sharedAt":null,"sharedAnswer":null,"pendingCandidate":null,"reductions":[],"approval":null,"userDecision":null,"review":null,"failure":{"code":"reviewer_unreachable","message":"The reviewer model was unreachable."}}],"nextCursor":"older/example"}""",
            ),
        )

        val feed = client().privacyExchangeFeed(limit = 50, cursor = "cursor/example")

        assertEquals(listOf("task-two", "task-one"), feed.exchanges.map { it.taskId })
        assertEquals("An invented held answer.", feed.exchanges.first().pendingCandidate)
        assertEquals("pending", feed.exchanges.first().approval?.status)
        assertEquals(
            "The reviewer model was unreachable.",
            feed.exchanges.last().failure?.message,
        )
        assertNull(feed.exchanges.last().review)
        assertEquals("older/example", feed.nextCursor)
        server.takeRequest().also { request ->
            assertEquals("/admin/privacy/exchanges?limit=50&cursor=cursor%2Fexample", request.path)
            assertEquals("no-store", request.getHeader("Cache-Control"))
        }
    }

    @Test
    fun privacy_exchange_identity_decodes_principal_connection_and_old_gateway_fallback() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"exchanges":[{"externalAgent":{"displayName":"Research assistant","narrativeName":"Research assistant","integrationSlug":null,"connectionName":"Desktop connection","source":"principal"}}]}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"exchanges":[{"externalAgent":{"displayName":"Legacy caller","source":"token"}}]}""",
            ),
        )

        val principal = client().privacyExchangeFeed().exchanges.single().externalAgent
        val legacy = client().privacyExchangeFeed().exchanges.single().externalAgent

        assertEquals("Research assistant", principal.narrativeName)
        assertNull(principal.integrationSlug)
        assertEquals("Desktop connection", principal.connectionName)
        assertEquals("principal", principal.source)
        assertNull(legacy.narrativeName)
        assertNull(legacy.connectionName)
    }

    @Test
    fun an_audit_status_outside_the_closed_set_is_dropped_without_breaking_the_page() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"events":[{"id":"event-one","taskId":"task-one","kind":"candidate_generated","createdAt":100,"display":{"title":"Answer drafted","status":{"code":"stop","label":"stop"}}},{"id":"event-two","taskId":"task-one","kind":"privacy_review","createdAt":200,"display":{"title":"Privacy review","status":{"code":"held","label":"Held for you"}}},{"id":"event-three","taskId":"task-one","kind":"released","createdAt":300,"display":{"title":"Released"}}],"previousCursor":null}""",
            ),
        )

        val events = client().privacyConversationEvents("conversation-example").events

        // A model's raw terminal stop reason never reaches a consumer; the rest
        // of the page decodes around it.
        assertNull(events.first().display.status)
        assertEquals("Held for you", events[1].display.status?.label)
        assertNull(events.last().display.status)
        assertEquals(3, events.size)
        server.takeRequest()
    }

    @Test fun sources_and_internal_reads_the_internal_array() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[],"pageInfo":{"hasMore":false,"limit":0},"internalSources":[{"id":"omnesis-notes"}]}""",
            ),
        )
        val (sources, internal) = client().sourcesAndInternal()
        assertTrue(sources.isEmpty())
        assertEquals(listOf(InternalSource("omnesis-notes")), internal)
        assertEquals("/admin/sources", server.takeRequest().path)
    }

    @Test fun sources_and_internal_tolerates_a_gateway_without_the_field() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"items":[],"pageInfo":{"hasMore":false,"limit":0}}"""),
        )
        val (_, internal) = client().sourcesAndInternal()
        assertTrue(internal.isEmpty())
    }

}
