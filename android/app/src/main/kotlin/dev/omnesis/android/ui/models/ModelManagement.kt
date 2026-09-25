// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CatalogEntry
import dev.omnesis.android.transport.dto.CredentialSpec
import dev.omnesis.android.transport.dto.DownloadProgress
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.RecentModelEntry
import dev.omnesis.android.transport.dto.ResolvedAssignment
import dev.omnesis.android.transport.dto.SystemInfo
import dev.omnesis.android.transport.client.AdminClient
import java.util.Locale
import kotlin.math.floor

/**
 * Pure model-management derivations shared by the Models surface (mirrors the
 * iOS `ModelManagement`). Kept out of the view + ViewModel so the three-way
 * capability state, the capability -> catalog role mapping, and the per-role
 * picker-option list are unit-testable and stay in lockstep with the portal
 * (capability-state.js + models.js).
 */
object ModelManagement {

    /** Three-way capability state, mirroring the portal's capabilityCardState. */
    enum class CapabilityState {
        /** Enabled and currently usable (green tick). */
        ON,

        /** Configured but not available right now - needs attention. */
        WARN,

        /** Nothing assigned. */
        OFF,
    }

    /** Mirrors isEnabled in capability-state.js. */
    fun isEnabled(assignment: ResolvedAssignment?): Boolean {
        if (assignment == null) return false
        if (assignment.kind == "disabled" || assignment.kind == "unresolved") return false
        if (assignment.kind == "replay") return true
        return assignment.available == true
    }

    /** Mirrors isConfigured in capability-state.js. */
    fun isConfigured(assignment: ResolvedAssignment?): Boolean {
        if (assignment == null) return false
        return assignment.kind != "disabled" && assignment.kind != "unresolved"
    }

    // Known bug: #1928 — a local GGUF on a chat role reads as enabled here
    // while the gateway's readiness check refuses it.
    fun state(assignment: ResolvedAssignment?): CapabilityState = when {
        isEnabled(assignment) -> CapabilityState.ON
        isConfigured(assignment) -> CapabilityState.WARN
        else -> CapabilityState.OFF
    }

    /**
     * Capability role -> catalog role, the inverse of the gateway's
     * CATALOG_TO_CAPABILITY. `ocr` has no catalog role (its catalog/local
     * lifecycle is out of this surface's scope); it returns null.
     */
    fun catalogRole(capabilityRole: String): String? = when (capabilityRole) {
        "embedder" -> "embed"
        "agent" -> "agent"
        "privacy-reviewer" -> "agent"
        "watch-judge" -> "agent"
        "transcriber" -> "transcribe"
        else -> null
    }

    /** How the gateway is told to assign a picker option. */
    sealed interface Apply {
        /** POST /admin/models/activate with this catalog id + catalog role. */
        data class Activate(
            val catalogId: String,
            val catalogRole: String,
            val capabilityRole: String,
        ) : Apply

        /** PATCH /admin/config with this assignment value ("backend/model"). */
        data class Assign(val value: String) : Apply
    }

    /** One choosable model for a capability, with how to apply it. */
    data class PickerOption(
        val id: String,
        /** Provider brand id for the glyph ("local", "anthropic", the backend key). */
        val providerId: String,
        /** Display name (catalog name, or the raw backend model id). */
        val label: String,
        /** Short qualifier line ("Local downloaded", "Cloud", the backend URL). */
        val detail: String,
        val apply: Apply,
    )

