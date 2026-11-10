// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CapabilityMeta
import dev.omnesis.android.transport.dto.DecisionBackendStatus
import dev.omnesis.android.transport.dto.DecisionCalibrationStatus
import dev.omnesis.android.transport.dto.DecisionConfigPatch
import dev.omnesis.android.transport.dto.DecisionModelOption
import dev.omnesis.android.transport.dto.DecisionVerifyResult
import dev.omnesis.android.transport.dto.ResolvedAssignment
import dev.omnesis.android.transport.dto.TypeSafeEndpointStatus
import dev.omnesis.android.ui.models.DecisionSetup.CalibrationPanel
import dev.omnesis.android.ui.models.DecisionSetup.FilledUrl
import dev.omnesis.android.ui.models.DecisionSetup.KeyState
import dev.omnesis.android.ui.models.DecisionSetup.Provider
import dev.omnesis.android.ui.models.DecisionSetup.SaveRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset
import java.util.Locale

/**
 * The Decision model setup's rules, kept to the portal's
 * `lib/decision-backends.js` so the clients agree. All data is invented.
 */
class DecisionSetupTest {

    private val decisionCap = CapabilityMeta("decision", "Decision model", "d", "scale", backendFamily = "typed-decision")
    private fun preset(id: String) = sampleDecisionPresets().first { it.id == id }

    // --- Configurability ---

    @Test fun decision_card_is_configurable_only_when_the_gateway_sends_presets() {
        assertTrue(DecisionSetup.isConfigurable(decisionCap, sampleDecisionOverview()))
        // An older gateway: no presets, so the card stays read-only.
        assertFalse(DecisionSetup.isConfigurable(decisionCap, sampleModelsOverview()))
        // A role of another backend family is never this setup's.
        val other = decisionCap.copy(role = "future", backendFamily = "future-family")
        assertFalse(DecisionSetup.isConfigurable(other, sampleDecisionOverview()))
        assertFalse(decisionCap.configurableOnDevice)
    }

    // --- Providers ---

    @Test fun providers_list_configured_backends_then_local_then_cloud_with_typesafe_first() {
        val groups = DecisionSetup.providerGroups(sampleDecisionOverview())
        assertEquals(listOf("ollaya"), groups.existing.map { it.key })
        assertEquals("ollaya", groups.existing.single().preset?.id)
        assertEquals(listOf("Ollaya", "Ollama", "Other server"), groups.local.map { it.title })
        assertEquals(Provider.Custom, groups.local.last())
        assertEquals(
            listOf("typesafe", "openrouter", "cloudflare", "perplexity"),
            groups.cloud.map { it.preset.id },
        )
    }

    @Test fun an_unknown_preset_kind_is_offered_with_the_cloud_providers() {
        val overview = sampleDecisionOverview().copy(
            decisionPresets = listOf(preset("ollaya").copy(id = "appliance", name = "Appliance", kind = "appliance")),
        )
        val groups = DecisionSetup.providerGroups(overview)
        assertEquals(listOf("appliance"), groups.cloud.map { it.preset.id })
        assertEquals(listOf(Provider.Custom), groups.local)
    }

    @Test fun only_servers_of_the_operators_own_are_probed() {
        assertTrue(DecisionSetup.canProbe(Provider.Custom))
        assertTrue(DecisionSetup.canProbe(Provider.Preset(preset("ollama"))))
        assertFalse(DecisionSetup.canProbe(Provider.Preset(preset("openrouter"))))
        val existing = DecisionSetup.providerGroups(sampleDecisionOverview()).existing.single()
        assertTrue(DecisionSetup.canProbe(existing))
    }

    @Test fun the_current_provider_is_marked_and_prefills_its_model() {
        val overview = sampleDecisionOverview()
        val existing = DecisionSetup.providerGroups(overview).existing.single()
        assertTrue(DecisionSetup.isCurrent(existing, overview))
        assertEquals("kev", DecisionSetup.initialModel(existing, overview))
        assertFalse(DecisionSetup.isCurrent(Provider.Preset(preset("typesafe")), overview))
        assertEquals("", DecisionSetup.initialModel(Provider.Preset(preset("ollama")), overview))

        val onTypeSafe = overview.copy(
            inference = overview.inference.copy(
                assignments = overview.inference.assignments +
                    ("decision" to ResolvedAssignment("typesafe", available = true, model = "jev-1.14.0")),
            ),
        )
        assertTrue(DecisionSetup.isCurrent(Provider.Preset(preset("typesafe")), onTypeSafe))
        assertEquals("jev-1.14.0", DecisionSetup.initialModel(Provider.Preset(preset("typesafe")), onTypeSafe))
        assertNull(DecisionSetup.assignedBackend(onTypeSafe))
    }

