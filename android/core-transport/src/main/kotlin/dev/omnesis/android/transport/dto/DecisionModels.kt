// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A provider preset's decision API (`presets[].decision` in `GET /admin/models`).
 * Mirrors `ProviderPresetView.decision` in `@omnesis/core/models`: everything a
 * backend's `decision` block needs to reach the provider, and the models to
 * offer. Every field is defaulted so a newer gateway's additions and an
 * unknown `protocol` or `auth` still decode.
 */
@Serializable
data class ProviderDecisionPreset(
    /** The endpoint, complete except for the `{param}` placeholders [urlParams] names. */
    val url: String = "",
    val protocol: String = "systemone",
    /** The header that carries the backend's one API key. */
    val auth: String = "bearer",
    /** Which answer field holds the weighted score, when it is not `score`. */
    val scoreField: String? = null,
    /** Whether the provider refuses decision requests without a key. */
    val keyRequired: Boolean = false,
    /** The provider's id in the models.dev decision catalog, which names its logo. */
    val modelsDevId: String? = null,
    val urlParams: List<DecisionUrlParam> = emptyList(),
    /** One sentence the setup form shows under the provider's name. */
    val note: String? = null,
    val docsUrl: String? = null,
    /** Where the operator creates an API key. */
    val keyUrl: String? = null,
    /** Model ids to offer, most useful first: the preset's own and the models.dev catalog's. */
    val models: List<DecisionModelOption> = emptyList(),
)

/** A value the operator supplies to complete a preset's URL, written `{key}` in it. */
@Serializable
data class DecisionUrlParam(
    val key: String = "",
    val label: String = "",
    val placeholder: String = "",
)

/** A decision model a provider offers. Mirrors `DecisionModelOption`. */
@Serializable
data class DecisionModelOption(
    val id: String = "",
    /** Context window in tokens, when models.dev knows it. */
    val contextTokens: Long? = null,
    /** USD per million input tokens, when models.dev knows it. */
    val inputCostPerMillion: Double? = null,
    /** "preset" or "models.dev". */
    val source: String? = null,
)

/**
 * A backend's decision API (`inference.backends.<key>.decision`) as
 * `/admin/models` reports it. Mirrors `BackendDecisionStatus`. The backend's
 * API key is never sent back; [hasApiKey] says whether one is stored.
 */
@Serializable
data class BackendDecisionStatus(
    val url: String = "",
    val protocol: String = "systemone",
    val auth: String = "bearer",
    /** Whether the endpoint is on the gateway host (needs no cloud consent). */
    val onHost: Boolean = false,
    val hasApiKey: Boolean = false,
    /** Why the stored API key could not be read, when it could not. */
    val apiKeySecretError: String? = null,
    /** Stored calibrations onto Jev's scale, by model id. */
    val calibrations: Map<String, DecisionCalibration> = emptyMap(),
)

/**
 * A stored calibration's summary. The map's knots (`points`) are the
 * gateway's business and are not decoded.
 */
@Serializable
data class DecisionCalibration(
    /** What the map was fitted against, e.g. `jev-worth/email-worth-v1/jev-1.13.0`. */
    val reference: String = "",
    /** ISO time of the fit. */
    val fittedAt: String = "",
    val samples: Int? = null,
    /** Share of reference emails where the calibrated model and Jev agree, 0–1. */
    val agreement: Double? = null,
    /** The same agreement before calibration. */
    val agreementBefore: Double? = null,
    /** Share of the reference emails Jev keeps that the calibrated model keeps too, 0–1. */
    val keeps: Double? = null,
    /** The same share before calibration. */
    val keepsBefore: Double? = null,
    /** Share of the reference emails Jev skips that the calibrated model skips too, 0–1. */
    val skips: Double? = null,
    /** The same share before calibration. */
    val skipsBefore: Double? = null,
)

