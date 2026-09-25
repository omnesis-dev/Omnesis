// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ActiveDownload
import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CatalogEntry
import dev.omnesis.android.transport.dto.CodexBackendStatus
import dev.omnesis.android.transport.dto.CodexModelStatus
import dev.omnesis.android.transport.dto.CredentialField
import dev.omnesis.android.transport.dto.CredentialSpec
import dev.omnesis.android.transport.dto.DownloadProgress
import dev.omnesis.android.transport.dto.InferenceOverview
import dev.omnesis.android.transport.dto.ManifestEntry
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.RecentModelApply
import dev.omnesis.android.transport.dto.RecentModelEntry
import dev.omnesis.android.transport.dto.ResolvedAssignment
import dev.omnesis.android.transport.dto.SystemInfo
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json

/**
 * Mirrors the iOS `ModelManagementTests`: the three-way capability state, the
 * capability -> catalog role mapping, and the per-role picker-option derivation,
 * verified against the same fixtures so the two platforms stay in lockstep.
 */
class ModelManagementTest {

    // --- Three-way capability state (mirrors capability-state.js) ---

    @Test
    fun stateEnabledWhenLocalAvailable() {
        val a = ResolvedAssignment("local", available = true)
        assertEquals(ModelManagement.CapabilityState.ON, ModelManagement.state(a))
        assertTrue(ModelManagement.isConfigured(a))
    }

    @Test
    fun stateNeedsAttentionWhenConfiguredButUnavailable() {
        val a = ResolvedAssignment("http", available = false, reason = "Backend unreachable")
        assertEquals(ModelManagement.CapabilityState.WARN, ModelManagement.state(a))
        assertTrue(ModelManagement.isConfigured(a))
    }

    @Test
    fun stateOffWhenDisabledOrUnresolved() {
        assertEquals(ModelManagement.CapabilityState.OFF, ModelManagement.state(ResolvedAssignment("disabled")))
        assertEquals(ModelManagement.CapabilityState.OFF, ModelManagement.state(ResolvedAssignment("unresolved", reason = "x")))
        assertEquals(ModelManagement.CapabilityState.OFF, ModelManagement.state(null))
        assertFalse(ModelManagement.isConfigured(ResolvedAssignment("disabled")))
    }

    @Test
    fun replayCountsAsEnabled() {
        assertEquals(ModelManagement.CapabilityState.ON, ModelManagement.state(ResolvedAssignment("replay")))
    }

    // --- Capability -> catalog role mapping ---

    @Test
    fun catalogRoleMapping() {
        assertEquals("embed", ModelManagement.catalogRole("embedder"))
        assertEquals("agent", ModelManagement.catalogRole("agent"))
        assertEquals("agent", ModelManagement.catalogRole("privacy-reviewer"))
        assertEquals("agent", ModelManagement.catalogRole("watch-judge"))
        assertEquals("transcribe", ModelManagement.catalogRole("transcriber"))
        // OCR has no catalog role — only backend models / clear apply to it.
        assertNull(ModelManagement.catalogRole("ocr"))
    }

    @Test
    fun watchJudgeIsLabelledAndVerifiable() {
        assertEquals("Watch judge", ModelManagement.roleLabel("watch-judge"))
        assertTrue(ModelManagement.VERIFIABLE_ROLES.contains("watch-judge"))
    }

    // --- Picker options ---

    private fun overview() = ModelsOverview(
        inference = InferenceOverview(
            backends = mapOf(
                "northstar" to BackendStatus(
                    type = "http",
                    status = "ok",
                    url = "http://example.local:9000/v1",
                    models = listOf("dots-ocr", "llama-vision-8b", "embed-model"),
                    modelRoles = mapOf(
                        "dots-ocr" to listOf("ocr"),
                        "llama-vision-8b" to listOf("ocr", "agent"),
                        "embed-model" to listOf("embedder"),
                    ),
                    hasApiKey = false,
                ),
                "anthropic" to BackendStatus(type = "anthropic", status = "ok"),
            ),
        ),
        catalog = listOf(
            CatalogEntry("gguf", "nomic.Q8", "nomic-embed", listOf("embed")),
            CatalogEntry("gguf", "not-installed.Q8", "other-embed", listOf("embed")),
            CatalogEntry("anthropic-api", "anthropic/claude-sonnet-5", "Claude Sonnet 5", listOf("agent")),
            CatalogEntry("anthropic-api", "anthropic/claude-fable-5", "Claude Fable 5", listOf("agent")),
        ),
        installed = listOf(ManifestEntry("nomic.Q8")),
    )