    @Test fun where_names_the_host_or_this_machine() {
        assertEquals("On this host", DecisionSetup.where(DecisionBackendStatus(url = "http://127.0.0.1:1/x", onHost = true)))
        assertEquals("decide.example.com:8443", DecisionSetup.where(DecisionBackendStatus(url = "https://decide.example.com:8443/v1/systemone")))
        assertEquals("api.example.com", DecisionSetup.where(DecisionBackendStatus(url = "https://api.example.com/v1/systemone")))
    }

    @Test fun local_presets_name_their_port_on_the_host() {
        assertEquals("On this host · port 11435", DecisionSetup.localPlace("http://127.0.0.1:11435/v1/systemone"))
        assertEquals("On this host", DecisionSetup.localPlace("http://localhost/v1/systemone"))
        assertEquals("192.0.2.10:11434", DecisionSetup.localPlace("http://192.0.2.10:11434/v1/systemone"))
    }

    // --- Names ---

    @Test fun backend_names_follow_the_gateways_rules() {
        val overview = sampleDecisionOverview()
        assertEquals("Enter a name.", DecisionSetup.nameError("  ", overview))
        assertEquals("A name cannot contain \"/\".", DecisionSetup.nameError("a/b", overview))
        DecisionSetup.RESERVED_NAMES.forEach { reserved ->
            assertEquals("\"$reserved\" is reserved.", DecisionSetup.nameError(reserved, overview))
        }
        assertEquals("Use at most 64 characters.", DecisionSetup.nameError("x".repeat(65), overview))
        assertNull(DecisionSetup.nameError("x".repeat(64), overview))
        // The sample's HTTP backend and decision backend names are taken…
        assertEquals("\"northstar\" is already an HTTP backend.", DecisionSetup.nameError("northstar", overview))
        assertEquals("\"ollaya\" is already a decision backend.", DecisionSetup.nameError("ollaya", overview))
        // …except by the backend being edited.
        assertNull(DecisionSetup.nameError("ollaya", overview, existingKey = "ollaya"))
        assertNull(DecisionSetup.nameError("studio-decider", overview))
    }

    @Test fun default_names_skip_taken_ones() {
        val overview = sampleDecisionOverview()
        assertEquals("ollama", DecisionSetup.defaultName(preset("ollama"), overview))
        assertEquals("ollaya-2", DecisionSetup.defaultName(preset("ollaya"), overview))
        assertEquals("decision-server", DecisionSetup.defaultName(null, overview))
        val taken = overview.copy(
            inference = overview.inference.copy(
                decisionBackends = overview.inference.decisionBackends +
                    ("ollaya-2" to DecisionBackendStatus(url = "http://127.0.0.1:2/x")),
                backends = overview.inference.backends + ("decision-server" to BackendStatus(type = "http")),
            ),
        )
        assertEquals("ollaya-3", DecisionSetup.defaultName(preset("ollaya"), taken))
        assertEquals("decision-server-2", DecisionSetup.defaultName(null, taken))
    }

    // --- URLs ---

    @Test fun url_params_are_filled_and_encoded() {
        val cloudflare = preset("cloudflare")
        assertEquals(
            FilledUrl.Ok("https://api.cloudflare.com/client/v4/accounts/0123abcd/ai/run"),
            DecisionSetup.fillUrl(cloudflare, mapOf("account" to "  0123abcd ")),
        )
        assertEquals(
            FilledUrl.Ok("https://api.cloudflare.com/client/v4/accounts/team%20a%2Fb%3F/ai/run"),
            DecisionSetup.fillUrl(cloudflare, mapOf("account" to "team a/b?")),
        )
        assertEquals(FilledUrl.Missing("Enter your account id."), DecisionSetup.fillUrl(cloudflare, emptyMap()))
        // A placeholder no param names is reported, not sent.
        val broken = cloudflare.copy(url = "https://{resource}.example.com/{account}")
        assertEquals(
            FilledUrl.Missing("The URL still has {resource}."),
            DecisionSetup.fillUrl(broken, mapOf("account" to "a")),
        )
        assertEquals(FilledUrl.Ok(preset("ollaya").url), DecisionSetup.fillUrl(preset("ollaya"), emptyMap()))
    }

