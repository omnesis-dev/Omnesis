// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** Generic pagination envelope used by every list endpoint. Mirrors the iOS `Page<T>`. */
@Serializable
data class Page<T>(
    val items: List<T> = emptyList(),
    val pageInfo: PageInfo = PageInfo(),
)

@Serializable
data class PageInfo(
    val hasMore: Boolean = false,
    val limit: Int = 0,
    val nextCursor: String? = null,
)
