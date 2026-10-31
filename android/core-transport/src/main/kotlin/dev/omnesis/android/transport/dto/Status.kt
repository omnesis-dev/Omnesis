// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** `GET /status`. Mirrors the iOS `StatusSnapshot`. */
@Serializable
data class StatusSnapshot(
    val documents: Documents = Documents(),
    val modelHealth: ModelHealth = ModelHealth(),
    /** The main database file alone. Kept for gateways that predate [diskUsage]. */
    val dbSizeBytes: Long? = null,
    /**
     * Everything the gateway keeps on disk. Absent from a gateway that predates the
     * field, and null before its first measurement finishes.
     */
    val diskUsage: DiskUsage? = null,
    val latestActivityBySource: Map<String, LatestActivity>? = null,
    /**
     * Whether the gateway runs in experimental mode (`OMNESIS_EXPERIMENTAL=1`
     * or synthetic mode). Gates discovery of experimental surfaces. Defaults
     * to `false` so an older gateway that omits the field keeps experimental
     * features hidden.
     */
    val experimental: Boolean = false,
    /** Private speech hints are opt-in; older gateways omit this field. */
    val transcriptionVocabulary: Boolean = false,
    /**
     * Whether the gateway runs in developer mode (`OMNESIS_DEV_MODE=1`).
     * Reveals the developer-annotation capture affordance
     * (shake-to-annotate). Defaults to `false` until `/status` has been
     * fetched, and for any gateway that omits the field — so the affordance
     * stays hidden by default. Mirrors the iOS `StatusSnapshot.developer`.
     */
    val developer: Boolean = false,
    /**
     * The Tasks gate. Absent on a gateway that predates Tasks, which reads as "no Tasks
     * screen" rather than as a fault.
     */
    val tasks: TasksStatusDto? = null,
    /**
     * The gateway-dictation gate. Absent on a gateway that predates
     * the field, which reads as inactive: notes keep only the phone's transcript.
     */
    val dictation: DictationStatusDto? = null,
    /**
     * Optional features a client must ask about before offering them, each named with the
     * protocol versions the gateway speaks (`{ min, max }`). Kept as raw JSON because the map
     * mixes shapes and grows over time: one entry this build misreads must not cost the whole
     * status. Absent on a gateway that predates the map.
     */
    val capabilities: JsonElement? = null,
) {
    /** The gateway opens a conversation about a task (`POST /tasks/:id/conversation`). */
    val taskConversations: Boolean
        get() = speaks(TASK_CONVERSATIONS, TASK_CONVERSATIONS_VERSION)

    /** Whether the capability [name] advertises a version range that includes [version]. */
    private fun speaks(name: String, version: Int): Boolean {
        val range = ((capabilities as? JsonObject)?.get(name) as? JsonObject) ?: return false
        fun bound(key: String): Int? = (range[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        val min = bound("min") ?: return false
        val max = bound("max") ?: return false
        return version in min..max
    }

    /**
     * What the "on disk" stat shows: the gateway's whole footprint, or the main
     * database alone from a gateway that does not report one.
     */
    val onDiskBytes: Long?
        get() = diskUsage?.totalBytes ?: dbSizeBytes

    /** The total of `GET /status`'s `diskUsage`; the per-store breakdown is not rendered here. */
    @Serializable
    data class DiskUsage(val totalBytes: Long)

    companion object {
        const val TASK_CONVERSATIONS = "taskConversations"

        /** The `taskConversations` protocol version this build speaks. */
        const val TASK_CONVERSATIONS_VERSION = 1
    }

    @Serializable
    data class Documents(
        val total: Int = 0,
        val bySource: Map<String, Int> = emptyMap(),
        val unitCountBySource: Map<String, Int?>? = null,
    )

    @Serializable
    data class LatestActivity(
        val kind: String = "document",
        val docId: String? = null,
        val title: String? = null,
        val latestActivityAt: String,
        val sourceCreatedAt: String? = null,
        val ingestedAt: String? = null,
        val isNew: Boolean? = null,
        val tableName: String? = null,
        val tableDisplayName: String? = null,
    )
}

/** `GET /whoami`. */
@Serializable
data class Whoami(
    val tokenId: String,
    val deviceId: String? = null,
    val deviceName: String? = null,
    val scopes: List<String> = emptyList(),
)

/**
 * Whether the paired gateway serves the Tasks journal (`tasks` on `GET /status`). Tasks work
 * on every install, with or without a model, so this is never gated on experimental mode.
 */
@Serializable
data class TasksStatusDto(
    /** The `/tasks` routes answer. */
    val available: Boolean = false,
    /**
     * A Tell Omnesis note is read by an agent turn that can add and change tasks, so the
     * capture surface may say that Omnesis will act on it.
     */
    val noteAgent: Boolean = false,
)

/**
 * Whether dictation audio from this app goes to the gateway's transcriber
 * (`dictation` on `GET /status`). Mirrors `DictationFeatureStatus` in
 * `packages/gateway/src/dictation/feature-gate.ts`.
 */
@Serializable
data class DictationStatusDto(
    /** The gateway offers the setting, so it may be shown. */
    val visible: Boolean = false,
    /** The operator switched gateway dictation on. */
    val enabled: Boolean = false,
    /** A runnable transcriber model is assigned. */
    val modelAssigned: Boolean = false,
    /**
     * All three hold: Tell Omnesis keeps the audio it dictates and sends it with the note
     * (`POST /notes/voice`), for the gateway to transcribe after the note is saved.
     */
    val active: Boolean = false,
    /** Why the transcriber cannot run, when it cannot; addressed to the settings surface. */
    val reason: String? = null,
    /** The largest audio part `POST /notes/voice` accepts. */
    val maxAudioBytes: Long = 0,
)