    @Test fun uri_component_encoding_matches_javascript() {
        assertEquals("abc-_.!~*'()", DecisionSetup.encodeUriComponent("abc-_.!~*'()"))
        assertEquals("a%20b%2Bc%26d%3De", DecisionSetup.encodeUriComponent("a b+c&d=e"))
        assertEquals("caf%C3%A9", DecisionSetup.encodeUriComponent("café"))
    }

    @Test fun loopback_urls_are_on_the_host() {
        listOf(
            "http://127.0.0.1:11435/v1/systemone",
            "http://127.8.9.10/x",
            "http://localhost:8080/x",
            "http://decider.localhost/x",
            "http://[::1]:9000/x",
        ).forEach { assertTrue(it, DecisionSetup.isOnHost(it)) }
        listOf(
            "https://api.example.com/v1",
            "http://192.0.2.10:11435/v1/systemone",
            "http://localhost.example.com/x",
            "not a url",
            "",
        ).forEach { assertFalse(it, DecisionSetup.isOnHost(it)) }
    }

    // --- Keys ---

    @Test fun keys_are_required_only_when_none_is_stored() {
        val overview = sampleDecisionOverview()
        val missing = KeyState.Missing
        assertTrue(DecisionSetup.keyRequired(Provider.Preset(preset("openrouter")), overview, missing))
        assertFalse(DecisionSetup.keyRequired(Provider.Preset(preset("ollama")), overview, missing))
        assertFalse(DecisionSetup.keyRequired(Provider.Custom, overview, missing))
        assertTrue(DecisionSetup.keyRequired(Provider.Preset(preset("typesafe")), overview, missing))
        assertFalse(DecisionSetup.keyRequired(Provider.Preset(preset("typesafe")), overview, KeyState.Stored))
        assertTrue(DecisionSetup.keyStored(Provider.Preset(preset("typesafe")), overview, KeyState.Stored))
        val keyed = Provider.Existing("router", DecisionBackendStatus(url = "https://openrouter.ai/x", hasApiKey = true), preset("openrouter"))
        assertFalse(DecisionSetup.keyRequired(keyed, overview, missing))
        assertTrue(DecisionSetup.keyStored(keyed, overview, missing))
        val unkeyed = keyed.copy(backend = keyed.backend.copy(hasApiKey = false))
        assertTrue(DecisionSetup.keyRequired(unkeyed, overview, missing))
        assertFalse(DecisionSetup.keyRequired(DecisionSetup.providerGroups(overview).existing.single(), overview, missing))
    }

    @Test fun typesafe_key_is_optional_on_a_self_hosted_deployment_or_when_its_state_is_unknown() {
        val typesafe = Provider.Preset(preset("typesafe"))
        val base = sampleDecisionOverview()
        val selfHosted = base.copy(
            inference = base.inference.copy(typesafe = TypeSafeEndpointStatus("https://decide.example.com/v1/systemone", selfHosted = true)),
        )
        assertFalse(DecisionSetup.keyRequired(typesafe, selfHosted, KeyState.Missing))
        // A credential list that could not be read is not "no key".
        val unknown = KeyState.Unknown("network error")
        assertFalse(DecisionSetup.keyRequired(typesafe, base, unknown))
        assertFalse(DecisionSetup.keyStored(typesafe, base, unknown))
        assertEquals(unknown, DecisionSetup.typesafeKeyFor(base, unknown))
    }

    @Test fun an_assigned_typesafe_models_key_counts_as_stored() {
        val base = sampleDecisionOverview()
        val onTypeSafe = base.copy(
            inference = base.inference.copy(
                assignments = base.inference.assignments +
                    ("decision" to ResolvedAssignment("typesafe", available = true, model = "jev-1.14.0", hasApiKey = true)),
            ),
        )
        val typesafe = Provider.Preset(preset("typesafe"))
        assertEquals(KeyState.Stored, DecisionSetup.typesafeKeyFor(onTypeSafe, KeyState.Unknown("network error")))
        assertFalse(DecisionSetup.keyRequired(typesafe, onTypeSafe, KeyState.Missing))
        assertTrue(DecisionSetup.keyStored(typesafe, onTypeSafe, KeyState.Missing))
    }