    private fun overviewWithCodex(configured: Boolean = true): ModelsOverview {
        val base = overview()
        return base.copy(
            inference = base.inference.copy(
                codex = CodexBackendStatus(
                    configured = configured,
                    status = if (configured) "ok" else "unreachable",
                    loggedIn = configured,
                    models = if (configured) listOf("gpt-example-frontier", "gpt-example-mini") else emptyList(),
                    modelDetails = if (configured) {
                        listOf(
                            CodexModelStatus("gpt-example-frontier", name = "GPT Example Frontier", recommended = true),
                            CodexModelStatus("gpt-example-mini", name = "GPT Example Mini"),
                        )
                    } else {
                        null
                    },
                    modelRoles = if (configured) {
                        mapOf(
                            "gpt-example-frontier" to listOf("agent", "background-agent"),
                            "gpt-example-mini" to listOf("agent", "background-agent"),
                        )
                    } else {
                        null
                    },
                ),
            ),
        )
    }

    @Test
    fun responsesBackendIsExcludedOnlyForWatchJudge() {
        val base = overview()
        val value = base.copy(
            inference = base.inference.copy(
                backends = base.inference.backends + (
                    "responses-only" to BackendStatus(
                        type = "http",
                        status = "ok",
                        url = "https://example.com/v1",
                        protocol = "responses",
                        models = listOf("agent-model"),
                        modelRoles = mapOf("agent-model" to listOf("agent", "watch-judge")),
                    )
                ),
            ),
        )
        assertFalse(ModelManagement.pickerOptions("watch-judge", value).any { it.providerId == "responses-only" })
        assertFalse(ModelManagement.pickerBackends("watch-judge", value).any { it.providerId == "responses-only" })
        assertTrue(ModelManagement.pickerOptions("agent", value).any { it.providerId == "responses-only" })
        assertTrue(ModelManagement.pickerBackends("agent", value).any { it.providerId == "responses-only" })
    }

    @Test
    fun backendProtocolDecodes() {
        val status = Json.decodeFromString<BackendStatus>(
            """{"type":"http","status":"ok","protocol":"responses"}""",
        )
        assertEquals("responses", status.protocol)
    }

    @Test
    fun embedderOptionsIncludeInstalledGgufAndBackendModel() {
        val ids = ModelManagement.pickerOptions("embedder", overview()).map { it.id }
        assertTrue("installed GGUF offered", ids.contains("local/nomic.Q8"))
        assertFalse("not-downloaded GGUF excluded", ids.contains("local/not-installed.Q8"))
        assertTrue("role-matching backend model offered", ids.contains("northstar/embed-model"))
    }

    @Test
    fun ggufActivateUsesCatalogRole() {
        val local = ModelManagement.pickerOptions("embedder", overview()).first { it.id == "local/nomic.Q8" }
        assertEquals(ModelManagement.Apply.Activate("nomic.Q8", "embed", "embedder"), local.apply)
    }

    @Test
    fun backendModelUsesAssignValue() {
        val backend = ModelManagement.pickerOptions("ocr", overview()).first { it.id == "northstar/dots-ocr" }
        assertEquals(ModelManagement.Apply.Assign("northstar/dots-ocr"), backend.apply)
    }

    @Test
    fun ocrOptionsOnlyFromBackends() {
        // OCR has no catalog role → only backend models can serve it.
        val ids = ModelManagement.pickerOptions("ocr", overview()).map { it.id }.toSet()
        assertEquals(setOf("northstar/dots-ocr", "northstar/llama-vision-8b"), ids)
    }

