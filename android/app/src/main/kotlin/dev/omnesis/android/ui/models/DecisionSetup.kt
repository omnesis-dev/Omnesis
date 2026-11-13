// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.BackendConfig
import dev.omnesis.android.transport.dto.BackendDecisionStatus
import dev.omnesis.android.transport.dto.BackendStatus
import dev.omnesis.android.transport.dto.CapabilityMeta
import dev.omnesis.android.transport.dto.DecisionEndpointConfig
import dev.omnesis.android.transport.dto.DecisionModelOption
import dev.omnesis.android.transport.dto.DecisionProbeBody
import dev.omnesis.android.transport.dto.DecisionVerifyResult
import dev.omnesis.android.transport.dto.ModelCredentialEntry
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ProviderDecisionPreset
import dev.omnesis.android.transport.dto.ProviderPreset
import dev.omnesis.android.transport.dto.ResolvedAssignment
import java.net.URI
import java.util.Locale

/**
 * Pure logic behind the Decision model's setup: which providers to offer,
 * the form's URL and name rules, the one config patch a save sends, when the
 * cloud-inference question is needed, and the sentences the card shows. Kept
 * free of Compose so each rule is unit-tested, and kept to the same rules as
 * the portal's decision setup so the clients agree.
 *
 * A decision API belongs to a backend (`inference.backends.<key>.decision`):
 * one provider account with one key, which may also serve an OpenAI-compatible
 * API. TypeSafe is the built-in `typesafe/<model>` assignment instead.
 */
object DecisionSetup {

    /** The capability role the Decision model is assigned under. */
    const val ROLE = "decision"

    /**
     * Names a new decision backend cannot take: the built-in assignment
     * prefixes, and `typesafe`, which the gateway keeps for TypeSafe.
     */
    val RESERVED_NAMES = setOf("local", "anthropic", "codex", "claude-code", "replay", "typesafe")

    private const val MAX_NAME_LENGTH = 64

    /**
     * Whether this app sets the Decision model up. A gateway that predates
     * decision backends sends no preset with a decision API; its Decision
     * card stays read-only.
     */
    fun isConfigurable(cap: CapabilityMeta, overview: ModelsOverview): Boolean =
        cap.isTypedDecision && overview.providers.any { it.decision != null }

    // --- Providers ---

    /** A provider the picker offers. */
    sealed interface Provider {
        val title: String

        /** A backend that already serves decision models, reused by picking a model. */
        data class Existing(
            val key: String,
            val backend: BackendStatus,
            val decision: BackendDecisionStatus,
            val preset: ProviderPreset?,
        ) : Provider {
            override val title: String get() = key
        }

        /**
         * A backend whose preset offers decision models it does not serve yet.
         * Choosing it adds the preset's decision API to the backend, which
         * then uses the key it already has.
         */
        data class Enable(val key: String, val backend: BackendStatus, val preset: ProviderPreset) : Provider {
            override val title: String get() = key
            val decision: ProviderDecisionPreset get() = preset.decision ?: ProviderDecisionPreset()
        }

        /** A preset: a new backend made from it, or TypeSafe's built-in slot. */
        data class Preset(val preset: ProviderPreset) : Provider {
            override val title: String get() = preset.name
        }

        /** "Other server": a System One server no preset names. */
        data object Custom : Provider {
            override val title: String get() = "Other server"
        }
    }

    /**
     * The picker's groups, in the order it shows them: the operator's backends
     * (those serving decisions, then those whose preset offers them), TypeSafe
     * built in, then the providers a new backend can be added from.
     */
    data class ProviderGroups(
        val yours: List<Provider>,
        val builtIn: List<Provider.Preset>,
        val add: List<Provider>,
    )

    /** Presets with a decision API, TypeSafe among them. */
    fun presets(overview: ModelsOverview): List<ProviderPreset> = overview.providers.filter { it.decision != null }

    fun presetFor(overview: ModelsOverview, id: String?): ProviderPreset? =
        id?.let { wanted -> overview.providers.firstOrNull { it.id == wanted } }

