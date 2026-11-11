// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.BackendConfigPatch
import dev.omnesis.android.transport.dto.BackendDecisionStatus
import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CapabilityMeta
import dev.omnesis.android.transport.dto.DecisionCalibrationStatus
import dev.omnesis.android.transport.dto.DecisionModelOption
import dev.omnesis.android.transport.dto.ProviderDecisionPreset
import dev.omnesis.android.transport.dto.ProviderPreset
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
 * The Decision model setup's rules, kept to the portal's decision setup so
 * the clients agree. All data is invented.
 */
class DecisionSetupTest {

    private val decisionCap = CapabilityMeta("decision", "Decision model", "d", "scale", backendFamily = "typed-decision")
    private fun preset(id: String) = sampleDecisionPresets().first { it.id == id }
    private fun wire(id: String) = preset(id).decision!!
    private fun save(request: SaveRequest.Backend) =
        BackendConfigPatch.saveBackend(request.key, request.config, request.model, request.enableRemote).toString()

    /** A backend that serves only a decision API, as the gateway reports one. */
    private fun decisionOnly(decision: BackendDecisionStatus, preset: String? = null) =
        BackendStatus(type = "http", status = "ok", preset = preset, hasApiKey = decision.hasApiKey, decision = decision)

    // --- Configurability ---

    @Test fun decision_card_is_configurable_only_when_the_gateway_sends_decision_presets() {
        assertTrue(DecisionSetup.isConfigurable(decisionCap, sampleDecisionOverview()))
        // An older gateway: its presets have no decision API, so the card stays read-only.
        assertTrue(sampleModelsOverview().presets.isNotEmpty())
        assertFalse(DecisionSetup.isConfigurable(decisionCap, sampleModelsOverview()))
        // A role of another backend family is never this setup's.
        val other = decisionCap.copy(role = "future", backendFamily = "future-family")
        assertFalse(DecisionSetup.isConfigurable(other, sampleDecisionOverview()))
        assertFalse(decisionCap.configurableOnDevice)
    }

    // --- Providers ---

    @Test fun providers_list_your_backends_then_typesafe_then_providers_to_add() {
        val groups = DecisionSetup.providerGroups(sampleDecisionOverview())
        // The backend serving decisions, then the chat backend whose preset offers them;
        // a chat backend no decision preset names is not offered.
        assertEquals(listOf("ollaya", "fireworks"), groups.yours.map { it.title })
        val existing = groups.yours[0] as Provider.Existing
        assertEquals("ollaya", existing.preset?.id)
        val enable = groups.yours[1] as Provider.Enable
        assertEquals("fireworks", enable.preset.id)
        assertEquals("Fireworks AI · uses your existing key", DecisionSetup.subtitle(enable))
        assertEquals(listOf("typesafe"), groups.builtIn.map { it.preset.id })
        // Ollaya and Fireworks already have backends, offered above; they are not offered again.
        assertEquals(
            listOf("Ollama", "OpenRouter", "Cloudflare Workers AI", "Perplexity", "Other server"),
            groups.add.map { it.title },
        )
        assertEquals(Provider.Custom, groups.add.last())
    }

    @Test fun a_preset_returns_to_the_add_list_once_no_backend_uses_it() {
        val base = sampleDecisionOverview()
        val withoutFireworks = base.copy(inference = base.inference.copy(backends = base.inference.backends - "fireworks"))
        val groups = DecisionSetup.providerGroups(withoutFireworks)
        assertEquals(listOf("ollaya"), groups.yours.map { it.title })
        assertEquals(
            listOf("Ollama", "Fireworks AI", "OpenRouter", "Cloudflare Workers AI", "Perplexity", "Other server"),
            groups.add.map { it.title },
        )
        // A backend no preset names never hides one.
        assertEquals(groups.add, DecisionSetup.providerGroups(
            withoutFireworks.copy(inference = withoutFireworks.inference.copy(
                backends = withoutFireworks.inference.backends + ("spare" to BackendStatus(type = "http", url = "https://api.example.com")),
            )),
        ).add)
    }

    @Test fun a_chat_backend_without_a_key_is_offered_to_add_decisions_with_one() {
        val base = sampleDecisionOverview()
        val keyless = base.copy(
            inference = base.inference.copy(
                backends = base.inference.backends + ("fireworks" to base.inference.backends.getValue("fireworks").copy(hasApiKey = false)),
            ),
        )
        val enable = DecisionSetup.providerGroups(keyless).yours.filterIsInstance<Provider.Enable>().single()
        assertEquals("Fireworks AI · add decision models", DecisionSetup.subtitle(enable))
        assertTrue(DecisionSetup.keyRequired(enable, keyless, KeyState.Missing))
        assertFalse(DecisionSetup.keyStored(enable, keyless, KeyState.Missing))
    }

