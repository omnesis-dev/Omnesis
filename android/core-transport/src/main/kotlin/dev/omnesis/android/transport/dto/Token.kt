// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * `GET /admin/tokens`. Mirrors `TokenInfo` in the gateway's
 * `TokenRepository.ts` — the shape `listTokens` returns. Revoked tokens are
 * deleted (not flagged), so there is no `revokedAt`; `lastUsedAt` is null until
 * the token has authenticated a request at least once.
 */
@Serializable
data class TokenRecord(
    val id: String,
    val deviceId: String,
    val name: String? = null,
    val scopes: List<String> = emptyList(),
    val createdAt: Long = 0,
    val lastUsedAt: Long? = null,
)

/**
 * Body of `POST /admin/tokens` — mint a new credential. The app mints only its
 * own narrow `push:claim` credential this way. `OmnesisJson` drops the null `name`.
 */
@Serializable
data class CreateTokenBody(
    val deviceId: String,
    val scopes: List<String>,
    val name: String? = null,
)

/**
 * Response of `POST /admin/tokens`. The raw `token` is present ONLY here — the
 * gateway stores its hash, so it can never be retrieved again. `expiresAt` is
 * null for a never-expiring token (the app never sets a TTL).
 */
@Serializable
data class MintedToken(
    val id: String,
    val deviceId: String,
    val scopes: List<String> = emptyList(),
    val name: String? = null,
    val token: String,
    val expiresAt: Long? = null,
)