    /**
     * Backends serving decisions first, then backends whose preset offers
     * decisions (each sorted by name); TypeSafe; then the presets a new backend
     * can be made from — servers on this machine, hosted APIs, and "Other
     * server" last. A preset some backend was made from is not offered again.
     */
    fun providerGroups(overview: ModelsOverview): ProviderGroups {
        val backends = ModelManagement.httpBackends(overview)
        val existing = backends.mapNotNull { row ->
            row.status.decision?.let { Provider.Existing(row.key, row.status, it, presetFor(overview, row.status.preset)) }
        }
        val enable = backends.mapNotNull { row ->
            if (row.status.decision != null || row.key == TYPESAFE_KEY) return@mapNotNull null
            presetFor(overview, row.status.preset)
                ?.takeIf { it.decision != null && it.builtIn == null }
                ?.let { Provider.Enable(row.key, row.status, it) }
        }
        val all = presets(overview)
        // A preset a backend was already made from is offered above, on that backend.
        val used = backends.mapNotNull { it.status.preset }.toSet()
        val addable = all.filter { it.builtIn == null && it.id !in used }
        return ProviderGroups(
            yours = existing + enable,
            builtIn = all.filter { it.isTypeSafe }.map { Provider.Preset(it) },
            add = addable.filter { it.isLocal }.map { Provider.Preset(it) } +
                addable.filter { !it.isLocal }.map { Provider.Preset(it) } +
                Provider.Custom,
        )
    }

    /** The preset behind a provider, if any. */
    fun presetOf(provider: Provider): ProviderPreset? = when (provider) {
        is Provider.Existing -> provider.preset
        is Provider.Enable -> provider.preset
        is Provider.Preset -> provider.preset
        Provider.Custom -> null
    }

    /** The brand id a provider's icon is drawn from. */
    fun brandId(provider: Provider): String = presetOf(provider)?.id ?: "http"

    /**
     * Whether listing a server's models is worth asking: only a server of the
     * operator's own lists them. Hosted providers mix chat and decision models,
     * so their presets name theirs.
     */
    fun canProbe(provider: Provider): Boolean {
        val preset = presetOf(provider)
        return preset == null || preset.isLocal
    }

    /**
     * What to ask a server not saved as a decision backend for its models, at
     * [url]. A typed key is sent as it is; a backend gaining decisions is
     * named so the gateway sends the key it holds for that backend.
     */
    fun unsavedProbe(provider: Provider, url: String, apiKey: String): DecisionProbeBody {
        val preset = presetOf(provider)
        return DecisionProbeBody(
            url = url,
            preset = preset?.id,
            protocol = preset?.decision?.protocol,
            auth = preset?.decision?.auth,
            apiKey = apiKey.trim().ifEmpty { null },
            backendKey = (provider as? Provider.Enable)?.key,
        )
    }

    /** Where a local preset's server listens: "On this host · port 11435", or its URL's host. */
    fun localPlace(url: String): String {
        if (!isOnHost(url)) return hostOf(url) ?: url
        val port = runCatching { URI(url.trim()).port }.getOrDefault(-1)
        return if (port != -1) "On this host · port $port" else "On this host"
    }

    /** A short location label for a decision API: "On this host" or the URL's host. */
    fun where(decision: BackendDecisionStatus): String =
        if (decision.onHost) "On this host" else hostOf(decision.url) ?: decision.url

    /** The picker's second line for a provider. */
    fun subtitle(provider: Provider): String = when (provider) {
        is Provider.Existing -> listOfNotNull(provider.preset?.name, where(provider.decision)).joinToString(" · ")
        is Provider.Enable -> if (provider.backend.hasApiKey == true) {
            "${provider.preset.name} · uses your existing key"
        } else {
            "${provider.preset.name} · add decision models"
        }
        is Provider.Preset -> {
            val decision = provider.preset.decision
            if (provider.preset.isLocal && decision != null) {
                localPlace(decision.url)
            } else {
                val count = decision?.models?.size ?: 0
                "$count model${if (count == 1) "" else "s"}"
            }
        }
        Provider.Custom -> "Any System One server, by URL"
    }

    // --- The form ---

    /**
     * Why [raw] cannot name a new decision backend, or null. [existingKey] is
     * the backend being edited, whose own name is allowed.
     */
    fun nameError(raw: String, overview: ModelsOverview, existingKey: String? = null): String? {
        val key = raw.trim()
        return when {
            key.isEmpty() -> "Enter a name."
            key.length > MAX_NAME_LENGTH -> "Use at most $MAX_NAME_LENGTH characters."
            key.contains("/") -> "A name cannot contain \"/\"."
            key in RESERVED_NAMES -> "\"$key\" is reserved."
            key == existingKey -> null
            key in overview.inference.backends -> "\"$key\" is already a backend."
            else -> null
        }
    }