    /**
     * The models the gateway already knows about that can serve `capabilityRole`,
     * ordered as: installed local GGUFs, Anthropic API entries, then each HTTP
     * backend's role-matching models. Mirrors the portal's picker sources, minus
     * the not-yet-installed GGUFs / add-backend / credential steps (a later
     * iteration of this surface).
     */
    fun pickerOptions(capabilityRole: String, overview: ModelsOverview): List<PickerOption> {
        val out = mutableListOf<PickerOption>()
        val catalogRole = catalogRole(capabilityRole)
        val installedIds = overview.installed.map { it.id }.toSet()

        if (catalogRole != null) {
            overview.catalog
                .filter { it.kind == "gguf" && catalogRole in it.roles && it.id in installedIds }
                .forEach {
                    out += PickerOption(
                        id = "local/${it.id}",
                        providerId = "local",
                        label = it.name,
                        detail = "Local · downloaded",
                        apply = Apply.Activate(
                            catalogId = it.id,
                            catalogRole = catalogRole,
                            capabilityRole = capabilityRole,
                        ),
                    )
                }
            overview.catalog
                .filter { it.kind == "anthropic-api" && catalogRole in it.roles }
                .forEach {
                    out += PickerOption(
                        id = "anthropic/${it.id}",
                        providerId = "anthropic",
                        label = it.name,
                        detail = "Cloud",
                        apply = Apply.Activate(
                            catalogId = it.id,
                            catalogRole = catalogRole,
                            capabilityRole = capabilityRole,
                        ),
                    )
                }
        }

        val codex = overview.inference.codex
        if (codex?.configured == true) {
            val detailsById = codex.modelDetails.orEmpty().associateBy { it.id }
            codex.models
                .filter { model -> codex.modelRoles?.get(model)?.contains(capabilityRole) == true }
                .forEach { model ->
                    out += PickerOption(
                        id = "codex/$model",
                        providerId = "codex",
                        label = detailsById[model]?.name ?: model,
                        detail = "Codex",
                        apply = Apply.Assign(value = "codex/$model"),
                    )
                }
        }

        overview.inference.backends.toSortedMap()
            .filterValues {
                it.type == "http" && !(capabilityRole == "watch-judge" && it.protocol == "responses")
            }
            .forEach { (key, backend) ->
                val roles = backend.modelRoles ?: emptyMap()
                (backend.models ?: emptyList())
                    .filter { roles[it]?.contains(capabilityRole) == true }
                    .forEach { model ->
                        out += PickerOption(
                            id = "$key/$model",
                            providerId = key,
                            label = model,
                            detail = backend.url ?: key,
                            apply = Apply.Assign(value = "$key/$model"),
                        )
                    }
            }

        return out
    }

    /**
     * One backend tile in the model picker's first-level grid: the brand glyph
     * id, a title (Local / Anthropic / the backend key), a subtitle (the backend
     * URL or a "N models" count), the count of role-matching picker options, and
     * whether it's a user-managed HTTP backend (those allow a typed custom model
     * id and group their options by the backend key rather than `local` /
     * `anthropic`).
     */
    data class PickerBackend(
        /** "local", "anthropic", or the HTTP backend key — also the brand glyph id. */
        val providerId: String,
        val title: String,
        /**
         * The backend URL for an HTTP backend; null for the built-in `local` /
         * `anthropic` tiles (they show a "N models" count instead).
         */
        val url: String?,
        /** Number of role-matching [PickerOption]s grouped under this backend. */
        val optionCount: Int,
        /** True for a user-managed HTTP backend (enables the typed custom model id). */
        val isHttp: Boolean,
    )

    /**
     * The first-level grid for the model picker: the `local` tile (if any local
     * option serves this role), the `anthropic` tile (if any), then one tile per
     * configured HTTP backend — including HTTP backends with zero role-matching
     * models, so the user can still open one and type a custom model id. Counts
     * come from [pickerOptions], grouped by `providerId`.
     */
    fun pickerBackends(capabilityRole: String, overview: ModelsOverview): List<PickerBackend> {
        val options = pickerOptions(capabilityRole, overview)
        val counts = options.groupingBy { it.providerId }.eachCount()

        val out = mutableListOf<PickerBackend>()
        counts["local"]?.takeIf { it > 0 }?.let { localCount ->
            out += PickerBackend(
                providerId = "local",
                title = "Local",
                url = null,
                optionCount = localCount,
                isHttp = false,
            )
        }
        val codex = overview.inference.codex
        if (codex?.configured == true && (counts["codex"] ?: 0) > 0) {
            out += PickerBackend(
                providerId = "codex",
                title = "Codex",
                url = null,
                optionCount = counts["codex"] ?: 0,
                isHttp = false,
            )
        }
        counts["anthropic"]?.takeIf { it > 0 }?.let { anthropicCount ->
            out += PickerBackend(
                providerId = "anthropic",
                title = "Anthropic",
                url = null,
                optionCount = anthropicCount,
                isHttp = false,
            )
        }
        // Each configured HTTP backend, even with zero role-matching models.
        httpBackends(overview)
            .filterNot { capabilityRole == "watch-judge" && it.status.protocol == "responses" }
            .forEach { backend ->
            out += PickerBackend(
                providerId = backend.key,
                title = backend.key,
                url = backend.status.url,
                optionCount = counts[backend.key] ?: 0,
                isHttp = true,
            )
        }
        return out
    }