    @Test fun a_backend_named_typesafe_is_never_offered_decisions() {
        val base = sampleDecisionOverview()
        val overview = base.copy(
            inference = base.inference.copy(
                backends = base.inference.backends + ("typesafe" to BackendStatus(type = "http", url = "https://api.example.com", preset = "fireworks")),
            ),
        )
        assertEquals(listOf("ollaya", "fireworks"), DecisionSetup.providerGroups(overview).yours.map { it.title })
    }

    @Test fun an_unknown_preset_kind_is_offered_with_the_hosted_providers() {
        val overview = sampleDecisionOverview().copy(
            presets = listOf(preset("ollaya").copy(id = "appliance", name = "Appliance", kind = "appliance"), preset("ollama")),
        )
        val groups = DecisionSetup.providerGroups(overview)
        assertEquals(listOf("Ollama", "Appliance", "Other server"), groups.add.map { it.title })
        assertTrue(groups.builtIn.isEmpty())
    }

    @Test fun only_servers_of_the_operators_own_are_probed() {
        assertTrue(DecisionSetup.canProbe(Provider.Custom))
        assertTrue(DecisionSetup.canProbe(Provider.Preset(preset("ollama"))))
        assertFalse(DecisionSetup.canProbe(Provider.Preset(preset("openrouter"))))
        val groups = DecisionSetup.providerGroups(sampleDecisionOverview())
        assertTrue(DecisionSetup.canProbe(groups.yours[0]))
        // Adding decisions to a hosted chat backend lists its preset's models.
        assertFalse(DecisionSetup.canProbe(groups.yours[1]))
    }

