// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /admin/source-descriptors` (within a [Page]). Mirrors the iOS
 * `SerializedDescriptor`. This is the contract that lets the client render every
 * source generically — never branch on a source type. NOTE: `SourceIcon.sfSymbol`
 * is an iOS SF Symbol name and is meaningless on Android; resolve icons from
 * `imageDataUri`/`url`/source-meta PNG and the cross-platform `color`/`bgColor`.
 */
@Serializable
data class SerializedDescriptor(
    @SerialName("id") val typeId: String,
    val name: String,
    val description: String = "",
    val authType: String = "none",
    val singleInstance: Boolean = false,
    val hasAuthFlow: Boolean = false,
    val hasDiscover: Boolean = false,
    val provider: Provider = Provider(),
    val unitName: String? = null,
    val icon: SourceIcon? = null,
    val attribution: SourceAttribution? = null,
) {
    @Serializable
    data class Provider(
        val id: String = "",
        val name: String = "",
    )
}

@Serializable
data class SourceIcon(
    val sfSymbol: String? = null,
    val color: String? = null,
    val bgColor: String? = null,
    val url: String? = null,
    val imageDataUri: String? = null,
)

@Serializable
data class SourceAttribution(
    val itemFooter: String? = null,
)