    /**
     * The role-matching picker options grouped under one backend tile (its
     * `providerId`), filtered by a fuzzy search over the option label + id:
     * every whitespace-separated query token must occur in either (same rule
     * as the portal's `fuzzy-match.js`, so "deepseek flash" finds
     * `deepseek-ai/DeepSeek-V4-Flash-0731`).
     *
     * Deliberate scope gap vs the portal's Codex list (which also matches the
     * model description): options here carry no description, so only label +
     * id participate. Codex option ids are prefixed (`"codex/<model>"`), so a
     * bare `codex` token matches every Codex row — harmless, arguably useful.
     */
    fun pickerOptions(
        capabilityRole: String,
        overview: ModelsOverview,
        forProviderId: String,
        search: String,
    ): List<PickerOption> {
        return pickerOptions(capabilityRole, overview)
            .filter { it.providerId == forProviderId }
            .filter { fuzzyMatchFields(listOf(it.label, it.id), search) }
    }

    /**
     * Fuzzy model-id matching for the picker search box. Splits the query on
     * whitespace and requires every token to appear in the id
     * (case-insensitive); a blank query matches everything, and a
     * single-token query behaves exactly like the old substring filter.
     */
    fun fuzzyMatchModelId(id: String, query: String): Boolean {
        // Locale.ROOT: model ids are ASCII, and the default-locale fold would
        // miss them on e.g. tr-TR devices ("I".lowercase() -> "ı").
        val tokens = query.trim().lowercase(Locale.ROOT).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return true
        val haystack = id.lowercase(Locale.ROOT)
        return tokens.all { it in haystack }
    }

    /**
     * Token match across several fields — every query token must occur in at
     * least one field, so tokens may match different fields (a name token and
     * an id token). Missing fields are skipped.
     */
    fun fuzzyMatchFields(fields: List<String?>, query: String): Boolean {
        val tokens = query.trim().lowercase(Locale.ROOT).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return true
        val haystacks = fields.map { (it ?: "").lowercase(Locale.ROOT) }
        return tokens.all { token -> haystacks.any { token in it } }
    }

    /**
     * Fetch the "Recently used" entries for a capability. Never throws: any
     * failure — including an HTTP 404 from an older gateway without the route
     * — yields an empty list so the picker hides the section while the
     * backend grid below still works.
     */
    suspend fun loadRecent(admin: AdminClient, capability: String): List<RecentModelEntry> =
        runCatching { admin.recentModels(capability) }.getOrNull()?.entries.orEmpty()

    /**
     * Map one `GET /admin/models/recent` entry to a choosable picker option
     * for [capabilityRole] — an `Activate` for catalog models, an `Assign`
     * for everything else (mirroring how the gateway built the entry).
     * Returns null when the entry's apply payload is incomplete, so the UI
     * skips it instead of offering a dead button.
     */
    fun recentPickerOption(capabilityRole: String, entry: RecentModelEntry): PickerOption? {
        val apply = entry.apply
        return when (apply.type) {
            "activate" -> {
                val catalogId = apply.catalogId ?: return null
                val catalogRole = apply.catalogRole ?: return null
                PickerOption(
                    id = entry.assignment,
                    providerId = entry.providerId,
                    label = entry.modelName.ifBlank { entry.assignment },
                    detail = entry.providerLabel,
                    apply = Apply.Activate(
                        catalogId = catalogId,
                        catalogRole = catalogRole,
                        capabilityRole = capabilityRole,
                    ),
                )
            }
            "assign" -> {
                val value = apply.value ?: return null
                PickerOption(
                    id = entry.assignment,
                    providerId = entry.providerId,
                    label = entry.modelName.ifBlank { entry.assignment },
                    detail = entry.providerLabel,
                    apply = Apply.Assign(value = value),
                )
            }
            else -> null
        }
    }

    // --- HTTP-backend management ---

    /**
     * Backend names the gateway reserves for its built-in backends; an HTTP
     * backend can't take one of these keys. Mirrors RESERVED_BACKEND_NAMES in
     * the portal's model-config.js.
     */
    val RESERVED_BACKEND_NAMES = setOf("local", "anthropic", "codex", "replay")

    /**
     * Validate a proposed HTTP-backend name client-side, matching the portal's
     * nameValid rule (model-config.js): non-blank, not a reserved word, and no
     * "/" (the slash separates backend key from model id in an assignment
     * value). Returns null when valid, else a short human-readable reason. The
     * gateway re-validates on PATCH /admin/config; this is just inline feedback.
     */
    fun validateBackendName(raw: String): String? {
        val name = raw.trim()
        return when {
            name.isEmpty() -> "Name is required."
            name in RESERVED_BACKEND_NAMES -> "Name can't be a reserved word."
            name.contains("/") -> "Name can't contain \"/\"."
            else -> null
        }
    }