    // --- Saving ---

    @Test fun a_preset_save_carries_its_protocol_and_omits_a_blank_key() {
        val request = DecisionSetup.newBackendSave(" cloudflare ", preset("cloudflare"), " https://a.example.com/run ", "  ", " @cf/cloudflare/clef ")
        assertEquals("cloudflare", request.key)
        assertEquals("@cf/cloudflare/clef", request.model)
        assertEquals("cloudflare/@cf/cloudflare/clef", request.assignment)
        assertEquals("cloudflare", request.config.preset)
        assertEquals("workers-ai", request.config.protocol)
        assertEquals("https://a.example.com/run", request.config.url)
        assertNull(request.config.apiKey)
        val patch = DecisionConfigPatch.saveBackend(request.key, request.config, request.model, request.enableRemote)
        assertEquals(
            """{"inference":{"decisionBackends":{"cloudflare":{"preset":"cloudflare","url":"https://a.example.com/run",""" +
                """"protocol":"workers-ai","auth":"bearer"}},"assignments":{"decision":"cloudflare/@cf/cloudflare/clef"}}}""",
            patch.toString(),
        )
    }

    @Test fun a_custom_server_records_no_preset_and_keeps_a_typed_key() {
        val request = DecisionSetup.newBackendSave("studio", null, "http://192.0.2.10:8080/v1/systemone", "example-key-0002", "kev")
        assertNull(request.config.preset)
        assertEquals("systemone", request.config.protocol)
        assertEquals("bearer", request.config.auth)
        assertEquals("example-key-0002", request.config.apiKey)
        val withConsent = request.withConsent() as SaveRequest.Backend
        assertTrue(withConsent.enableRemote)
        val patch = DecisionConfigPatch.saveBackend(withConsent.key, withConsent.config, withConsent.model, withConsent.enableRemote)
        assertEquals(
            """{"inference":{"allowRemoteInference":true,"decisionBackends":{"studio":{"url":"http://192.0.2.10:8080/v1/systemone",""" +
                """"protocol":"systemone","auth":"bearer","apiKey":"example-key-0002"}},"assignments":{"decision":"studio/kev"}}}""",
            patch.toString(),
        )
    }

    @Test fun re_saving_a_hand_written_backend_never_rewrites_its_protocol_or_auth() {
        // A backend no preset names, speaking OpenAI's Decisions API with an X-API-Key header.
        val existing = Provider.Existing(
            "studio",
            DecisionBackendStatus(url = "https://decide.example.com/v1/decisions", protocol = "openai-decisions", auth = "x-api-key", hasApiKey = true),
            preset = null,
        )
        val modelOnly = DecisionSetup.existingBackendSave(existing, "https://decide.example.com/v1/decisions", "", "decider-v2")
        assertTrue(modelOnly.config.isEmpty)
        assertEquals("https://decide.example.com/v1/decisions", modelOnly.endpoint)
        assertEquals(
            """{"inference":{"assignments":{"decision":"studio/decider-v2"}}}""",
            DecisionConfigPatch.saveBackend(modelOnly.key, modelOnly.config, modelOnly.model, modelOnly.enableRemote).toString(),
        )

        val changed = DecisionSetup.existingBackendSave(existing, " https://decide2.example.com/v1/decisions ", " example-key-0003 ", "decider-v2")
        assertEquals("https://decide2.example.com/v1/decisions", changed.endpoint)
        assertEquals(
            """{"inference":{"decisionBackends":{"studio":{"url":"https://decide2.example.com/v1/decisions",""" +
                """"apiKey":"example-key-0003"}},"assignments":{"decision":"studio/decider-v2"}}}""",
            DecisionConfigPatch.saveBackend(changed.key, changed.config, changed.model, changed.enableRemote).toString(),
        )
    }

