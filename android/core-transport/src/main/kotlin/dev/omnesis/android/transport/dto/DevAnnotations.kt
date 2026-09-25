// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/**
 * Request body for `POST /dev/annotations` — the operator → engineer
 * data-quality feedback channel (gated behind `OMNESIS_DEV_MODE`).
 *
 * The `context` snapshot carries the filing platform (`android`) plus the
 * app's version/build alongside the human label, so an engineer triaging
 * with `omnesis dev-annotations` can tell which binary produced the note.
 * Mirrors the iOS `SearchClient.createDevAnnotation` body.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class DevAnnotationBody(
    val targetType: String,
    val targetId: String? = null,
    val note: String,
    val context: Map<String, String>? = null,
    val deepLink: String? = null,
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val client: String = "android",
)