    @Test
    fun agentOptionsIncludeAnthropicCatalogAndBackend() {
        val ids = ModelManagement.pickerOptions("agent", overview()).map { it.id }.toSet()
        assertTrue(ids.contains("anthropic/anthropic/claude-sonnet-5"))
        assertTrue(ids.contains("anthropic/anthropic/claude-fable-5"))
        assertTrue(ids.contains("northstar/llama-vision-8b"))
    }

    @Test
    fun privacyReviewerUsesAgentCatalogWithoutOverwritingAgentCapability() {
        val anthropic = ModelManagement.pickerOptions("privacy-reviewer", overview())
            .first { it.providerId == "anthropic" }
        assertEquals(
            ModelManagement.Apply.Activate("anthropic/claude-sonnet-5", "agent", "privacy-reviewer"),
            anthropic.apply,
        )
    }

    @Test
    fun agentOptionsIncludeConfiguredCodexModels() {
        val codex = ModelManagement.pickerOptions("agent", overviewWithCodex()).filter { it.providerId == "codex" }
        assertEquals(listOf("codex/gpt-example-frontier", "codex/gpt-example-mini"), codex.map { it.id })
        assertEquals("GPT Example Frontier", codex.first().label)
        assertEquals(ModelManagement.Apply.Assign("codex/gpt-example-frontier"), codex.first().apply)
    }

    @Test
    fun codexOptionsServeAgentLikeRolesAndRequireConfiguredBackend() {
        assertTrue(ModelManagement.pickerOptions("background-agent", overviewWithCodex()).any { it.providerId == "codex" })
        assertFalse(ModelManagement.pickerOptions("embedder", overviewWithCodex()).any { it.providerId == "codex" })
        assertFalse(ModelManagement.pickerOptions("agent", overviewWithCodex(configured = false)).any { it.providerId == "codex" })
    }

    // --- Picker backend grid (mirrors iOS pickerBackends) ---

    @Test
    fun pickerBackendsOrderLocalThenAnthropicThenHttp() {
        // Embedder: local (installed GGUF) + the northstar HTTP backend
        // (embed-model). Anthropic has no embed catalog entry → no anthropic tile.
        val backends = ModelManagement.pickerBackends("embedder", overview())
        assertEquals(listOf("local", "northstar"), backends.map { it.providerId })
        val local = backends.first { it.providerId == "local" }
        assertEquals(1, local.optionCount)
        assertFalse(local.isHttp)
        assertNull(local.url)
        val http = backends.first { it.providerId == "northstar" }
        assertTrue(http.isHttp)
        assertEquals("http://example.local:9000/v1", http.url)
        assertEquals(1, http.optionCount)
    }

    @Test
    fun pickerBackendsIncludeZeroMatchHttpBackend() {
        // The transcriber role matches no model on northstar, but the HTTP
        // backend tile still shows (with a 0 count) so a custom model id can be
        // typed.
        val backends = ModelManagement.pickerBackends("transcriber", overview())
        val http = backends.first { it.providerId == "northstar" }
        assertEquals(0, http.optionCount)
        assertTrue(http.isHttp)
    }

    @Test
    fun pickerBackendsAgentIncludesAnthropicTile() {
        val backends = ModelManagement.pickerBackends("agent", overview())
        val anthropic = backends.first { it.providerId == "anthropic" }
        assertFalse(anthropic.isHttp)
        assertEquals(2, anthropic.optionCount)
        assertTrue(backends.any { it.providerId == "northstar" && it.isHttp })
    }

    @Test
    fun pickerBackendsIncludesCodexOnlyWhenConfiguredForAgent() {
        val backends = ModelManagement.pickerBackends("agent", overviewWithCodex())
        assertEquals(listOf("codex", "anthropic", "northstar"), backends.map { it.providerId })
        assertEquals(2, backends.first { it.providerId == "codex" }.optionCount)
        assertFalse(ModelManagement.pickerBackends("agent", overviewWithCodex(configured = false)).any { it.providerId == "codex" })
    }

