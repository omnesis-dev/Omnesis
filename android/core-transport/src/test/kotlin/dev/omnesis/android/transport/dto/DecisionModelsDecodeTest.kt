// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Decision model's slice of `GET /admin/models` and its setup routes, new and old gateways alike. All values are invented. */
class DecisionModelsDecodeTest {

    /** Captured from a gateway with unified backends, its values invented. */
    private val current = """{
      "capabilities":[{"role":"decision","title":"Decision model","description":"d","icon":"scale","section":"cognition","backendFamily":"typed-decision"}],
      "presets":[
        {"id":"fireworks","modelsDevId":"fireworks-ai","name":"Fireworks AI","kind":"cloud","defaultUrl":"https://api.example.com/inference",
         "capabilities":["agent","embed","decision"],
         "decision":{"url":"https://api.example.com/inference/v1/systemone","protocol":"systemone","auth":"bearer","keyRequired":true,
           "suggestedModels":["accounts/example/models/rune"],"docsUrl":"https://docs.example.com","keyUrl":"https://app.example.com/keys",
           "models":[{"id":"accounts/example/models/rune","source":"preset"}]}},
        {"id":"groq","name":"Groq","kind":"cloud","defaultUrl":"https://api.example.net/openai","capabilities":["agent","transcribe"]},
        {"id":"ollaya","name":"Ollaya","kind":"local","capabilities":["decision"],
         "decision":{"url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","auth":"bearer","keyRequired":false,
           "suggestedModels":["kev"],"note":"Runs on this machine.","docsUrl":"https://docs.example.com/api",
           "models":[{"id":"kev","source":"preset"}]}},
        {"id":"typesafe","name":"TypeSafe","kind":"cloud","capabilities":["decision"],"builtIn":"typesafe",
         "decision":{"url":"https://api.example.com/v1/systemone","protocol":"systemone","auth":"bearer","keyRequired":true,
           "suggestedModels":[],"docsUrl":"https://docs.example.com","models":[]}},
        {"id":"cloudflare","name":"Cloudflare Workers AI","kind":"cloud","capabilities":["decision"],
         "decision":{"url":"https://api.example.com/accounts/{account}/ai/run","protocol":"workers-ai","auth":"bearer","keyRequired":true,
           "modelsDevId":"cloudflare-workers-ai","docsUrl":"https://docs.example.com","keyUrl":"https://dash.example.com/tokens",
           "suggestedModels":["@cf/example/clef"],"urlParams":[{"key":"account","label":"Account ID","placeholder":"0123"}],
           "models":[{"id":"@cf/example/clef","contextTokens":128000,"inputCostPerMillion":0.011,"source":"models.dev"}]}},
        {"id":"fastino","name":"Fastino","kind":"cloud","capabilities":["decision"],
         "decision":{"url":"https://api.example.org/v1/systemone","protocol":"systemone","auth":"x-api-key",
           "scoreField":"expected_level","keyRequired":true,"docsUrl":"https://docs.example.org","models":[]}}
      ],
      "inference":{
        "allowRemoteInference":true,
        "typesafe":{"url":"https://api.example.com/v1/systemone","selfHosted":false,"onHost":false},
        "backends":{
          "fireworks":{"type":"http","url":"https://api.example.com/inference","status":"ok","models":["accounts/example/models/chat"],
            "hasApiKey":true,"preset":"fireworks"},
          "ollaya":{"type":"http","status":"ok","hasApiKey":false,"preset":"ollaya",
            "decision":{"url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","auth":"bearer","onHost":true,"hasApiKey":false,
              "calibrations":{"kev":{"points":[[0,0],[0.5,0.4],[1,1]],"reference":"jev-worth/email-worth-v1/jev-1.13.0",
                "fittedAt":"2026-11-08T10:00:00.000Z","samples":296,"agreement":0.91,"agreementBefore":0.78,
                "keeps":0.95,"keepsBefore":0.81,"skips":0.88,"skipsBefore":0.9}}}},
          "studio":{"type":"http","status":"unreachable","reason":"The API key could not be read","hasApiKey":false,
            "decision":{"url":"https://decide.example.com/v1/decisions","protocol":"openai-decisions","auth":"bearer","onHost":false,
              "hasApiKey":false,"apiKeySecretError":"The API key could not be read","calibrations":{}}}
        },
        "assignments":{"decision":{"role":"decision","kind":"decision","backendKey":"ollaya","preset":"ollaya","model":"kev",
          "url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","onHost":true,"allowRemoteInference":true,
          "hasApiKey":false,"calibrated":true,"available":true}}
      }
    }"""

    @Test fun current_gateway_overview_decodes_presets_and_backends_with_decision_apis() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(current)
        val presets = overview.presets.associateBy { it.id }
        assertEquals(listOf("fireworks", "groq", "ollaya", "typesafe", "cloudflare", "fastino"), overview.presets.map { it.id })

        val fireworks = presets.getValue("fireworks")
        assertTrue(fireworks.hasOpenAiApi)
        assertEquals("https://api.example.com/inference/v1/systemone", fireworks.decision!!.url)
        assertEquals("fireworks-ai", fireworks.logoId)
        assertNull(presets.getValue("groq").decision)

        val ollaya = presets.getValue("ollaya")
        assertTrue(ollaya.isLocal)
        assertFalse(ollaya.hasOpenAiApi)
        assertNull(ollaya.defaultUrl)
        assertEquals("kev", ollaya.decision!!.models.single().id)
        assertEquals("Runs on this machine.", ollaya.decision!!.note)

