// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.DecisionBackendConfig
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Route and body contract for the Decision model's setup (OkHttp MockWebServer). */
class AdminClientDecisionTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private val cloudflare = DecisionBackendConfig(
        preset = "cloudflare",
        url = "https://api.example.com/accounts/0123abcd/ai/run",
        protocol = "workers-ai",
        auth = "bearer",
        apiKey = "  example-key-0001  ",
    )

    @Test fun saving_a_backend_with_consent_is_one_patch_with_the_assignment() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveDecisionBackend("cloudflare", cloudflare, "@cf/example/clef", enableRemote = true)
        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/admin/config", req.path)
        assertEquals(
            """{"inference":{"allowRemoteInference":true,"decisionBackends":{"cloudflare":{"preset":"cloudflare",""" +
                """"url":"https://api.example.com/accounts/0123abcd/ai/run","protocol":"workers-ai","auth":"bearer",""" +
                """"apiKey":"example-key-0001"}},"assignments":{"decision":"cloudflare/@cf/example/clef"}}}""",
            req.body.readUtf8(),
        )
    }

    @Test fun a_blank_key_is_left_out_so_the_stored_one_is_kept() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveDecisionBackend(
            "studio",
            DecisionBackendConfig(preset = null, url = "http://127.0.0.1:8080/v1/systemone", protocol = "systemone", auth = "bearer", apiKey = " "),
            "kev",
        )
        assertEquals(
            """{"inference":{"decisionBackends":{"studio":{"url":"http://127.0.0.1:8080/v1/systemone",""" +
                """"protocol":"systemone","auth":"bearer"}},"assignments":{"decision":"studio/kev"}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun the_score_field_travels_with_its_preset() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveDecisionBackend(
            "fastino",
            DecisionBackendConfig("fastino", "https://api.example.org/v1/systemone", "systemone", "x-api-key", scoreField = "expected_level"),
            model = null,
        )
        assertEquals(
            """{"inference":{"decisionBackends":{"fastino":{"preset":"fastino","url":"https://api.example.org/v1/systemone",""" +
                """"protocol":"systemone","auth":"x-api-key","scoreField":"expected_level"}}}}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun an_unchanged_backend_is_left_out_of_the_patch() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().saveDecisionBackend("studio", DecisionBackendConfig(apiKey = "  "), "decider-v2")
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

    @Test fun removing_a_backend_sends_explicit_nulls() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().removeDecisionBackend("ollaya", clearAssignment = true)
        client().removeDecisionBackend("spare", clearAssignment = false)
        assertEquals(
            """{"inference":{"decisionBackends":{"ollaya":null},"assignments":{"decision":null}}}""",
            server.takeRequest().body.readUtf8(),
        )
        assertEquals("""{"inference":{"decisionBackends":{"spare":null}}}""", server.takeRequest().body.readUtf8())
    }

    @Test fun probe_and_verify_address_the_backend_by_its_encoded_key() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"models":["kev"],"listed":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":false,"status":404,"reason":"The server has no model \"kev\""}"""))
        val probe = client().probeDecisionBackend("my server")
        assertEquals(listOf("kev"), probe.models)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/admin/inference/decision-backends/my%20server/probe", it.path)
        }
        val verify = client().verifyDecisionBackend("ollaya", "kev")
        assertFalse(verify.ok)
        assertEquals("The server has no model \"kev\"", verify.reason)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/admin/inference/decision-backends/ollaya/verify", it.path)
            assertEquals("""{"model":"kev"}""", it.body.readUtf8())
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

    @Test fun calibration_reads_starts_and_cancels() = runTest {
        server.enqueue(MockResponse().setBody("""{"state":"idle","done":0,"total":0,"failed":0}"""))
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"state":"running","assignment":"ollaya/kev","done":0,"total":296,"failed":0}"""))
        server.enqueue(MockResponse().setBody("""{"state":"running","assignment":"ollaya/kev","done":4,"total":296,"failed":0}"""))
        assertEquals("idle", client().decisionCalibration().state)
        assertEquals(296, client().startDecisionCalibration().total)
        assertEquals(4, client().cancelDecisionCalibration().done)
        listOf("GET", "POST", "DELETE").forEach { method ->
            server.takeRequest().also {
                assertEquals(method, it.method)
                assertEquals("/admin/models/decision/calibration", it.path)
            }
        }
    }

    @Test fun a_refused_calibration_surfaces_the_gateways_reason() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(400)
                .setBody("""{"error":"TypeSafe's Jev is the reference itself; a decision backend's model is what gets calibrated."}"""),
        )
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"A calibration is already running"}"""))
        try {
            client().startDecisionCalibration()
            fail("expected a refusal")
        } catch (e: GatewayException.ServerError) {
            assertEquals(400, e.status)
            assertEquals("TypeSafe's Jev is the reference itself; a decision backend's model is what gets calibrated.", e.body)
        }
        try {
            client().startDecisionCalibration()
            fail("expected a conflict")
        } catch (e: GatewayException.ServerError) {
            assertEquals(409, e.status)
            assertEquals("A calibration is already running", e.body)
        }
    }
}