    @Test
    fun pickerOptionsForProviderFiltersByBackendAndSearch() {
        // Scoped to the northstar backend, the agent role yields llama-vision-8b.
        val all = ModelManagement.pickerOptions("agent", overview(), forProviderId = "northstar", search = "")
        assertEquals(listOf("northstar/llama-vision-8b"), all.map { it.id })
        // A case-insensitive label search narrows it.
        assertEquals(1, ModelManagement.pickerOptions("agent", overview(), forProviderId = "northstar", search = "VISION").size)
        assertEquals(0, ModelManagement.pickerOptions("agent", overview(), forProviderId = "northstar", search = "nomatch").size)
        // The anthropic-scoped agent option is excluded from a northstar filter.
        assertTrue(all.none { it.providerId == "anthropic" })
    }

    @Test
    fun pickerSearchMatchesEveryTokenAcrossLabelAndId() {
        // "llama vision" is not a substring of the id, but both tokens occur —
        // the same fuzzy rule as the portal (finds DeepSeek-V4-Flash by
        // "deepseek flash"). Token order does not matter; every token must match.
        assertEquals(
            1,
            ModelManagement.pickerOptions("agent", overview(), forProviderId = "northstar", search = "llama vision").size,
        )
        assertEquals(
            1,
            ModelManagement.pickerOptions("agent", overview(), forProviderId = "northstar", search = "vision llama").size,
        )
        assertEquals(
            0,
            ModelManagement.pickerOptions("agent", overview(), forProviderId = "northstar", search = "llama nomatch").size,
        )
    }