    @Test fun re_saving_a_preset_backend_keeps_its_stored_preset_fields() {
        val fastino = sampleDecisionPresets().first().copy(id = "fastino", name = "Fastino", kind = "cloud",
            url = "https://api.example.org/v1/systemone", auth = "x-api-key", scoreField = "expected_level", keyRequired = true)
        val existing = Provider.Existing(
            "fastino",
            DecisionBackendStatus(preset = "fastino", url = "https://api.example.org/v1/systemone", auth = "x-api-key", hasApiKey = true),
            fastino,
        )
        val save = DecisionSetup.existingBackendSave(existing, existing.backend.url, "", "fastino/GLiDE")
        assertEquals(null, save.config.protocol)
        assertEquals(null, save.config.auth)
        assertEquals(null, save.config.scoreField)
        assertEquals(null, save.config.preset)
        assertEquals(DecisionSetup.Consent("fastino/GLiDE", "Fastino"), DecisionSetup.consentFor(save, sampleDecisionOverview(), fastino))
    }

    @Test fun keys_never_appear_in_printed_requests() {
        val backend = DecisionSetup.newBackendSave("router", preset("openrouter"), preset("openrouter").url, "example-key-0004", "liquid/d1.1")
        assertFalse(backend.toString().contains("example-key-0004"))
        assertTrue(backend.toString().contains("apiKey=<redacted>"))
        val typesafe = SaveRequest.TypeSafe("jev-1.14.0", apiKey = "example-key-0005")
        assertFalse(typesafe.toString().contains("example-key-0005"))
    }

    @Test fun removing_the_assigned_backend_clears_the_assignment_in_the_same_patch() {
        assertEquals(
            """{"inference":{"decisionBackends":{"ollaya":null},"assignments":{"decision":null}}}""",
            DecisionConfigPatch.removeBackend("ollaya", clearAssignment = true).toString(),
        )
    }

    // --- Consent ---

    @Test fun off_host_endpoints_ask_for_consent_while_cloud_inference_is_off() {
        val overview = sampleDecisionOverview()
        val local = DecisionSetup.newBackendSave("ollama", preset("ollama"), preset("ollama").url, "", "d3:4b")
        assertNull(DecisionSetup.consentFor(local, overview, preset("ollama")))

        val router = DecisionSetup.newBackendSave("openrouter", preset("openrouter"), preset("openrouter").url, "k", "liquid/d1.1")
        assertEquals(DecisionSetup.Consent("liquid/d1.1", "OpenRouter"), DecisionSetup.consentFor(router, overview, preset("openrouter")))

        // A local preset pointed at another machine names the URL, as a custom server does.
        val remoteOllama = DecisionSetup.newBackendSave("ollama", preset("ollama"), "http://192.0.2.10:11434/v1/systemone", "", "d3:4b")
        assertEquals(
            DecisionSetup.Consent("d3:4b", "http://192.0.2.10:11434/v1/systemone"),
            DecisionSetup.consentFor(remoteOllama, overview, preset("ollama")),
        )

        val allowed = overview.copy(inference = overview.inference.copy(allowRemoteInference = true))
        assertNull(DecisionSetup.consentFor(router, allowed, preset("openrouter")))
    }

    @Test fun typesafe_consent_depends_on_where_its_endpoint_is() {
        val base = sampleDecisionOverview()
        val save = SaveRequest.TypeSafe("jev-1.14.0", apiKey = null)
        assertEquals(DecisionSetup.Consent("jev-1.14.0", "TypeSafe"), DecisionSetup.consentFor(save, base, preset("typesafe")))
        val onHost = base.copy(inference = base.inference.copy(typesafe = TypeSafeEndpointStatus("http://127.0.0.1:9000/v1/systemone", selfHosted = true, onHost = true)))
        assertNull(DecisionSetup.consentFor(save, onHost, preset("typesafe")))
        val ownRemote = base.copy(inference = base.inference.copy(typesafe = TypeSafeEndpointStatus("https://decide.example.com/v1/systemone", selfHosted = true, onHost = false)))
        assertEquals(
            DecisionSetup.Consent("jev-1.14.0", "https://decide.example.com/v1/systemone"),
            DecisionSetup.consentFor(save, ownRemote, preset("typesafe")),
        )
        assertEquals("typesafe/jev-1.14.0", save.assignment)
        assertTrue((save.withConsent() as SaveRequest.TypeSafe).enableRemote)
        assertEquals(
            """{"inference":{"allowRemoteInference":true,"assignments":{"decision":"typesafe/jev-1.14.0"}}}""",
            DecisionConfigPatch.assignTypeSafe("jev-1.14.0", enableRemote = true).toString(),
        )
    }