    /** A free name for a new backend: the preset's id, then id-2, id-3… */
    fun defaultName(preset: ProviderPreset?, overview: ModelsOverview): String {
        val base = preset?.id?.takeIf { it.isNotBlank() } ?: "decision-server"
        var candidate = base
        var n = 2
        while (nameError(candidate, overview) != null) {
            candidate = "$base-$n"
            n += 1
        }
        return candidate
    }

    /** Why [raw] cannot be a decision endpoint, or null for an http(s) URL with a host. */
    fun urlError(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return "Enter the server's URL."
        val uri = runCatching { URI(trimmed) }.getOrNull()
        val http = uri?.scheme?.lowercase(Locale.ROOT) in setOf("http", "https")
        return if (http && !authorityHost(uri).isNullOrEmpty()) null
        else "Enter a full URL, such as http://127.0.0.1:8080/v1/systemone."
    }

    /**
     * The host a URL names. [URI.getHost] is null for a name outside the
     * strict hostname grammar (an underscore, say), so the authority is read
     * without its user info and port.
     */
    private fun authorityHost(uri: URI?): String? = uri?.host
        ?: uri?.rawAuthority?.substringAfterLast('@')?.substringBefore(':')

    /** The URL a preset fills in, or why it cannot yet. */
    sealed interface FilledUrl {
        data class Ok(val url: String) : FilledUrl
        data class Missing(val message: String) : FilledUrl
    }

    /**
     * Fill a decision API's `{param}` placeholders with the operator's values,
     * each URL-encoded as JavaScript's `encodeURIComponent` does — the
     * gateway's `fillDecisionPresetUrl` rule.
     */
    fun fillUrl(decision: ProviderDecisionPreset, params: Map<String, String>): FilledUrl {
        var url = decision.url
        for (param in decision.urlParams) {
            val value = params[param.key]?.trim().orEmpty()
            if (value.isEmpty()) return FilledUrl.Missing("Enter your ${param.label.lowercase(Locale.ROOT)}.")
            url = url.replace("{${param.key}}", encodeUriComponent(value))
        }
        val left = PLACEHOLDER.find(url)
        return if (left != null) FilledUrl.Missing("The URL still has {${left.groupValues[1]}}.") else FilledUrl.Ok(url)
    }

    private val PLACEHOLDER = Regex("\\{([a-zA-Z][a-zA-Z0-9-]*)\\}")

    private const val URI_COMPONENT_SAFE =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

