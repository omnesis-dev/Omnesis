// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Decision model's slice of `GET /admin/models` and its setup routes, new and old gateways alike. */
class DecisionModelsDecodeTest {

    private val current = """{
      "capabilities":[{"role":"decision","title":"Decision model","description":"d","icon":"scale","section":"cognition","backendFamily":"typed-decision"}],
      "decisionPresets":[
        {"id":"ollaya","name":"Ollaya","kind":"local","url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","auth":"bearer",
         "keyRequired":false,"docsUrl":"https://docs.example.com/api","suggestedModels":["kev"],"note":"Runs on this machine.",
         "models":[{"id":"kev","source":"preset"}]},
        {"id":"cloudflare","name":"Cloudflare Workers AI","kind":"cloud","url":"https://api.example.com/accounts/{account}/ai/run",
         "protocol":"workers-ai","auth":"bearer","keyRequired":true,"modelsDevId":"cloudflare-workers-ai","docsUrl":"https://docs.example.com",
         "keyUrl":"https://dash.example.com/tokens","suggestedModels":["@cf/example/clef"],
         "urlParams":[{"key":"account","label":"Account ID","placeholder":"0123"}],
         "models":[{"id":"@cf/example/clef","contextTokens":128000,"inputCostPerMillion":0.011,"source":"models.dev"}]},
        {"id":"typesafe","name":"TypeSafe","kind":"cloud","url":"https://api.example.com/v1/systemone","protocol":"systemone",
         "auth":"bearer","keyRequired":true,"builtIn":"typesafe","docsUrl":"https://docs.example.com","models":[]},
        {"id":"fastino","name":"Fastino","kind":"cloud","url":"https://api.example.org/v1/systemone","protocol":"systemone",
         "auth":"x-api-key","scoreField":"expected_level","keyRequired":true,"docsUrl":"https://docs.example.org","models":[]}
      ],
      "inference":{
        "allowRemoteInference":true,
        "typesafe":{"url":"https://api.example.com/v1/systemone","selfHosted":false,"onHost":false},
        "decisionBackends":{"ollaya":{"preset":"ollaya","url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone",
          "auth":"bearer","onHost":true,"hasApiKey":false,
          "calibrations":{"kev":{"points":[[0,0],[0.5,0.4],[1,1]],"reference":"jev-worth/email-worth-v1/jev-1.13.0",
            "fittedAt":"2026-11-08T10:00:00.000Z","samples":296,"agreement":0.91,"agreementBefore":0.78,
            "keeps":0.95,"keepsBefore":0.81,"skips":0.88,"skipsBefore":0.9}}}},
        "assignments":{"decision":{"role":"decision","kind":"decision","backendKey":"ollaya","preset":"ollaya","model":"kev",
          "url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","onHost":true,"allowRemoteInference":true,
          "hasApiKey":false,"calibrated":true,"available":true}}
      }
    }"""

    @Test fun current_gateway_overview_decodes_the_decision_setup() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(current)
        val presets = overview.decisionPresets!!
        assertEquals(listOf("ollaya", "cloudflare", "typesafe", "fastino"), presets.map { it.id })
        assertTrue(presets[0].isLocal)
        assertEquals("kev", presets[0].models.single().id)
        val cloudflare = presets[1]
        assertEquals("workers-ai", cloudflare.protocol)
        assertEquals("Account ID", cloudflare.urlParams.single().label)
        assertEquals(128_000L, cloudflare.models.single().contextTokens)
        assertEquals(0.011, cloudflare.models.single().inputCostPerMillion!!, 1e-9)
        assertEquals("https://dash.example.com/tokens", cloudflare.keyUrl)
        assertEquals("cloudflare-workers-ai", cloudflare.modelsDevId)
        assertNull(presets[0].modelsDevId)
        assertTrue(presets[2].isTypeSafe)
        assertEquals("x-api-key", presets[3].auth)
        assertEquals("expected_level", presets[3].scoreField)

        assertTrue(overview.inference.allowRemoteInference)
        assertFalse(overview.inference.typesafe!!.selfHosted)
        val backend = overview.inference.decisionBackends.getValue("ollaya")
        assertTrue(backend.onHost)
        assertFalse(backend.hasApiKey)
        val calibration = backend.calibrations.getValue("kev")
        assertEquals(0.91, calibration.agreement!!, 1e-9)
        assertEquals(0.78, calibration.agreementBefore!!, 1e-9)
        assertEquals(296, calibration.samples)
        assertEquals(0.95, calibration.keeps!!, 1e-9)
        assertEquals(0.81, calibration.keepsBefore!!, 1e-9)
        assertEquals(0.88, calibration.skips!!, 1e-9)
        assertEquals(0.9, calibration.skipsBefore!!, 1e-9)