    /** One row of the backends list: the backend key plus its probed status. */
    data class BackendRow(val key: String, val status: BackendStatus)

    /**
     * The user-managed HTTP backends, sorted by key. The built-in `anthropic`
     * backend is configured via API-key credentials (the provider-credentials
     * surface), not added/removed here, so it's excluded — matching the portal's
     * Backends list, which only lists `type == "http"` backends as removable rows.
     */
    fun httpBackends(overview: ModelsOverview): List<BackendRow> =
        overview.inference.backends
            .filterValues { it.type == "http" }
            .toSortedMap()
            .map { (key, status) -> BackendRow(key, status) }

    // --- Behavioral capability verify ---

    /**
     * The capability roles `POST /admin/inference/backends/:key/verify` accepts,
     * in display order. Mirrors `VERIFIABLE_ROLES` in
     * `packages/gateway/src/models/routes.ts` (the gateway rejects any other role
     * with a 400). Transcriber/OCR are not behaviorally verifiable here: they
     * have no cheap text-only probe call.
     */
    val VERIFIABLE_ROLES = listOf(
        "embedder",
        "agent",
        "privacy-reviewer",
        "watch-judge",
    )

    /**
     * Human-readable display title for a capability role. Mirrors the `title`
     * field of `CAPABILITY_METADATA` in `@omnesis/core`. Falls back to the raw
     * role id for any unknown role so a new gateway role still renders.
     */
    fun roleLabel(role: String): String = when (role) {
        "embedder" -> "Embedder"
        "agent" -> "Agent"
        "privacy-reviewer" -> "Privacy reviewer"
        "watch-judge" -> "Watch judge"
        "transcriber" -> "Transcriber"
        "ocr" -> "OCR"
        else -> role
    }

    /**
     * One (model, role) pair a backend can be asked to behaviorally verify: a
     * model the backend advertises (via its probe's `modelRoles`) for a role the
     * verify endpoint accepts. Identified by `backendKey/model/role` so verdict
     * state is tracked per pair.
     */
    data class VerifyTarget(val backendKey: String, val model: String, val role: String) {
        val id: String get() = "$backendKey/$model/$role"
    }

    /**
     * The (model, role) pairs worth offering a Verify affordance for on one
     * backend: each model the backend's probe classified into a verifiable role.
     * Sorted by model then role for a stable render. Empty when the backend's
     * probe found no verifiable-role model (e.g. an OCR-only backend, or an
     * unreachable one whose `modelRoles` is empty) — the row then offers no
     * verify affordance.
     */
    fun verifyTargets(row: BackendRow): List<VerifyTarget> {
        val verifiable = VERIFIABLE_ROLES.toSet()
        val roles = row.status.modelRoles ?: emptyMap()
        return (row.status.models ?: emptyList()).sorted().flatMap { model ->
            (roles[model] ?: emptyList())
                .filter { it in verifiable }
                .sorted()
                .map { role -> VerifyTarget(row.key, model, role) }
        }
    }

    // --- Model-provider credentials ---

    /** The cleaned field map on success, or a short reason on the first failure. */
    sealed interface CredentialValidation {
        data class Valid(val cleaned: Map<String, String>) : CredentialValidation
        data class Invalid(val reason: String) : CredentialValidation
    }

    /**
     * Validate raw credential field values against a provider's spec
     * client-side, mirroring the gateway's `validateCredentialFields`: every
     * declared field must be a non-blank (trimmed) string, and any field with a
     * `pattern` must match it. Returns the trimmed field map ready to submit, or
     * the first failing field's reason. The gateway re-validates on `POST`; this
     * is just inline form feedback so the submit button can gate.
     */
    fun validateCredentialFields(raw: Map<String, String>, spec: CredentialSpec): CredentialValidation {
        val cleaned = mutableMapOf<String, String>()
        for (field in spec.fields) {
            val value = (raw[field.name] ?: "").trim()
            if (value.isEmpty()) {
                return CredentialValidation.Invalid("${field.label} is required.")
            }
            val pattern = field.pattern
            if (pattern != null && !Regex(pattern).matches(value)) {
                return CredentialValidation.Invalid(field.patternHint ?: "${field.label} has an invalid format.")
            }
            cleaned[field.name] = value
        }
        return CredentialValidation.Valid(cleaned)
    }