        val cloudflare = presets.getValue("cloudflare").decision!!
        assertEquals("workers-ai", cloudflare.protocol)
        assertEquals("Account ID", cloudflare.urlParams.single().label)
        assertEquals(128_000L, cloudflare.models.single().contextTokens)
        assertEquals(0.011, cloudflare.models.single().inputCostPerMillion!!, 1e-9)
        assertEquals("https://dash.example.com/tokens", cloudflare.keyUrl)
        assertEquals("cloudflare-workers-ai", presets.getValue("cloudflare").logoId)
        assertTrue(presets.getValue("typesafe").isTypeSafe)
        assertEquals("x-api-key", presets.getValue("fastino").decision!!.auth)
        assertEquals("expected_level", presets.getValue("fastino").decision!!.scoreField)

        assertTrue(overview.inference.allowRemoteInference)
        assertFalse(overview.inference.typesafe!!.selfHosted)
        val chat = overview.inference.backends.getValue("fireworks")
        assertTrue(chat.hasOpenAiApi)
        assertNull(chat.decision)
        assertEquals("fireworks", chat.preset)

        val decisionOnly = overview.inference.backends.getValue("ollaya")
        assertFalse(decisionOnly.hasOpenAiApi)
        assertNull(decisionOnly.models)
        assertEquals("ok", decisionOnly.status)
        val decision = decisionOnly.decision!!
        assertTrue(decision.onHost)
        assertFalse(decision.hasApiKey)
        val calibration = decision.calibrations.getValue("kev")
        assertEquals(0.91, calibration.agreement!!, 1e-9)
        assertEquals(0.78, calibration.agreementBefore!!, 1e-9)
        assertEquals(296, calibration.samples)
        assertEquals(0.95, calibration.keeps!!, 1e-9)
        assertEquals(0.81, calibration.keepsBefore!!, 1e-9)
        assertEquals(0.88, calibration.skips!!, 1e-9)
        assertEquals(0.9, calibration.skipsBefore!!, 1e-9)

        val unreadable = overview.inference.backends.getValue("studio")
        assertEquals("unreachable", unreadable.status)
        assertEquals("The API key could not be read", unreadable.reason)
        assertEquals("The API key could not be read", unreadable.decision!!.apiKeySecretError)
        assertEquals("openai-decisions", unreadable.decision!!.protocol)

        val assignment = overview.inference.assignments.getValue("decision")
        assertEquals("decision", assignment.kind)
        assertEquals("ollaya", assignment.backendKey)
        assertEquals("kev", assignment.model)
        assertEquals(true, assignment.calibrated)
        assertTrue(overview.capabilities.single().isTypedDecision)
    }

    @Test fun older_gateway_overview_has_no_decision_apis() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(
            """{"presets":[{"id":"groq","name":"Groq","defaultUrl":"https://api.example.net/openai","capabilities":["agent"]}],
              "inference":{"backends":{"studio":{"type":"http","status":"ok","url":"http://192.0.2.5:8000/v1","models":["m"]}},
              "assignments":{"decision":{"kind":"typesafe","model":"jev-1.13.0","available":true}}}}""",
        )
        val preset = overview.presets.single()
        assertNull(preset.decision)
        assertNull(preset.builtIn)
        assertEquals("", preset.kind)
        assertTrue(preset.hasOpenAiApi)
        val backend = overview.inference.backends.getValue("studio")
        assertNull(backend.decision)
        assertNull(backend.preset)
        assertTrue(backend.hasOpenAiApi)
        assertFalse(overview.inference.allowRemoteInference)
        assertNull(overview.inference.typesafe)
        val assignment = overview.inference.assignments.getValue("decision")
        assertEquals("typesafe", assignment.kind)
        assertNull(assignment.calibrated)
        assertNull(assignment.backendKey)
    }

    @Test fun unknown_kinds_protocols_and_states_are_kept() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(
            """{"presets":[{"id":"edge-box","name":"Edge box","kind":"appliance","futureField":{"x":1},
              "decision":{"url":"https://decide.example.com","protocol":"future-proto","auth":"signature","futureField":1}}],
              "inference":{"assignments":{"decision":{"kind":"future-kind","available":false,"reason":"Not yet"}},
              "backends":{"edge":{"type":"http","status":"ok","decision":{"url":"https://decide.example.com","protocol":"future-proto","auth":"signature"}}}}}""",
        )
        val preset = overview.presets.single()
        assertEquals("appliance", preset.kind)
        assertFalse(preset.isLocal)
        assertEquals("future-proto", preset.decision!!.protocol)
        assertEquals("future-kind", overview.inference.assignments.getValue("decision").kind)
        val backend = overview.inference.backends.getValue("edge").decision!!
        assertEquals("signature", backend.auth)
        assertTrue(backend.calibrations.isEmpty())
    }

    @Test fun an_unsaved_probe_leaves_absent_fields_out_and_never_prints_its_key() {
        val body = DecisionProbeBody(url = "http://127.0.0.1:11434/v1/systemone", preset = "ollama", apiKey = "example-key-0001")
        assertEquals(
            """{"url":"http://127.0.0.1:11434/v1/systemone","preset":"ollama","apiKey":"example-key-0001"}""",
            OmnesisJson.encodeToString(DecisionProbeBody.serializer(), body),
        )
        assertFalse(body.toString().contains("example-key-0001"))
        assertEquals(
            """{"url":"https://decide.example.com","backendKey":"studio"}""",
            OmnesisJson.encodeToString(DecisionProbeBody.serializer(), DecisionProbeBody("https://decide.example.com", backendKey = "studio")),
        )
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