    @Test fun consent_text_names_the_model_and_provider() {
        val body = DecisionSetup.consentBody(DecisionSetup.Consent("liquid/d1.1", "OpenRouter"))
        assertTrue(body[0].startsWith("Using liquid/d1.1 sends messages"))
        assertTrue(body[0].contains("to OpenRouter."))
        assertTrue(body[1].contains("not only liquid/d1.1"))
    }

    // --- Models ---

    @Test fun suggestions_put_installed_models_first_then_the_presets() {
        val ollaya = preset("ollaya")
        val suggestions = DecisionSetup.modelSuggestions(ollaya, listOf("laya", "nimble:9b", "laya", ""))
        assertEquals(listOf("laya", "nimble:9b", "kev", "d1"), suggestions.map { it.option.id })
        assertEquals(listOf(true, true, false, false), suggestions.map { it.installed })
        assertEquals(listOf("pplx-decider-flash-v1.2", "pplx-decider-v1.2"), DecisionSetup.modelSuggestions(preset("perplexity"), emptyList()).map { it.option.id })
        assertEquals(listOf("kev"), DecisionSetup.modelSuggestions(null, listOf("kev")).map { it.option.id })
    }

    @Test fun model_hints_show_context_and_price_when_known() {
        assertEquals("128k context · $0.10/M input tokens", DecisionSetup.modelHint(DecisionModelOption("m", contextTokens = 128_000, inputCostPerMillion = 0.1)))
        assertEquals("1.5M context", DecisionSetup.modelHint(DecisionModelOption("m", contextTokens = 1_500_000)))
        assertEquals("2M context · free", DecisionSetup.modelHint(DecisionModelOption("m", contextTokens = 2_000_000, inputCostPerMillion = 0.0)))
        assertEquals("$0.005/M input tokens", DecisionSetup.modelHint(DecisionModelOption("m", inputCostPerMillion = 0.005)))
        assertEquals("", DecisionSetup.modelHint(DecisionModelOption("m")))
    }

    // --- Verify ---

    @Test fun verify_text_is_the_answer_time_or_the_reason_verbatim() {
        assertEquals("Answered by kev:latest in 240 ms.", DecisionSetup.verifyText(DecisionVerifyResult(ok = true, answeredBy = "kev:latest", latencyMs = 240)))
        assertEquals("Answered.", DecisionSetup.verifyText(DecisionVerifyResult(ok = true)))
        val reason = "Nothing answered at http://127.0.0.1:11435/v1/systemone. Is the server running? (fetch failed)"
        assertEquals(reason, DecisionSetup.verifyText(DecisionVerifyResult(ok = false, reason = reason)))
        assertEquals("The model did not answer.", DecisionSetup.verifyText(DecisionVerifyResult(ok = false)))
    }

    // --- Calibration ---

    @Test fun calibration_panel_follows_the_assigned_models_run() {
        val assigned = DecisionSetup.assignedBackend(sampleDecisionOverview())!!
        assertEquals("ollaya/kev", assigned.value)
        assertEquals(CalibrationPanel.Uncalibrated, DecisionSetup.calibrationPanel(assigned, null))
        val running = sampleRunningCalibration()
        assertEquals(CalibrationPanel.Running(running), DecisionSetup.calibrationPanel(assigned, running))
        // A run on another model is not this model's.
        assertEquals(CalibrationPanel.Uncalibrated, DecisionSetup.calibrationPanel(assigned, running.copy(assignment = "ollaya/laya")))
        assertEquals(
            CalibrationPanel.Failed("Only 12 of 296 reference emails were answered"),
            DecisionSetup.calibrationPanel(assigned, running.copy(state = "failed", error = "Only 12 of 296 reference emails were answered")),
        )
        assertEquals(CalibrationPanel.Cancelled, DecisionSetup.calibrationPanel(assigned, running.copy(state = "cancelled")))
        // A finished run shows its result before the overview that stores it reloads.
        val fitted = sampleDecisionCalibration().copy(agreement = 0.88)
        assertEquals(
            CalibrationPanel.Calibrated(fitted),
            DecisionSetup.calibrationPanel(assigned, running.copy(state = "done", result = fitted)),
        )

        val calibrated = DecisionSetup.assignedBackend(sampleDecisionOverview(calibrated = true))!!
        assertEquals(CalibrationPanel.Calibrated(sampleDecisionCalibration()), DecisionSetup.calibrationPanel(calibrated, null))
        assertEquals(
            CalibrationPanel.Calibrated(sampleDecisionCalibration()),
            DecisionSetup.calibrationPanel(calibrated, running.copy(state = "done")),
        )
    }

