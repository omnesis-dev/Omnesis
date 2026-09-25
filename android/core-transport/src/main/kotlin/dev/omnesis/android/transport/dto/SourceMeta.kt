// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * One entry of `GET /portal/source-meta.json`. The map is keyed by both full
 * `sourceId` (per-instance override, contains a `:`) and source `type`. `icon` is a
 * rasterized `data:image/...;base64,…` URI emitted by the gateway — the primary icon
 * source on Android (the descriptor's `sfSymbol` is iOS-only).
 */
@Serializable
data class SourceMetaEntry(
    val icon: String? = null,
    val label: String? = null,
    val accentColor: String? = null,
    val bgColor: String? = null,
)