        val assignment = overview.inference.assignments.getValue("decision")
        assertEquals("decision", assignment.kind)
        assertEquals("ollaya", assignment.backendKey)
        assertEquals("kev", assignment.model)
        assertEquals(true, assignment.calibrated)
        assertTrue(overview.capabilities.single().isTypedDecision)
    }

    @Test fun older_gateway_overview_has_no_decision_setup() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(
            """{"inference":{"assignments":{"decision":{"kind":"typesafe","model":"jev-1.13.0","available":true}}}}""",
        )
        assertNull(overview.decisionPresets)
        assertTrue(overview.inference.decisionBackends.isEmpty())
        assertFalse(overview.inference.allowRemoteInference)
        assertNull(overview.inference.typesafe)
        val assignment = overview.inference.assignments.getValue("decision")
        assertEquals("typesafe", assignment.kind)
        assertNull(assignment.calibrated)
        assertNull(assignment.backendKey)
    }

    @Test fun unknown_kinds_protocols_and_states_are_kept() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(
            """{"decisionPresets":[{"id":"edge-box","name":"Edge box","kind":"appliance","protocol":"future-proto",
              "auth":"signature","futureField":{"x":1}}],
              "inference":{"assignments":{"decision":{"kind":"future-kind","available":false,"reason":"Not yet"}},
              "decisionBackends":{"edge":{"url":"https://decide.example.com","protocol":"future-proto","auth":"signature"}}}}""",
        )
        val preset = overview.decisionPresets!!.single()
        assertEquals("appliance", preset.kind)
        assertFalse(preset.isLocal)
        assertEquals("future-proto", preset.protocol)
        assertEquals("future-kind", overview.inference.assignments.getValue("decision").kind)
        val backend = overview.inference.decisionBackends.getValue("edge")
        assertEquals("signature", backend.auth)
        assertTrue(backend.calibrations.isEmpty())
    }

    @Test fun verify_results_keep_the_reason_verbatim() {
        val ok = OmnesisJson.decodeFromString<DecisionVerifyResult>("""{"ok":true,"answeredBy":"kev:latest","latencyMs":240}""")
        assertTrue(ok.ok)
        assertEquals(240L, ok.latencyMs)
        assertEquals("kev:latest", ok.answeredBy)
        val refused = OmnesisJson.decodeFromString<DecisionVerifyResult>(
            """{"ok":false,"status":401,"reason":"The API key was refused (HTTP 401). invalid key"}""",
        )
        assertFalse(refused.ok)
        assertEquals(401, refused.status)
        assertEquals("The API key was refused (HTTP 401). invalid key", refused.reason)
    }

    @Test fun probe_results_decode_listed_and_unlisted() {
        val listed = OmnesisJson.decodeFromString<DecisionProbeResult>("""{"ok":true,"models":["kev","laya"],"listed":true}""")
        assertEquals(listOf("kev", "laya"), listed.models)
        assertTrue(listed.listed)
        val hosted = OmnesisJson.decodeFromString<DecisionProbeResult>("""{"ok":true,"models":[],"listed":false}""")
        assertFalse(hosted.listed)
        val down = OmnesisJson.decodeFromString<DecisionProbeResult>(
            """{"ok":false,"models":[],"listed":false,"reason":"Could not reach http://127.0.0.1:11435/v1/systemone"}""",
        )
        assertEquals("Could not reach http://127.0.0.1:11435/v1/systemone", down.reason)
    }

    @Test fun calibration_status_decodes_every_state() {
        val idle = OmnesisJson.decodeFromString<DecisionCalibrationStatus>("""{"state":"idle","done":0,"total":0,"failed":0}""")
        assertFalse(idle.running)
        val running = OmnesisJson.decodeFromString<DecisionCalibrationStatus>(
            """{"state":"running","assignment":"ollaya/kev","done":120,"total":296,"failed":2,"startedAt":"2026-11-10T09:00:00.000Z"}""",
        )
        assertTrue(running.running)
        assertEquals("ollaya/kev", running.assignment)
        assertEquals(120, running.done)
        val done = OmnesisJson.decodeFromString<DecisionCalibrationStatus>(
            """{"state":"done","assignment":"ollaya/kev","done":296,"total":296,"failed":0,
              "result":{"points":[[0,0],[1,1]],"reference":"r","fittedAt":"2026-11-10T09:05:00.000Z","agreement":0.9}}""",
        )
        assertEquals(0.9, done.result!!.agreement!!, 1e-9)
        assertNull(done.result!!.keeps)
        assertNull(done.result!!.skipsBefore)
        val failed = OmnesisJson.decodeFromString<DecisionCalibrationStatus>(
            """{"state":"failed","done":10,"total":296,"failed":10,"error":"Only 0 of 296 reference emails were answered"}""",
        )
        assertEquals("Only 0 of 296 reference emails were answered", failed.error)
        val future = OmnesisJson.decodeFromString<DecisionCalibrationStatus>("""{"state":"paused"}""")
        assertEquals("paused", future.state)
        assertFalse(future.running)
    }
}
