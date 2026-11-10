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
 * One decision-model provider from `GET /admin/models` (`decisionPresets`).
 * Mirrors `DecisionPresetView` in `@omnesis/core/models`: a server the
 * operator runs (`kind` "local") or a hosted decision API ("cloud"), with
 * everything a decision backend needs to reach it and the models to offer.
 * Every field is defaulted so a newer gateway's additions and an unknown
 * `kind`, `protocol` or `auth` still decode.
 */
@Serializable
data class DecisionPresetView(
    /** Stable id, also the default backend name and the brand id. */
    val id: String = "",
    val name: String = "",
    /** "local" or "cloud"; any other value is shown with the cloud providers. */
    val kind: String = "",
    /** The endpoint, complete except for the `{param}` placeholders [urlParams] names. */
    val url: String = "",
    val protocol: String = "systemone",
    val auth: String = "bearer",
    /** Which answer field holds the weighted score, when it is not `score`. */
    val scoreField: String? = null,
    /** Whether the provider refuses requests without a key. */
    val keyRequired: Boolean = false,
    /** "typesafe" on the preset served by the built-in TypeSafe assignment. */
    val builtIn: String? = null,
    /** The provider's id in the models.dev catalog, which names its logo. */
    val modelsDevId: String? = null,
    val docsUrl: String? = null,
    /** Where the operator creates an API key. */
    val keyUrl: String? = null,
    /** One sentence the setup form shows under the provider's name. */
    val note: String? = null,
    val urlParams: List<DecisionUrlParam> = emptyList(),
    /** Model ids to offer, most useful first. */
    val models: List<DecisionModelOption> = emptyList(),
) {
    val isTypeSafe: Boolean get() = builtIn == "typesafe"
    val isLocal: Boolean get() = kind == "local"
}

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
 * A configured decision backend (`inference.decisionBackends.<key>`) as
 * `/admin/models` reports it. Mirrors `DecisionBackendStatus`. The API key is
 * never sent back; [hasApiKey] says whether one is stored.
 */
@Serializable
data class DecisionBackendStatus(
    /** The preset the backend was made from, when the gateway can tell. */
    val preset: String? = null,
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
)

/** The TypeSafe endpoint the Decision model would use (`inference.typesafe`). */
@Serializable
data class TypeSafeEndpointStatus(
    val url: String = "",
    /** Whether the URL points at a deployment of the operator's own. */
    val selfHosted: Boolean = false,
    val onHost: Boolean = false,
)

/** `POST …/decision-backends/:key/verify` and `…/typesafe/verify` body. */
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
 * The fields a save writes into `inference.decisionBackends.<key>`. The
 * config patch is a JSON merge patch, so a null field is left out and keeps
 * its stored value: a new backend sends everything its preset defines, an
 * existing one only what the operator changed. `apiKey` is write-only: sent
 * once, moved into the gateway's secret store, never read back or printed.
 */
data class DecisionBackendConfig(
    /** The preset id; null for a server no preset names, or to keep the stored one. */
    val preset: String? = null,
    val url: String? = null,
    val protocol: String? = null,
    val auth: String? = null,
    val scoreField: String? = null,
    val apiKey: String? = null,
) {
    /** Whether the patch would change nothing about the backend itself. */
    val isEmpty: Boolean
        get() = preset == null && url == null && protocol == null && auth == null &&
            scoreField == null && apiKey.isNullOrBlank()

    override fun toString(): String =
        "DecisionBackendConfig(preset=$preset, url=$url, protocol=$protocol, auth=$auth, " +
            "scoreField=$scoreField, apiKey=${if (apiKey.isNullOrBlank()) "none" else "<redacted>"})"
}

/** The `PATCH /admin/config` bodies that set up the Decision model. */
object DecisionConfigPatch {

    /**
     * Save one decision backend and, when [model] is given, assign the
     * Decision model to it — one merge patch, so the backend and its
     * assignment land together. Only [config]'s non-null fields are written;
     * a config with none leaves the backend untouched. [enableRemote] folds
     * the cloud-inference consent into the same write.
     */
    fun saveBackend(
        key: String,
        config: DecisionBackendConfig,
        model: String?,
        enableRemote: Boolean,
    ): JsonObject = buildJsonObject {
        put(
            "inference",
            buildJsonObject {
                if (enableRemote) put("allowRemoteInference", true)
                if (!config.isEmpty) {
                    put(
                        "decisionBackends",
                        buildJsonObject {
                            put(
                                key,
                                buildJsonObject {
                                    config.preset?.let { put("preset", it) }
                                    config.url?.let { put("url", it) }
                                    config.protocol?.let { put("protocol", it) }
                                    config.auth?.let { put("auth", it) }
                                    config.scoreField?.let { put("scoreField", it) }
                                    config.apiKey?.trim()?.takeIf { it.isNotEmpty() }?.let { put("apiKey", it) }
                                },
                            )
                        },
                    )
                }
                if (!model.isNullOrBlank()) {
                    put("assignments", buildJsonObject { put("decision", "$key/$model") })
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
     * Remove a decision backend (an explicit `null`, since a missing key is a
     * no-op merge), clearing the Decision model in the same write when
     * [clearAssignment] says it is assigned there.
     */
    fun removeBackend(key: String, clearAssignment: Boolean): JsonObject = buildJsonObject {
        put(
            "inference",
            JsonObject(
                buildMap<String, JsonElement> {
                    put("decisionBackends", JsonObject(mapOf(key to JsonNull)))
                    if (clearAssignment) put("assignments", JsonObject(mapOf("decision" to JsonNull)))
                },
            ),
        )
    }
}