/** The TypeSafe endpoint the Decision model would use (`inference.typesafe`). */
@Serializable
data class TypeSafeEndpointStatus(
    val url: String = "",
    /** Whether the URL points at a deployment of the operator's own. */
    val selfHosted: Boolean = false,
    val onHost: Boolean = false,
)

/** `POST …/backends/:key/decision/verify` and `…/typesafe/verify` body. */
@Serializable
data class DecisionModelBody(val model: String)

/**
 * One test decision's outcome. `reason` is written for the operator (a
 * refused key, a model the server lacks, a server that is not running) and is
 * shown verbatim. Mirrors `DecisionVerifyResult` in `decision-tools.ts`.
 */
@Serializable
data class DecisionVerifyResult(
    val ok: Boolean = false,
    /** The model id the server answered with, which may resolve an alias. */
    val answeredBy: String? = null,
    val latencyMs: Long? = null,
    /** HTTP status of a refused request. */
    val status: Int? = null,
    val reason: String? = null,
)

/**
 * Models a decision server lists. `listed` is false when the server was not
 * asked (a hosted provider): the preset's models are then the suggestions.
 * Mirrors `DecisionProbeResult`.
 */
@Serializable
data class DecisionProbeResult(
    val ok: Boolean = false,
    val models: List<String> = emptyList(),
    val listed: Boolean = false,
    val reason: String? = null,
)

/**
 * `POST /admin/inference/decision/probe` body: a decision API not saved yet.
 * [backendKey] names a saved backend whose API key the gateway sends when
 * [apiKey] is absent. Null fields are left out of the request.
 */
@Serializable
data class DecisionProbeBody(
    val url: String,
    val preset: String? = null,
    val protocol: String? = null,
    val auth: String? = null,
    val apiKey: String? = null,
    val backendKey: String? = null,
) {
    override fun toString(): String =
        "DecisionProbeBody(url=$url, preset=$preset, protocol=$protocol, auth=$auth, " +
            "apiKey=${if (apiKey.isNullOrBlank()) "none" else "<redacted>"}, backendKey=$backendKey)"
}

/**
 * The gateway's calibration job for the assigned Decision model. `state` is
 * "idle", "running", "done", "failed" or "cancelled"; an unknown state is
 * kept as sent. Mirrors `DecisionCalibrationStatus`.
 */
@Serializable
data class DecisionCalibrationStatus(
    val state: String = "idle",
    /** The assignment being (or last) calibrated, `<backend>/<model>`. */
    val assignment: String? = null,
    val done: Int = 0,
    val total: Int = 0,
    val failed: Int = 0,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    val result: DecisionCalibration? = null,
    val error: String? = null,
) {
    val running: Boolean get() = state == "running"
}

/**
 * A backend's decision API as a save writes it (`inference.backends.<key>.decision`).
 * Null fields are left out: the patch merges into the stored block.
 */
data class DecisionEndpointConfig(
    val url: String? = null,
    val protocol: String? = null,
    val auth: String? = null,
    val scoreField: String? = null,
) {
    val isEmpty: Boolean get() = url == null && protocol == null && auth == null && scoreField == null

    internal fun toJson(): JsonObject = buildJsonObject {
        url?.let { put("url", it) }
        protocol?.let { put("protocol", it) }
        auth?.let { put("auth", it) }
        scoreField?.let { put("scoreField", it) }
    }
}

/**
 * The fields a save writes into `inference.backends.<key>`. The config patch
 * is a JSON merge patch, so a null field is left out and keeps its stored
 * value: a new backend sends `type` and everything its preset defines, an
 * existing one only what changes. One backend has one key, used by its
 * OpenAI-compatible API ([url]) and its decision API ([decision]) alike.
 * `apiKey` is write-only: sent once, moved into the gateway's secret store,
 * never read back or printed.
 */