    @Test
    fun fuzzyMatchModelIdVectors() {
        assertTrue(ModelManagement.fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek flash"))
        assertTrue(ModelManagement.fuzzyMatchModelId("gpt-4o-mini", "gpt-4o"))
        assertTrue(ModelManagement.fuzzyMatchModelId("anything", ""))
        assertTrue(ModelManagement.fuzzyMatchModelId("anything", "   "))
        assertTrue(ModelManagement.fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "  deepseek   flash  "))
        assertTrue(ModelManagement.fuzzyMatchModelId("Qwen/Qwen3-8B", "qwen 8b"))
        assertFalse(ModelManagement.fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek grok"))
        assertFalse(ModelManagement.fuzzyMatchModelId("gpt-4o", "gpt claude"))
    }

    @Test
    fun fuzzyMatchFieldsLetsTokensSpanFields() {
        assertTrue(ModelManagement.fuzzyMatchFields(listOf("gpt-4o", "GPT Example"), "example 4o"))
        assertFalse(ModelManagement.fuzzyMatchFields(listOf("gpt-4o", "GPT Example"), "example grok"))
        assertTrue(ModelManagement.fuzzyMatchFields(listOf("gpt-4o", null), "gpt"))
    }

    // --- Recently used entries (GET /admin/models/recent) ---

    @Test
    fun recentPickerOptionMapsAssignEntries() {
        val option = ModelManagement.recentPickerOption(
            "agent",
            RecentModelEntry(
                assignment = "northstar/llama-vision-8b",
                providerId = "northstar",
                providerLabel = "Studio Northstar",
                modelName = "llama-vision-8b",
                apply = RecentModelApply(type = "assign", value = "northstar/llama-vision-8b"),
            ),
        )
        assertEquals("northstar/llama-vision-8b", option?.id)
        assertEquals("northstar", option?.providerId)
        assertEquals("llama-vision-8b", option?.label)
        assertEquals(
            ModelManagement.Apply.Assign("northstar/llama-vision-8b"),
            option?.apply,
        )
    }

    @Test
    fun recentPickerOptionMapsActivateEntries() {
        val option = ModelManagement.recentPickerOption(
            "agent",
            RecentModelEntry(
                assignment = "anthropic/anthropic/claude-sonnet-5",
                providerId = "anthropic",
                providerLabel = "Anthropic",
                modelName = "Claude Sonnet 5",
                apply = RecentModelApply(
                    type = "activate",
                    catalogId = "anthropic/claude-sonnet-5",
                    catalogRole = "agent",
                ),
            ),
        )
        assertEquals(
            ModelManagement.Apply.Activate(
                catalogId = "anthropic/claude-sonnet-5",
                catalogRole = "agent",
                capabilityRole = "agent",
            ),
            option?.apply,
        )
    }

    @Test
    fun recentPickerOptionSkipsIncompleteEntries() {
        // Missing apply payload details → null so the UI skips the row.
        assertNull(
            ModelManagement.recentPickerOption(
                "agent",
                RecentModelEntry(assignment = "x/y", apply = RecentModelApply(type = "assign")),
            ),
        )
        assertNull(
            ModelManagement.recentPickerOption(
                "agent",
                RecentModelEntry(assignment = "local/z", apply = RecentModelApply(type = "activate")),
            ),
        )
        assertNull(
            ModelManagement.recentPickerOption(
                "agent",
                RecentModelEntry(assignment = "x/y", apply = RecentModelApply(type = "bogus", value = "x/y")),
            ),
        )
    }

    // --- Recently used fetching (GET /admin/models/recent) ---

    private fun admin(server: MockWebServer) =
        AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    @Test
    fun loadRecentReturnsEntriesOnSuccess() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(
                MockResponse().setBody(
                    """{"capability":"agent","entries":[{"assignment":"northstar/llama-vision-8b","providerId":"northstar","providerLabel":"Studio Northstar","modelName":"llama-vision-8b","apply":{"type":"assign","value":"northstar/llama-vision-8b"}}]}""",
                ),
            )
            val entries = ModelManagement.loadRecent(admin(server), "agent")
            assertEquals(listOf("northstar/llama-vision-8b"), entries.map { it.assignment })
            assertEquals("/admin/models/recent/agent", server.takeRequest().path)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun loadRecentHidesSectionOnNotFound() = runTest {
        // An older gateway without the route answers 404 — the picker hides
        // the section instead of failing.
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
            assertEquals(emptyList<RecentModelEntry>(), ModelManagement.loadRecent(admin(server), "agent"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun loadRecentHidesSectionOnTransportFailure() = runTest {
        // Unreachable gateway (nothing listening here) — same empty outcome.
        val unreachable = AdminClient(GatewayHttp(OkHttpClient(), "http://127.0.0.1:1/", "tok"))
        assertEquals(emptyList<RecentModelEntry>(), ModelManagement.loadRecent(unreachable, "agent"))
    }

    // --- Backend-name validation (mirrors model-config.js nameValid) ---

    @Test
    fun backendNameValidationAcceptsOrdinaryNames() {
        assertNull(ModelManagement.validateBackendName("my-vllm"))
        assertNull(ModelManagement.validateBackendName("studio_local"))
        // Leading/trailing whitespace is trimmed before validating.
        assertNull(ModelManagement.validateBackendName("  ollama  "))
    }

    @Test
    fun backendNameValidationRejectsReservedAndSlash() {
        assertTrue(ModelManagement.validateBackendName("local") != null)
        assertTrue(ModelManagement.validateBackendName("anthropic") != null)
        assertTrue(ModelManagement.validateBackendName("codex") != null)
        assertTrue(ModelManagement.validateBackendName("replay") != null)
        assertTrue(ModelManagement.validateBackendName("foo/bar") != null)
        assertTrue(ModelManagement.validateBackendName("") != null)
        assertTrue(ModelManagement.validateBackendName("   ") != null)
    }

    // --- HTTP backends list ---

    @Test
    fun httpBackendsExcludesAnthropicAndSortsByKey() {
        val rows = ModelManagement.httpBackends(overview())
        // The anthropic (non-http) backend is filtered out; only `northstar` remains.
        assertEquals(listOf("northstar"), rows.map { it.key })
        assertEquals("http", rows.first().status.type)
    }

    // --- Behavioral capability verify targets ---

    @Test
    fun verifyTargetsOnlyVerifiableRolesSortedByModelThenRole() {
        val row = ModelManagement.httpBackends(overview()).first { it.key == "northstar" }
        // `dots-ocr` is OCR-only → no verifiable role → excluded entirely.
        // `llama-vision-8b` claims ocr+agent → only `agent` is verifiable.
        // `embed-model` claims embedder → verifiable.
        // Sorted by model then role.
        assertEquals(
            listOf("northstar/embed-model/embedder", "northstar/llama-vision-8b/agent"),
            ModelManagement.verifyTargets(row).map { it.id },
        )
    }

    @Test
    fun verifyTargetsEmptyWhenNoVerifiableRoleModel() {
        val row = ModelManagement.BackendRow(
            "ocr-only",
            BackendStatus(
                type = "http",
                status = "ok",
                models = listOf("dots-ocr"),
                modelRoles = mapOf("dots-ocr" to listOf("ocr")),
            ),
        )
        assertTrue(ModelManagement.verifyTargets(row).isEmpty())
    }

    @Test
    fun verifiableRolesIncludePrivacyReviewerAndUnknownLabelsFallBackToRawId() {
        assertTrue("privacy-reviewer" in ModelManagement.VERIFIABLE_ROLES)
        assertTrue(ModelManagement.roleLabel("privacy-reviewer").isNotBlank())
        assertTrue(ModelManagement.roleLabel("privacy-reviewer") != "privacy-reviewer")
        assertEquals("future-role", ModelManagement.roleLabel("future-role"))
    }

    // --- Credential-field validation (mirrors validateCredentialFields) ---

    private fun anthropicSpec() = CredentialSpec(
        fields = listOf(
            CredentialField(
                name = "apiKey",
                label = "API Key",
                placeholder = "sk-ant-…",
                secret = true,
                pattern = "^sk-ant-[A-Za-z0-9_-]+$",
                patternHint = "API keys start with sk-ant-.",
            ),
        ),
    )

    @Test
    fun credentialValidationAcceptsMatchingTrimmedValue() {
        val result = ModelManagement.validateCredentialFields(mapOf("apiKey" to "  sk-ant-example0000  "), anthropicSpec())
        assertTrue(result is ModelManagement.CredentialValidation.Valid)
        // Whitespace trimmed; only declared fields returned.
        assertEquals(mapOf("apiKey" to "sk-ant-example0000"), (result as ModelManagement.CredentialValidation.Valid).cleaned)
    }

    @Test
    fun credentialValidationRejectsMissingRequiredField() {
        val result = ModelManagement.validateCredentialFields(emptyMap(), anthropicSpec())
        assertTrue(result is ModelManagement.CredentialValidation.Invalid)
        assertTrue((result as ModelManagement.CredentialValidation.Invalid).reason.contains("API Key"))
    }

    @Test
    fun credentialValidationRejectsPatternMismatchWithHint() {
        val result = ModelManagement.validateCredentialFields(mapOf("apiKey" to "not-a-real-key"), anthropicSpec())
        assertTrue(result is ModelManagement.CredentialValidation.Invalid)
        assertEquals("API keys start with sk-ant-.", (result as ModelManagement.CredentialValidation.Invalid).reason)
    }

    @Test
    fun credentialValidationAllowsFieldWithoutPattern() {
        val spec = CredentialSpec(fields = listOf(CredentialField(name = "apiKey", label = "API Key", secret = true)))
        val result = ModelManagement.validateCredentialFields(mapOf("apiKey" to "anything-goes"), spec)
        assertTrue(result is ModelManagement.CredentialValidation.Valid)
        assertEquals(mapOf("apiKey" to "anything-goes"), (result as ModelManagement.CredentialValidation.Valid).cleaned)
    }

    // --- Local-model lifecycle helpers (mirrors lib/model-format.js + iOS) ---

    @Test
    fun formatBytes() {
        assertEquals("—", ModelManagement.formatBytes(null))
        assertEquals("512 B", ModelManagement.formatBytes(512))
        assertEquals("2.0 KB", ModelManagement.formatBytes(2048))
        assertEquals("5.0 MB", ModelManagement.formatBytes(5L * 1024 * 1024))
        assertEquals("2.00 GB", ModelManagement.formatBytes(2L * 1024 * 1024 * 1024))
    }

    @Test
    fun downloadPercentClampsAndFloors() {
        assertEquals(0, ModelManagement.downloadPercent(DownloadProgress(downloadedBytes = 0, totalBytes = 0)))
        assertEquals(25, ModelManagement.downloadPercent(DownloadProgress(downloadedBytes = 50, totalBytes = 200)))
        // Floors, not rounds: 99.6% → 99.
        assertEquals(99, ModelManagement.downloadPercent(DownloadProgress(downloadedBytes = 996, totalBytes = 1000)))
        // Over-reported bytes clamp to 100.
        assertEquals(100, ModelManagement.downloadPercent(DownloadProgress(downloadedBytes = 1200, totalBytes = 1000)))
    }

    private fun gguf(id: String, sizeBytes: Long?, minRamGb: Double?) =
        CatalogEntry(kind = "gguf", id = id, name = id, roles = listOf("embed"), sizeBytes = sizeBytes, minRamGb = minRamGb)

    @Test
    fun fitWarningsRamAndDisk() {
        val entry = gguf("m", sizeBytes = 50L * 1024 * 1024 * 1024, minRamGb = 8.0)
        val sys = SystemInfo(totalRamGb = 16.0, freeRamGb = 4.0, modelsDirFreeGb = 10.0)
        val warnings = ModelManagement.fitWarnings(entry, sys)
        assertEquals(2, warnings.size)
        assertTrue(warnings.any { it.text.contains("8 GB free RAM") })
        assertTrue(warnings.any { it.text.contains("Disk free") })
    }

    @Test
    fun fitWarningsEmptyWhenFitsOrNoSnapshot() {
        val entry = gguf("m", sizeBytes = 1L * 1024 * 1024 * 1024, minRamGb = 2.0)
        val roomy = SystemInfo(totalRamGb = 32.0, freeRamGb = 16.0, modelsDirFreeGb = 100.0)
        assertTrue(ModelManagement.fitWarnings(entry, roomy).isEmpty())
        assertTrue(ModelManagement.fitWarnings(entry, null).isEmpty())
    }

    @Test
    fun localModelRowsDeriveState() {
        val overview = ModelsOverview(
            catalog = listOf(
                gguf("installed-one", 100, null),
                gguf("downloading-one", 200, null),
                gguf("available-one", 300, null),
                CatalogEntry(kind = "gguf", id = "agent-only", name = "agent-only", roles = listOf("agent")),
            ),
            installed = listOf(ManifestEntry("installed-one")),
            activeDownloads = listOf(
                ActiveDownload(
                    downloadId = "d1",
                    modelId = "downloading-one",
                    filename = "downloading-one.gguf",
                    progress = DownloadProgress(downloadedBytes = 100, totalBytes = 200),
                    startedAt = "2026-01-01T00:00:00Z",
                ),
            ),
        )
        val rows = ModelManagement.localModelRows("embedder", overview, null)
        // Only embed-role GGUFs; the agent-only one is excluded.
        assertEquals(listOf("installed-one", "downloading-one", "available-one"), rows.map { it.entry.id })
        assertEquals(ModelManagement.LocalModelState.Installed, rows[0].state)
        assertEquals(ModelManagement.LocalModelState.Downloading(50), rows[1].state)
        assertEquals(ModelManagement.LocalModelState.Available, rows[2].state)
    }

    @Test
    fun localModelRowsEmptyForOcrWhichHasNoCatalogRole() {
        val overview = ModelsOverview(
            catalog = listOf(gguf("m", 1, null)),
            installed = emptyList(),
        )
        // ocr has no catalog role → no local GGUF list.
        assertTrue(ModelManagement.localModelRows("ocr", overview, null).isEmpty())
    }
}