    @Test fun the_current_provider_is_marked_and_prefills_its_model() {
        val overview = sampleDecisionOverview()
        val (existing, enable) = DecisionSetup.providerGroups(overview).yours
        assertTrue(DecisionSetup.isCurrent(existing, overview))
        assertEquals("kev", DecisionSetup.initialModel(existing, overview))
        assertFalse(DecisionSetup.isCurrent(enable, overview))
        assertEquals("", DecisionSetup.initialModel(enable, overview))
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
        assertEquals("On this host", DecisionSetup.where(BackendDecisionStatus(url = "http://127.0.0.1:1/x", onHost = true)))
        assertEquals("decide.example.com:8443", DecisionSetup.where(BackendDecisionStatus(url = "https://decide.example.com:8443/v1/systemone")))
        assertEquals("api.example.com", DecisionSetup.where(BackendDecisionStatus(url = "https://api.example.com/v1/systemone")))
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
        // Every backend's name is taken, whatever it serves…
        assertEquals("\"northstar\" is already a backend.", DecisionSetup.nameError("northstar", overview))
        assertEquals("\"ollaya\" is already a backend.", DecisionSetup.nameError("ollaya", overview))
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
                backends = overview.inference.backends +
                    ("ollaya-2" to decisionOnly(BackendDecisionStatus(url = "http://127.0.0.1:2/x"))) +
                    ("decision-server" to BackendStatus(type = "http")),
            ),
        )
        assertEquals("ollaya-3", DecisionSetup.defaultName(preset("ollaya"), taken))
        assertEquals("decision-server-2", DecisionSetup.defaultName(null, taken))
    }

    // --- URLs ---

    @Test fun url_params_are_filled_and_encoded() {
        val cloudflare = wire("cloudflare")
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
        assertEquals(FilledUrl.Ok(wire("ollaya").url), DecisionSetup.fillUrl(wire("ollaya"), emptyMap()))
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
        val routerApi = BackendDecisionStatus(url = "https://openrouter.ai/x", hasApiKey = true)
        val keyed = Provider.Existing("router", decisionOnly(routerApi, "openrouter"), routerApi, preset("openrouter"))
        assertFalse(DecisionSetup.keyRequired(keyed, overview, missing))
        assertTrue(DecisionSetup.keyStored(keyed, overview, missing))
        val unkeyed = keyed.copy(decision = routerApi.copy(hasApiKey = false))
        assertTrue(DecisionSetup.keyRequired(unkeyed, overview, missing))
        val (ollaya, fireworks) = DecisionSetup.providerGroups(overview).yours
        assertFalse(DecisionSetup.keyRequired(ollaya, overview, missing))
        // The chat backend's own key serves its decision API: none is asked.
        assertFalse(DecisionSetup.keyRequired(fireworks, overview, missing))
        assertTrue(DecisionSetup.keyStored(fireworks, overview, missing))
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

    @Test fun a_decision_only_preset_save_carries_its_protocol_and_omits_a_blank_key() {
        val request = DecisionSetup.newBackendSave(" cloudflare ", preset("cloudflare"), " https://a.example.com/run ", "  ", " @cf/cloudflare/clef ")
        assertEquals("cloudflare", request.key)
        assertEquals("@cf/cloudflare/clef", request.model)
        assertEquals("cloudflare/@cf/cloudflare/clef", request.assignment)
        assertEquals("cloudflare", request.config.preset)
        assertNull(request.config.url)
        assertEquals("workers-ai", request.config.decision?.protocol)
        assertEquals("https://a.example.com/run", request.config.decision?.url)
        assertNull(request.config.apiKey)
        assertEquals(
            """{"inference":{"backends":{"cloudflare":{"type":"http","preset":"cloudflare",""" +
                """"decision":{"url":"https://a.example.com/run","protocol":"workers-ai","auth":"bearer"}}},""" +
                """"assignments":{"decision":"cloudflare/@cf/cloudflare/clef"}}}""",
            save(request),
        )
    }

    @Test fun a_both_api_preset_save_configures_both_with_one_key() {
        val request = DecisionSetup.newBackendSave(
            "fireworks-2", preset("fireworks"), wire("fireworks").url, " example-key-0006 ", "accounts/fireworks/models/rune",
        )
        assertEquals(
            """{"inference":{"backends":{"fireworks-2":{"type":"http","preset":"fireworks",""" +
                """"url":"https://api.fireworks.ai/inference","apiKey":"example-key-0006",""" +
                """"decision":{"url":"https://api.fireworks.ai/inference/v1/systemone","protocol":"systemone","auth":"bearer"}}},""" +
                """"assignments":{"decision":"fireworks-2/accounts/fireworks/models/rune"}}}""",
            save(request),
        )
        assertEquals("https://api.fireworks.ai/inference/v1/systemone", request.endpoint)
    }

    @Test fun the_score_field_travels_with_its_preset() {
        val fastino = ProviderPreset(
            id = "fastino", name = "Fastino", kind = "cloud",
            decision = ProviderDecisionPreset(url = "https://api.example.org/v1/systemone", auth = "x-api-key", scoreField = "expected_level", keyRequired = true),
        )
        val request = DecisionSetup.newBackendSave("fastino", fastino, fastino.decision!!.url, "example-key-0007", "fastino/GLiDE")
        assertEquals(
            """{"inference":{"backends":{"fastino":{"type":"http","preset":"fastino","apiKey":"example-key-0007",""" +
                """"decision":{"url":"https://api.example.org/v1/systemone","protocol":"systemone","auth":"x-api-key",""" +
                """"scoreField":"expected_level"}}},"assignments":{"decision":"fastino/fastino/GLiDE"}}}""",
            save(request),
        )
    }

    @Test fun enabling_decisions_on_an_existing_backend_sends_no_key() {
        val overview = sampleDecisionOverview()
        val enable = DecisionSetup.providerGroups(overview).yours.filterIsInstance<Provider.Enable>().single()
        // A key typed anyway is not sent: the backend already has one.
        val request = DecisionSetup.enableSave(enable, wire("fireworks").url, "example-key-0008", "accounts/fireworks/models/rune")
        assertEquals(
            """{"inference":{"backends":{"fireworks":{"decision":{"url":"https://api.fireworks.ai/inference/v1/systemone",""" +
                """"protocol":"systemone","auth":"bearer"}}},"assignments":{"decision":"fireworks/accounts/fireworks/models/rune"}}}""",
            save(request),
        )
        assertEquals(DecisionSetup.Consent("accounts/fireworks/models/rune", "Fireworks AI"), DecisionSetup.consentFor(request, overview, enable.preset))

        // A backend without a key takes the one typed here, for both of its APIs.
        val keyless = enable.copy(backend = enable.backend.copy(hasApiKey = false))
        assertEquals("example-key-0008", DecisionSetup.enableSave(keyless, wire("fireworks").url, " example-key-0008 ", "m").config.apiKey)
    }

    @Test fun a_custom_server_records_no_preset_and_keeps_a_typed_key() {
        val request = DecisionSetup.newBackendSave("studio", null, "http://192.0.2.10:8080/v1/systemone", "example-key-0002", "kev")
        assertNull(request.config.preset)
        assertEquals("systemone", request.config.decision?.protocol)
        assertEquals("bearer", request.config.decision?.auth)
        assertEquals("example-key-0002", request.config.apiKey)
        val withConsent = request.withConsent() as SaveRequest.Backend
        assertTrue(withConsent.enableRemote)
        assertEquals(
            """{"inference":{"allowRemoteInference":true,"backends":{"studio":{"type":"http","apiKey":"example-key-0002",""" +
                """"decision":{"url":"http://192.0.2.10:8080/v1/systemone","protocol":"systemone","auth":"bearer"}}},""" +
                """"assignments":{"decision":"studio/kev"}}}""",
            save(withConsent),
        )
    }

    @Test fun re_saving_a_hand_written_backend_never_rewrites_its_protocol_or_auth() {
        // A backend no preset names, speaking OpenAI's Decisions API with an X-API-Key header.
        val api = BackendDecisionStatus(url = "https://decide.example.com/v1/decisions", protocol = "openai-decisions", auth = "x-api-key", hasApiKey = true)
        val existing = Provider.Existing("studio", decisionOnly(api), api, preset = null)
        val modelOnly = DecisionSetup.existingBackendSave(existing, "https://decide.example.com/v1/decisions", "", "decider-v2")
        assertTrue(modelOnly.config.isEmpty)
        assertEquals("https://decide.example.com/v1/decisions", modelOnly.endpoint)
        assertEquals("""{"inference":{"assignments":{"decision":"studio/decider-v2"}}}""", save(modelOnly))

        val changed = DecisionSetup.existingBackendSave(existing, " https://decide2.example.com/v1/decisions ", " example-key-0003 ", "decider-v2")
        assertEquals("https://decide2.example.com/v1/decisions", changed.endpoint)
        assertEquals(
            """{"inference":{"backends":{"studio":{"apiKey":"example-key-0003",""" +
                """"decision":{"url":"https://decide2.example.com/v1/decisions"}}},"assignments":{"decision":"studio/decider-v2"}}}""",
            save(changed),
        )
    }

    @Test fun re_saving_a_preset_backend_keeps_its_stored_preset_fields() {
        val fastino = ProviderPreset(
            id = "fastino", name = "Fastino", kind = "cloud",
            decision = ProviderDecisionPreset(url = "https://api.example.org/v1/systemone", auth = "x-api-key", scoreField = "expected_level", keyRequired = true),
        )
        val api = BackendDecisionStatus(url = "https://api.example.org/v1/systemone", auth = "x-api-key", hasApiKey = true)
        val existing = Provider.Existing("fastino", decisionOnly(api, "fastino"), api, fastino)
        val save = DecisionSetup.existingBackendSave(existing, api.url, "", "fastino/GLiDE")
        assertNull(save.config.decision)
        assertNull(save.config.preset)
        assertNull(save.config.type)
        assertEquals(DecisionSetup.Consent("fastino/GLiDE", "Fastino"), DecisionSetup.consentFor(save, sampleDecisionOverview(), fastino))
    }

    @Test fun keys_never_appear_in_printed_requests() {
        val backend = DecisionSetup.newBackendSave("router", preset("openrouter"), wire("openrouter").url, "example-key-0004", "liquid/d1.1")
        assertFalse(backend.toString().contains("example-key-0004"))
        assertTrue(backend.toString().contains("apiKey=<redacted>"))
        val typesafe = SaveRequest.TypeSafe("jev-1.14.0", apiKey = "example-key-0005")
        assertFalse(typesafe.toString().contains("example-key-0005"))
    }

    @Test fun a_decision_only_backend_is_removed_whole_and_a_chat_backend_loses_only_its_decisions() {
        val overview = sampleDecisionOverview()
        val ollaya = DecisionSetup.providerGroups(overview).yours.first() as Provider.Existing
        val removal = DecisionSetup.removalFor(ollaya, overview)
        assertEquals(DecisionSetup.Removal("ollaya", wholeBackend = true, clearAssignment = true), removal)
        assertEquals(
            """{"inference":{"backends":{"ollaya":null},"assignments":{"decision":null}}}""",
            BackendConfigPatch.removeBackend("ollaya", clearAssignment = true).toString(),
        )

        val api = BackendDecisionStatus(url = "https://api.fireworks.ai/inference/v1/systemone", hasApiKey = true)
        val both = Provider.Existing(
            "fireworks",
            overview.inference.backends.getValue("fireworks").copy(decision = api),
            api,
            preset("fireworks"),
        )
        assertEquals(DecisionSetup.Removal("fireworks", wholeBackend = false, clearAssignment = false), DecisionSetup.removalFor(both, overview))
        assertEquals(
            """{"inference":{"backends":{"fireworks":{"decision":null}}}}""",
            BackendConfigPatch.disableDecision("fireworks", clearAssignment = false).toString(),
        )
    }

    // --- Consent ---

    @Test fun off_host_endpoints_ask_for_consent_while_cloud_inference_is_off() {
        val overview = sampleDecisionOverview()
        val local = DecisionSetup.newBackendSave("ollama", preset("ollama"), wire("ollama").url, "", "d3:4b")
        assertNull(DecisionSetup.consentFor(local, overview, preset("ollama")))

        val router = DecisionSetup.newBackendSave("openrouter", preset("openrouter"), wire("openrouter").url, "k", "liquid/d1.1")
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
            BackendConfigPatch.assignTypeSafe("jev-1.14.0", enableRemote = true).toString(),
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
        val suggestions = DecisionSetup.modelSuggestions(wire("ollaya"), listOf("laya", "nimble:9b", "laya", ""))
        assertEquals(listOf("laya", "nimble:9b", "kev", "d1"), suggestions.map { it.option.id })
        assertEquals(listOf(true, true, false, false), suggestions.map { it.installed })
        assertEquals(listOf("pplx-decider-flash-v1.2", "pplx-decider-v1.2"), DecisionSetup.modelSuggestions(wire("perplexity"), emptyList()).map { it.option.id })
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
            DecisionSetup.CardLine("Calibrated against Jev · keeps 95% of what Jev keeps", warning = false),
            DecisionSetup.cardCalibrationLine(overview, run.copy(state = "failed", error = "x")),
        )
        assertEquals(
            DecisionSetup.CardLine("Not calibrated against Jev", warning = true),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(), run.copy(state = "failed", error = "x")),
        )
    }

    @Test fun calibration_sentences() {
        val calibration = sampleDecisionCalibration()
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026: keeps 95% of the reference emails Jev keeps and skips 88% " +
                "of those it skips (before: 81% and 90%).",
            DecisionSetup.calibrationSummary(calibration, Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026: keeps 95% of the reference emails Jev keeps and skips 88% " +
                "of those it skips.",
            DecisionSetup.calibrationSummary(calibration.copy(skipsBefore = null), Locale.US, ZoneOffset.UTC),
        )
        // A calibration stored before the keep and skip shares existed reads as agreement.
        val older = calibration.copy(keeps = null, keepsBefore = null, skips = null, skipsBefore = null)
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026: agrees with Jev on 91% of the reference emails (was 78%).",
            DecisionSetup.calibrationSummary(older, Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026: agrees with Jev on 91% of the reference emails (was 78%).",
            DecisionSetup.calibrationSummary(older.copy(skips = 0.88), Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            "Calibrated against Jev on Nov 8, 2026.",
            DecisionSetup.calibrationSummary(older.copy(agreement = null), Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            "Calibrated against Jev: agrees with Jev on 91% of the reference emails.",
            DecisionSetup.calibrationSummary(older.copy(fittedAt = "not a date", agreementBefore = null), Locale.US, ZoneOffset.UTC),
        )
        assertEquals(
            DecisionSetup.CardLine("Calibrated against Jev · agrees on 91%", warning = false),
            DecisionSetup.cardCalibrationLine(
                sampleDecisionOverview(calibrated = true),
                sampleRunningCalibration().copy(state = "done", result = older),
            ),
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
            DecisionSetup.CardLine("Calibrated against Jev · keeps 95% of what Jev keeps", warning = false),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(calibrated = true), null),
        )
        assertEquals(
            DecisionSetup.CardLine("Calibrating · 120 of 296 reference emails · 2 failed", warning = false),
            DecisionSetup.cardCalibrationLine(sampleDecisionOverview(), sampleRunningCalibration()),
        )
        // TypeSafe is the reference itself: no line.
        assertNull(DecisionSetup.cardCalibrationLine(sampleModelsOverview(), null))
    }

    @Test fun preset_logos_are_named_by_their_models_dev_id() {
        val overview = sampleDecisionOverview()
        val sources = ProviderLogoLoader.presetLogoSources(overview)
        assertEquals("cloudflare-workers-ai", sources["cloudflare"])
        assertEquals("fireworks-ai", sources["fireworks"])
        assertEquals("ollaya", sources["ollaya"])
        assertEquals("openai", sources["openai"])
        assertFalse("typesafe" in sources)
        val ids = ProviderLogoLoader.providers(overview)
        assertTrue(ids.containsAll(listOf("ollaya", "ollama", "openrouter", "cloudflare-workers-ai", "fireworks-ai", "perplexity")))
        assertFalse("cloudflare" in ids)
    }
}
