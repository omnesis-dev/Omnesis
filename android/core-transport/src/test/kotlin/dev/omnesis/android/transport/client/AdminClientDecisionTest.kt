// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.BackendConfig
import dev.omnesis.android.transport.dto.DecisionEndpointConfig
import dev.omnesis.android.transport.dto.DecisionProbeBody
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Route and body contract for the Decision model's setup (OkHttp MockWebServer). */
class AdminClientDecisionTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private val cloudflare = BackendConfig(
        type = "http",
        preset = "cloudflare",
        apiKey = "  example-key-0001  ",
        decision = DecisionEndpointConfig(url = "https://api.example.com/accounts/0123abcd/ai/run", protocol = "workers-ai", auth = "bearer"),
    )

    @Test fun saving_a_decision_only_backend_with_consent_is_one_patch_with_the_assignment() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveBackend("cloudflare", cloudflare, "@cf/example/clef", enableRemote = true)
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/config", req.path)
        assertEquals(
            """{"inference":{"allowRemoteInference":true,"backends":{"cloudflare":{"type":"http","preset":"cloudflare",""" +
                """"apiKey":"example-key-0001","decision":{"url":"https://api.example.com/accounts/0123abcd/ai/run",""" +
                """"protocol":"workers-ai","auth":"bearer"}}},"assignments":{"decision":"cloudflare/@cf/example/clef"}}}""",
            req.body.readUtf8(),
        )
    }

    @Test fun enabling_decisions_on_an_existing_backend_sends_only_its_decision_block() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveBackend(
            "fireworks",
            BackendConfig(decision = DecisionEndpointConfig("https://api.example.com/inference/v1/systemone", "systemone", "bearer")),
            "accounts/example/models/rune",
        )
        assertEquals(
            """{"inference":{"backends":{"fireworks":{"decision":{"url":"https://api.example.com/inference/v1/systemone",""" +
                """"protocol":"systemone","auth":"bearer"}}},"assignments":{"decision":"fireworks/accounts/example/models/rune"}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun a_blank_key_is_left_out_so_the_stored_one_is_kept() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveBackend(
            "studio",
            BackendConfig(apiKey = " ", decision = DecisionEndpointConfig(url = "http://127.0.0.1:8080/v1/systemone")),
            "kev",
        )
        assertEquals(
            """{"inference":{"backends":{"studio":{"decision":{"url":"http://127.0.0.1:8080/v1/systemone"}}},""" +
                """"assignments":{"decision":"studio/kev"}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun the_score_field_travels_with_its_preset() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveBackend(
            "fastino",
            BackendConfig(
                type = "http",
                preset = "fastino",
                decision = DecisionEndpointConfig("https://api.example.org/v1/systemone", "systemone", "x-api-key", "expected_level"),
            ),
        )
        assertEquals(
            """{"inference":{"backends":{"fastino":{"type":"http","preset":"fastino","decision":{"url":"https://api.example.org/v1/systemone",""" +
                """"protocol":"systemone","auth":"x-api-key","scoreField":"expected_level"}}}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun an_unchanged_backend_is_left_out_of_the_patch() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveBackend("studio", BackendConfig(apiKey = "  ", decision = DecisionEndpointConfig()), "decider-v2")
        assertEquals(
            """{"inference":{"assignments":{"decision":"studio/decider-v2"}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun a_config_never_prints_its_key() {
        val printed = cloudflare.toString()
        assertFalse(printed.contains("example-key-0001"))
        assertTrue(printed.contains("apiKey=<redacted>"))
    }

    @Test fun typesafe_keeps_its_built_in_assignment() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().assignTypeSafeDecision("jev-1.14.0")
        client().assignTypeSafeDecision("jev-1.14.0", enableRemote = true)
        assertEquals("""{"inference":{"assignments":{"decision":"typesafe/jev-1.14.0"}}}""", server.takeRequest().body.readUtf8())
        assertEquals(
            """{"inference":{"allowRemoteInference":true,"assignments":{"decision":"typesafe/jev-1.14.0"}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun disabling_keeps_the_backend_and_removing_drops_it_with_explicit_nulls() = runTest {
        repeat(3) { server.enqueue(MockResponse().setBody("""{"ok":true}""")) }
        client().disableBackendDecision("fireworks", clearAssignment = true)
        client().removeBackend("ollaya", clearDecision = true)
        client().removeBackend("spare")
        assertEquals(
            """{"inference":{"backends":{"fireworks":{"decision":null}},"assignments":{"decision":null}}}""",
            server.takeRequest().body.readUtf8(),
        )
        assertEquals(
            """{"inference":{"backends":{"ollaya":null},"assignments":{"decision":null}}}""",
            server.takeRequest().body.readUtf8(),
        )
        assertEquals("""{"inference":{"backends":{"spare":null}}}""", server.takeRequest().body.readUtf8())
    }

    @Test fun probe_and_verify_address_the_backends_decision_api_by_its_encoded_key() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"models":["kev"],"listed":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":false,"status":404,"reason":"The server has no model \"kev\""}"""))
        val probe = client().probeBackendDecision("my server")
        assertEquals(listOf("kev"), probe.models)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/admin/inference/backends/my%20server/decision/probe", it.path)
        }
        val verify = client().verifyBackendDecision("ollaya", "kev")
        assertFalse(verify.ok)
        assertEquals("The server has no model \"kev\"", verify.reason)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/admin/inference/backends/ollaya/decision/verify", it.path)
            assertEquals("""{"model":"kev"}""", it.body.readUtf8())
        }
    }

    @Test fun an_unsaved_server_is_probed_by_its_url() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"models":["kev","laya"],"listed":true}"""))
        val result = client().probeDecisionServer(
            DecisionProbeBody(url = "http://127.0.0.1:11435/v1/systemone", preset = "ollaya", protocol = "systemone", auth = "bearer"),
        )
        assertEquals(listOf("kev", "laya"), result.models)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/admin/inference/decision/probe", it.path)
            assertEquals(
                """{"url":"http://127.0.0.1:11435/v1/systemone","preset":"ollaya","protocol":"systemone","auth":"bearer"}""",
                it.body.readUtf8(),
            )
        }
    }

    @Test fun typesafe_verify_has_its_own_route() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"answeredBy":"jev-1.14.0","latencyMs":180}"""))
        val result = client().verifyTypeSafeDecision("jev-1.14.0")
        assertTrue(result.ok)
        server.takeRequest().also {
            assertEquals("/admin/inference/typesafe/verify", it.path)
            assertEquals("""{"model":"jev-1.14.0"}""", it.body.readUtf8())
        }
    }
}