    // --- Local-model lifecycle (mirror iOS ModelManagement) ---

    /**
     * Human-readable byte size, mirroring the portal's `formatBytes`
     * (lib/model-format.js). `null` renders as an em dash.
     */
    fun formatBytes(n: Long?): String {
        if (n == null) return "—"
        val gb = 1024.0 * 1024.0 * 1024.0
        val mb = 1024.0 * 1024.0
        val kb = 1024.0
        val d = n.toDouble()
        return when {
            d >= gb -> String.format(Locale.US, "%.2f GB", d / gb)
            d >= mb -> String.format(Locale.US, "%.1f MB", d / mb)
            d >= kb -> String.format(Locale.US, "%.1f KB", d / kb)
            else -> "$n B"
        }
    }

    /** A system-fit warning for a GGUF catalog entry against a host snapshot. */
    data class FitWarning(val text: String)

    /**
     * System-fit warnings for a GGUF entry relative to a [SystemInfo] snapshot: a
     * free-RAM floor warning and a free-disk warning. Mirrors the portal's `fit`.
     * Empty when the snapshot is absent or the entry isn't a GGUF (those fit
     * unconditionally on the phone surface).
     */
    fun fitWarnings(entry: CatalogEntry, system: SystemInfo?): List<FitWarning> {
        if (system == null || entry.kind != "gguf") return emptyList()
        val out = mutableListOf<FitWarning>()
        val minRamGb = entry.minRamGb
        if (minRamGb != null && system.freeRamGb < minRamGb) {
            out += FitWarning("Needs ${formatGb(minRamGb)} GB free RAM (you have ${formatGb(system.freeRamGb)} GB)")
        }
        val sizeBytes = entry.sizeBytes
        if (sizeBytes != null && system.modelsDirFreeGb < sizeBytes.toDouble() / (1024.0 * 1024.0 * 1024.0)) {
            out += FitWarning("Disk free (${formatGb(system.modelsDirFreeGb)} GB) may not fit ${formatBytes(sizeBytes)}")
        }
        return out
    }

    private fun formatGb(v: Double): String =
        if (v == floor(v)) v.toInt().toString() else String.format(Locale.US, "%.1f", v)

    /** The per-row lifecycle state of a local GGUF catalog entry. */
    sealed interface LocalModelState {
        /** Downloading on the gateway host, at `percent` (0-100). Cancellable. */
        data class Downloading(val percent: Int) : LocalModelState

        /** Downloaded on disk — can be assigned to a role or removed. */
        data object Installed : LocalModelState

        /** Not downloaded — can be installed. */
        data object Available : LocalModelState
    }

    /**
     * One row of the local-model install list: a GGUF catalog entry, its
     * lifecycle state, and any system-fit warnings.
     */
    data class LocalModelRow(
        val entry: CatalogEntry,
        val state: LocalModelState,
        val fitWarnings: List<FitWarning>,
    )

    /**
     * Download completion percent (0-100) from a progress snapshot. Mirrors the
     * portal's `min(100, floor(downloaded / (total || 1) * 100))`.
     */
    fun downloadPercent(progress: DownloadProgress): Int {
        val total = if (progress.totalBytes > 0) progress.totalBytes else 1
        val pct = floor(progress.downloadedBytes.toDouble() / total.toDouble() * 100.0).toInt()
        return pct.coerceIn(0, 100)
    }

    /**
     * The local GGUF models that can serve `capabilityRole`, each decorated with
     * its lifecycle state and fit warnings. Mirrors the portal's `LocalModelList`
     * source filter + per-row state derivation. `null`-catalog-role capabilities
     * (ocr) yield an empty list.
     */
    fun localModelRows(
        capabilityRole: String,
        overview: ModelsOverview,
        system: SystemInfo?,
    ): List<LocalModelRow> {
        val catalogRole = catalogRole(capabilityRole) ?: return emptyList()
        val installedIds = overview.installed.map { it.id }.toSet()
        return overview.catalog
            .filter { it.kind == "gguf" && catalogRole in it.roles }
            .map { entry ->
                val download = overview.activeDownloads.firstOrNull { it.modelId == entry.id }
                val state = when {
                    download != null -> LocalModelState.Downloading(downloadPercent(download.progress))
                    entry.id in installedIds -> LocalModelState.Installed
                    else -> LocalModelState.Available
                }
                LocalModelRow(entry = entry, state = state, fitWarnings = fitWarnings(entry, system))
            }
    }
}