data class BackendConfig(
    /** "http" for a new backend; null when patching one that exists. */
    val type: String? = null,
    /** The preset the backend is made from; null for a server no preset names, or to keep the stored one. */
    val preset: String? = null,
    /** The OpenAI-compatible base URL. */
    val url: String? = null,
    val apiPathPrefix: String? = null,
    val apiKey: String? = null,
    val decision: DecisionEndpointConfig? = null,
) {
    /** Whether the patch would change nothing about the backend itself. */
    val isEmpty: Boolean
        get() = type == null && preset == null && url == null && apiPathPrefix == null &&
            apiKey.isNullOrBlank() && (decision == null || decision.isEmpty)

    internal fun toJson(): JsonObject = buildJsonObject {
        type?.let { put("type", it) }
        preset?.let { put("preset", it) }
        url?.let { put("url", it) }
        apiKey?.trim()?.takeIf { it.isNotEmpty() }?.let { put("apiKey", it) }
        apiPathPrefix?.trim()?.takeIf { it.isNotEmpty() }?.let { put("apiPathPrefix", it) }
        decision?.takeIf { !it.isEmpty }?.let { put("decision", it.toJson()) }
    }

    override fun toString(): String =
        "BackendConfig(type=$type, preset=$preset, url=$url, apiPathPrefix=$apiPathPrefix, " +
            "apiKey=${if (apiKey.isNullOrBlank()) "none" else "<redacted>"}, decision=$decision)"
}

/** The `PATCH /admin/config` bodies that add backends and set up the Decision model. */
object BackendConfigPatch {

    /**
     * Save one backend and, when [decisionModel] is given, assign the
     * Decision model to its decision API — one merge patch, so the backend and
     * its assignment land together. Only [config]'s non-null fields are
     * written; a config with none leaves the backend untouched.
     * [enableRemote] folds the cloud-inference consent into the same write.
     */
    fun saveBackend(
        key: String,
        config: BackendConfig,
        decisionModel: String? = null,
        enableRemote: Boolean = false,
    ): JsonObject = buildJsonObject {
        put(
            "inference",
            buildJsonObject {
                if (enableRemote) put("allowRemoteInference", true)
                if (!config.isEmpty) put("backends", buildJsonObject { put(key, config.toJson()) })
                if (!decisionModel.isNullOrBlank()) {
                    put("assignments", buildJsonObject { put("decision", "$key/$decisionModel") })
                }
            },
        )
    }

    /** Assign the Decision model to TypeSafe's built-in slot. */
    fun assignTypeSafe(model: String, enableRemote: Boolean): JsonObject = buildJsonObject {
        put(
            "inference",
            buildJsonObject {
                if (enableRemote) put("allowRemoteInference", true)
                put("assignments", buildJsonObject { put("decision", "typesafe/$model") })
            },
        )
    }

    /**
     * Stop a backend serving decision models (`decision: null`), keeping its
     * OpenAI-compatible API and key, and clear the Decision model in the same
     * write when [clearAssignment] says it is assigned there. A backend with
     * only a decision API is removed with [removeBackend] instead.
     */
    fun disableDecision(key: String, clearAssignment: Boolean): JsonObject =
        nulls(JsonObject(mapOf(key to JsonObject(mapOf("decision" to JsonNull)))), clearAssignment)

    /**
     * Remove a backend (an explicit `null`, since a missing key is a no-op
     * merge), clearing the Decision model in the same write when
     * [clearAssignment] says it is assigned there.
     */
    fun removeBackend(key: String, clearAssignment: Boolean): JsonObject =
        nulls(JsonObject(mapOf(key to JsonNull)), clearAssignment)

    private fun nulls(backends: JsonObject, clearAssignment: Boolean): JsonObject = buildJsonObject {
        put(
            "inference",
            JsonObject(
                buildMap<String, JsonElement> {
                    put("backends", backends)
                    if (clearAssignment) put("assignments", JsonObject(mapOf("decision" to JsonNull)))
                },
            ),
        )
    }
}