    /** JavaScript's `encodeURIComponent`: UTF-8 percent-encoding of everything but the unreserved marks. */
    fun encodeUriComponent(value: String): String = buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val ch = (byte.toInt() and 0xFF).toChar()
            if (ch.code < 0x80 && ch in URI_COMPONENT_SAFE) append(ch)
            else append('%').append("%02X".format(Locale.ROOT, byte.toInt() and 0xFF))
        }
    }

    /** Whether a URL is on the gateway host — the portal's `isLoopbackInferenceUrl`. */
    fun isOnHost(url: String): Boolean {
        val host = runCatching { URI(url.trim()).host }.getOrNull()
            ?.removePrefix("[")?.removeSuffix("]")?.lowercase(Locale.ROOT)
            ?: return false
        return host == "localhost" || host.endsWith(".localhost") || host == "::1" ||
            Regex("^127(\\.\\d{1,3}){3}$").matches(host)
    }

    private fun hostOf(url: String): String? = runCatching {
        val uri = URI(url)
        uri.host?.let { host -> if (uri.port != -1) "$host:${uri.port}" else host }
    }.getOrNull()

    /** Whether the API key field must be filled before saving. */
    fun keyRequired(provider: Provider, overview: ModelsOverview, typesafeKey: KeyState): Boolean = when (provider) {
        is Provider.Existing -> provider.preset?.decision?.keyRequired == true && !provider.decision.hasApiKey
        // The backend's own key serves its decision API too; only a backend without one asks.
        is Provider.Enable -> provider.decision.keyRequired && provider.backend.hasApiKey != true
        is Provider.Preset -> if (provider.preset.isTypeSafe) {
            // A deployment of the operator's own may run without a key, and a key
            // whose state could not be read may well be there.
            overview.inference.typesafe?.selfHosted != true &&
                typesafeKeyFor(overview, typesafeKey) == KeyState.Missing
        } else {
            provider.preset.decision?.keyRequired == true
        }
        Provider.Custom -> false
    }

    /** Whether a key is already stored for this provider, so a blank field keeps it. */
    fun keyStored(provider: Provider, overview: ModelsOverview, typesafeKey: KeyState): Boolean = when (provider) {
        is Provider.Existing -> provider.decision.hasApiKey
        is Provider.Enable -> provider.backend.hasApiKey == true
        is Provider.Preset -> provider.preset.isTypeSafe && typesafeKeyFor(overview, typesafeKey) == KeyState.Stored
        Provider.Custom -> false
    }

    /** Whether the gateway holds a TypeSafe key, as far as this app could read. */
    sealed interface KeyState {
        data object Stored : KeyState
        data object Missing : KeyState
        /** The credential list could not be read; [reason] says why. */
        data class Unknown(val reason: String) : KeyState
    }

    /**
     * The TypeSafe key's state: the assigned TypeSafe model's `hasApiKey` is
     * the gateway's own word, ahead of the credential list.
     */
    /** Whether the credential list names a TypeSafe key, in its file or the gateway's environment. */
    fun typesafeKeyListed(entries: List<ModelCredentialEntry>): Boolean =
        entries.firstOrNull { it.fileKey == TYPESAFE_KEY }?.let { it.configured || it.environment } ?: false

    fun typesafeKeyFor(overview: ModelsOverview, fromCredentials: KeyState): KeyState {
        val assigned = assignment(overview)?.takeIf { it.kind == "typesafe" }
        return if (assigned?.hasApiKey == true) KeyState.Stored else fromCredentials
    }

    // --- Model suggestions ---

    /** A model the form suggests; [installed] when the server itself listed it. */
    data class ModelSuggestion(val option: DecisionModelOption, val installed: Boolean)

    /** The ids the server reported first (they are installed), then the preset's own. */
    fun modelSuggestions(decision: ProviderDecisionPreset?, probed: List<String>): List<ModelSuggestion> {
        val known = decision?.models.orEmpty()
        val seen = mutableSetOf<String>()
        val out = mutableListOf<ModelSuggestion>()
        for (id in probed) {
            if (id.isBlank() || !seen.add(id)) continue
            out += ModelSuggestion(known.firstOrNull { it.id == id } ?: DecisionModelOption(id = id), installed = true)
        }
        for (option in known) {
            if (!seen.add(option.id)) continue
            out += ModelSuggestion(option, installed = false)
        }
        return out
    }

    /** "128k context · $0.10/M input tokens", or "" when neither is known. */
    fun modelHint(option: DecisionModelOption): String {
        val parts = mutableListOf<String>()
        option.contextTokens?.takeIf { it > 0 }?.let { parts += "${formatTokens(it)} context" }
        option.inputCostPerMillion?.takeIf { it >= 0 }?.let { parts += formatPrice(it) }
        return parts.joinToString(" · ")
    }

    private fun formatTokens(n: Long): String = when {
        n >= 1_000_000 -> "${trimDecimal(n / 1_000_000.0)}M"
        n >= 1000 -> "${Math.round(n / 1000.0)}k"
        else -> n.toString()
    }

    private fun trimDecimal(v: Double): String {
        val rounded = Math.round(v * 10) / 10.0
        return if (rounded == Math.floor(rounded)) rounded.toLong().toString() else rounded.toString()
    }

    private fun formatPrice(n: Double): String {
        if (n == 0.0) return "free"
        val digits = if (n < 0.01) 3 else 2
        return "$" + String.format(Locale.ROOT, "%.${digits}f", n) + "/M input tokens"
    }

    // --- Saving ---

    /** What a save writes, before the consent question is settled. */
    sealed interface SaveRequest {
        val model: String

        /**
         * Save (or update) a backend and assign the model to its decision API.
         * [endpoint] is the decision URL the backend will call, whether or not
         * the patch rewrites it; the consent question reads it.
         */
        data class Backend(
            val key: String,
            val config: BackendConfig,
            override val model: String,
            val endpoint: String,
            val enableRemote: Boolean = false,
        ) : SaveRequest

        /** Assign TypeSafe, first storing a newly typed key through its credential. */
        data class TypeSafe(
            override val model: String,
            val apiKey: String?,
            val enableRemote: Boolean = false,
        ) : SaveRequest {
            override fun toString(): String =
                "TypeSafe(model=$model, apiKey=${if (apiKey.isNullOrBlank()) "none" else "<redacted>"}, " +
                    "enableRemote=$enableRemote)"
        }

        /** The assignment this save makes, `<key>/<model>`. */
        val assignment: String
            get() = when (this) {
                is Backend -> "$key/$model"
                is TypeSafe -> "$TYPESAFE_KEY/$model"
            }

        /** The same save, with the operator's cloud-inference consent folded in. */
        fun withConsent(): SaveRequest = when (this) {
            is Backend -> copy(enableRemote = true)
            is TypeSafe -> copy(enableRemote = true)
        }
    }

    /**
     * The save for a new backend: the preset's OpenAI-compatible API too when
     * it has one (one key for both), its decision API at [decisionUrl] with the
     * preset's protocol, auth and score field (System One with a bearer key for
     * "Other server"), and a key only when one was typed.
     */
    fun newBackendSave(
        key: String,
        preset: ProviderPreset?,
        decisionUrl: String,
        apiKey: String,
        model: String,
    ): SaveRequest.Backend = SaveRequest.Backend(
        key = key.trim(),
        config = ModelManagement.newBackendConfig(
            preset = preset,
            url = preset?.defaultUrl?.takeIf { preset.hasOpenAiApi },
            apiPathPrefix = preset?.apiPathPrefix?.takeIf { preset.hasOpenAiApi },
            decisionUrl = decisionUrl,
            apiKey = apiKey,
        ),
        model = model.trim(),
        endpoint = decisionUrl.trim(),
    )

    /**
     * The save that adds a preset's decision API to a backend that exists:
     * only the `decision` block, so the backend keeps its URL, preset and key —
     * the key is not asked again. A key is written only for a backend that has
     * none and was given one here.
     */
    fun enableSave(enable: Provider.Enable, decisionUrl: String, apiKey: String, model: String): SaveRequest.Backend {
        val url = decisionUrl.trim()
        val wire = enable.decision
        return SaveRequest.Backend(
            key = enable.key,
            config = BackendConfig(
                apiKey = apiKey.trim().ifEmpty { null }?.takeIf { enable.backend.hasApiKey != true },
                decision = DecisionEndpointConfig(url = url, protocol = wire.protocol, auth = wire.auth, scoreField = wire.scoreField),
            ),
            model = model.trim(),
            endpoint = url,
        )
    }

    /**
     * The save for a backend that serves decisions already: only what the
     * operator changed — a new decision URL, a newly typed key — and the model
     * assignment. Its protocol, auth, score field and preset stay as stored,
     * whoever wrote them.
     */
    fun existingBackendSave(
        existing: Provider.Existing,
        url: String,
        apiKey: String,
        model: String,
    ): SaveRequest.Backend {
        val typedUrl = url.trim()
        val changedUrl = typedUrl.takeIf { it.isNotEmpty() && it != existing.decision.url }
        return SaveRequest.Backend(
            key = existing.key,
            config = BackendConfig(
                apiKey = apiKey.trim().ifEmpty { null },
                decision = changedUrl?.let { DecisionEndpointConfig(url = it) },
            ),
            model = model.trim(),
            endpoint = changedUrl ?: existing.decision.url,
        )
    }

    /**
     * Taking decision models away from a backend: a backend that also serves
     * an OpenAI-compatible API loses only its decision API ([wholeBackend]
     * false); one that serves nothing else is removed. [clearAssignment] when
     * the Decision model is assigned there.
     */
    data class Removal(val key: String, val wholeBackend: Boolean, val clearAssignment: Boolean)

    fun removalFor(existing: Provider.Existing, overview: ModelsOverview): Removal = Removal(
        key = existing.key,
        wholeBackend = !existing.backend.hasOpenAiApi,
        clearAssignment = assignedBackend(overview)?.key == existing.key,
    )

    /** Who the cloud-inference question names, and for which model. */
    data class Consent(val modelName: String, val providerLabel: String)

    /**
     * The cloud-inference question a save needs, or null. Off-host inference
     * is the operator's call: with `allowRemoteInference` off, an endpoint
     * not on the gateway host asks first. TypeSafe on a deployment of the
     * operator's own on the host asks nothing; elsewhere it names that URL.
     */
    fun consentFor(request: SaveRequest, overview: ModelsOverview, preset: ProviderPreset?): Consent? {
        if (overview.inference.allowRemoteInference) return null
        return when (request) {
            is SaveRequest.TypeSafe -> {
                val endpoint = overview.inference.typesafe
                when {
                    endpoint?.selfHosted == true && endpoint.onHost -> null
                    endpoint?.selfHosted == true -> Consent(request.model, endpoint.url)
                    else -> Consent(request.model, "TypeSafe")
                }
            }
            is SaveRequest.Backend -> {
                val url = request.endpoint
                when {
                    isOnHost(url) -> null
                    preset != null && !preset.isLocal -> Consent(request.model, preset.name)
                    else -> Consent(request.model, url)
                }
            }
        }
    }

    /** The cloud-inference consent text, matching the portal's. */
    fun consentBody(consent: Consent): List<String> = listOf(
        "Using ${consent.modelName} sends messages, conversation context, and relevant Omnesis data and tool " +
            "results to ${consent.providerLabel}. Depending on the capabilities you configure, this can also " +
            "include search queries, document chunks, audio, and images.",
        "This permission applies to this gateway's configured remote inference backends, not only " +
            "${consent.modelName}. You can turn it off in Settings → Models.",
    )

    // --- The assigned model ---

    /** The Decision model's assignment when it is on a backend's decision API. */
    data class AssignedBackend(
        val key: String,
        val model: String,
        val backend: BackendStatus?,
    ) {
        val value: String get() = "$key/$model"
        val decision: BackendDecisionStatus? get() = backend?.decision
    }

    fun assignment(overview: ModelsOverview): ResolvedAssignment? = overview.inference.assignments[ROLE]

    fun assignedBackend(overview: ModelsOverview): AssignedBackend? {
        val assignment = assignment(overview) ?: return null
        if (assignment.kind != "decision") return null
        val key = assignment.backendKey ?: return null
        val backend = overview.inference.backends[key]
        return AssignedBackend(
            key = key,
            model = assignment.model.orEmpty(),
            backend = backend,
        )
    }

    /** The TypeSafe model assigned, or null when the Decision model is elsewhere. */
    fun assignedTypeSafeModel(overview: ModelsOverview): String? =
        assignment(overview)?.takeIf { it.kind == "typesafe" }?.model

    /** The provider the current assignment uses, so the picker can mark it. */
    fun isCurrent(provider: Provider, overview: ModelsOverview): Boolean = when (provider) {
        is Provider.Existing -> assignedBackend(overview)?.key == provider.key
        is Provider.Enable -> false
        is Provider.Preset -> provider.preset.isTypeSafe && assignedTypeSafeModel(overview) != null
        Provider.Custom -> false
    }

    /** The model to prefill when a provider's form opens: the one already assigned there. */
    fun initialModel(provider: Provider, overview: ModelsOverview): String = when (provider) {
        is Provider.Existing -> assignedBackend(overview)?.takeIf { it.key == provider.key }?.model.orEmpty()
        is Provider.Enable -> ""
        is Provider.Preset -> if (provider.preset.isTypeSafe) assignedTypeSafeModel(overview).orEmpty() else ""
        Provider.Custom -> ""
    }

    /** The assignment prefix, and credential file key, of TypeSafe's built-in slot. */
    const val TYPESAFE_KEY = "typesafe"

    // --- Verify ---

    /** What the card shows for a test decision. */
    sealed interface VerifyState {
        data object Idle : VerifyState
        data class Running(val assignment: String) : VerifyState
        data class Done(val assignment: String, val result: DecisionVerifyResult) : VerifyState
    }

    /**
     * The answer time, or the server's reason verbatim. The answering model is
     * named only when it is not [model], the one that was asked for.
     */
    fun verifyText(result: DecisionVerifyResult, model: String): String = if (result.ok) {
        val via = result.answeredBy?.takeIf { it.isNotBlank() && it != model }?.let { " by $it" }.orEmpty()
        result.latencyMs?.let { "Answered$via in $it ms." } ?: "Answered$via."
    } else {
        result.reason?.takeIf { it.isNotBlank() } ?: "The model did not answer."
    }
}