    @Test fun a_failed_recalibration_leaves_the_stored_calibration_in_force() {
        val calibrated = DecisionSetup.assignedBackend(sampleDecisionOverview(calibrated = true))!!
        val run = sampleRunningCalibration()
        assertEquals(
            CalibrationPanel.Calibrated(sampleDecisionCalibration(), note = "Last recalibration failed: Only 12 of 296 reference emails were answered"),
            DecisionSetup.calibrationPanel(calibrated, run.copy(state = "failed", error = "Only 12 of 296 reference emails were answered")),
        )
        assertEquals(
            CalibrationPanel.Calibrated(sampleDecisionCalibration(), note = "The last recalibration was cancelled."),
            DecisionSetup.calibrationPanel(calibrated, run.copy(state = "cancelled")),
        )
        // The card's warning follows whether a calibration is stored, not the last run.
        val overview = sampleDecisionOverview(calibrated = true)
        assertEquals(
            DecisionSetup.CardLine("Calibrated against Jev · agrees on 91%", warning = false),
            DecisionSetup.cardCalibrationLine(overview, run.copy(state = "failed", error = "x")),
        )
        assertEquals(
            DecisionSetup.CardLine("Not calibrated against Jev", warning = true),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(), run.copy(state = "failed", error = "x")),
        )
    }

    @Test fun calibration_sentences() {
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026: agrees with Jev on 91% of the reference emails (was 78%).",
            DecisionSetup.calibrationSummary(sampleDecisionCalibration(), Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026.",
            DecisionSetup.calibrationSummary(sampleDecisionCalibration().copy(agreement = null), Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            "Calibrated against Jev: agrees with Jev on 91% of the reference emails.",
            DecisionSetup.calibrationSummary(sampleDecisionCalibration().copy(fittedAt = "not a date", agreementBefore = null), Locale.US, ZoneOffset.UTC),
        )
        assertEquals("120 of 296 reference emails · 2 failed", DecisionSetup.calibrationProgressText(sampleRunningCalibration()))
        assertEquals("Starting…", DecisionSetup.calibrationProgressText(DecisionCalibrationStatus(state = "running")))
        assertEquals(120f / 296f, DecisionSetup.calibrationFraction(sampleRunningCalibration()), 1e-6f)
        assertEquals(0f, DecisionSetup.calibrationFraction(DecisionCalibrationStatus()), 0f)
    }

    @Test fun card_line_shows_only_for_a_decision_backend_model() {
        assertEquals(
            DecisionSetup.CardLine("Not calibrated against Jev", warning = true),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(), null),
        )
        assertEquals(
            DecisionSetup.CardLine("Calibrated against Jev · agrees on 91%", warning = false),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(calibrated = true), null),
        )
        assertEquals(
            DecisionSetup.CardLine("Calibrating · 120 of 296 reference emails · 2 failed", warning = false),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(), sampleRunningCalibration()),
        )
        // TypeSafe is the reference itself: no line.
        assertNull(DecisionSetup.cardCalibrationLine(sampleModelsOverview(), null))
    }

    @Test fun decision_logos_are_named_by_their_models_dev_id() {
        val overview = sampleDecisionOverview()
        assertEquals(
            mapOf(
                "ollaya" to "ollaya", "ollama" to "ollama", "openrouter" to "openrouter",
                "cloudflare" to "cloudflare-workers-ai", "perplexity" to "perplexity",
            ),
            ProviderLogoLoader.decisionLogoSources(overview),
        )
        val ids = ProviderLogoLoader.providers(overview)
        assertTrue(ids.containsAll(listOf("ollaya", "ollama", "openrouter", "cloudflare-workers-ai", "perplexity")))
        assertFalse("cloudflare" in ids)
    }
}
