// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.serialization.Serializable

enum class PairingTlsMode(val persistedValue: String) {
    LEGACY("legacy"),
    SYSTEM("system"),
    PINNED_LEAF("pinned-leaf"),
    ;

    companion object {
        fun fromPersisted(value: String?, fingerprint: String?): PairingTlsMode? =
            if (value == null) {
                if (fingerprint == null) LEGACY else PINNED_LEAF
            } else {
                entries.firstOrNull { it.persistedValue == value }
            }
    }
}

/**
 * Persisted pairing state. Mirrors the iOS `Pairing` struct. New pairings use
 * one complete credential bundle; split-key state is read only for migration.
 */
data class Pairing(
    val url: String,
    val token: String,
    /** Token-row id issued by this exact pairing; changes even when the device id is adopted. */
    val pairingGeneration: String? = null,
    val accountId: String = "local",
    val deviceId: String?,
    val gatewayName: String?,
    val scopes: List<String> = emptyList(),
    val fingerprint: String? = null,
    val tlsMode: PairingTlsMode = PairingTlsMode.LEGACY,
)

/** Complete pairing transaction persisted under one encrypted-store key. */
@Serializable
internal data class PairingCredentialBundle(
    val url: String,
    val token: String,
    val pairingGeneration: String? = null,
    val accountId: String,
    val deviceId: String,
    val name: String,
    val scopes: List<String>,
    val tlsMode: String,
    val fingerprint: String? = null,
)
