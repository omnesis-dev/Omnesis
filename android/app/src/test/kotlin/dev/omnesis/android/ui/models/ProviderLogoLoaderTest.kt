// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelControlDescriptor
import dev.omnesis.android.transport.dto.ModelControlInfo
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderLogoLoaderTest {
    @Test fun gateway_logo_is_reused_for_a_custom_backend_alias() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>"""
            server.enqueue(MockResponse().setBody(svg))
            val overview = ModelsOverview(
                modelControls = mapOf("custom-host/reasoner-v1" to ModelControlInfo(providerId = "openai")),
            )
            val admin = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
            val first = ProviderLogoLoader.load(admin, ProviderLogoLoader.providers(overview), emptyMap(), overview)
            assertEquals(first["openai"], first["custom-host"])
            assertEquals(svg, first.getValue("openai"))
            assertEquals("/model-logos/openai.svg", server.takeRequest().path)
            val second = ProviderLogoLoader.load(admin, ProviderLogoLoader.providers(overview), first, overview)
            assertEquals(first, second)
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test fun capability_summary_reports_saved_values_only_for_catalog_controls() {
        val info = ModelControlInfo(
            controls = listOf(
                ModelControlDescriptor("reasoningEffort", "enum", "Effort", listOf("low", "high")),
                ModelControlDescriptor("reasoningBudgetTokens", "integer", "Budget"),
            ),
        )
        val settings = ModelBehaviorSettings(
            assignment = "custom-host/reasoner-v1",
            values = ModelBehaviorValues(reasoningEffort = "high", reasoningBudgetTokens = 2048),
        )
        assertEquals("Effort high · Budget 2048 tokens", ModelBehaviorPresentation.summary(settings, info))
        assertTrue(ModelBehaviorPresentation.summary(settings, ModelControlInfo()) == null)
        val unlimited = info.copy(controls = listOf(
            ModelControlDescriptor("reasoningBudgetTokens", "integer", "Budget", min = -1),
        ))
        assertEquals("No reasoning budget enforcement", ModelBehaviorPresentation.summary(
            settings.copy(values = ModelBehaviorValues(reasoningBudgetTokens = -1)), unlimited,
        ))
    }

    @Test fun only_chat_capabilities_offer_behavior_controls() {
        assertTrue(ModelBehaviorPresentation.supportsRole("agent"))
        assertTrue(ModelBehaviorPresentation.supportsRole("privacy-reviewer"))
        assertTrue(ModelBehaviorPresentation.supportsRole("brief-judge"))
        assertTrue(!ModelBehaviorPresentation.supportsRole("embedder"))
        assertTrue(!ModelBehaviorPresentation.supportsRole("transcriber"))
        assertTrue(!ModelBehaviorPresentation.supportsRole("ocr"))
        assertTrue(ModelBehaviorPresentation.supportsAssignment("agent", "http"))
        assertTrue(!ModelBehaviorPresentation.supportsAssignment("agent", "anthropic"))
        assertTrue(ModelBehaviorPresentation.supportsAssignment("agent", "codex"))
    }
}
