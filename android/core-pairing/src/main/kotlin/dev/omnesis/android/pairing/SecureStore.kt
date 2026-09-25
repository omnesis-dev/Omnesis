// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

/**
 * Small secret string store. Mirrors the iOS `PairingStore` protocol so it has a
 * trivial in-memory test double and a swappable secure backend.
 */
interface SecureStore {
    fun get(key: String): String?
    fun set(key: String, value: String)
    fun delete(key: String)
    fun deleteAll()
    /** Replace the complete store in one durable commit. */
    fun replaceAll(values: Map<String, String>)
}

/** In-memory store for tests. Mirrors the iOS `InMemoryStore`. */
class InMemoryStore : SecureStore {
    private val values = mutableMapOf<String, String>()

    @Synchronized
    override fun get(key: String): String? = values[key]

    @Synchronized
    override fun set(key: String, value: String) {
        values[key] = value
    }

    @Synchronized
    override fun delete(key: String) {
        values.remove(key)
    }

    @Synchronized
    override fun deleteAll() {
        values.clear()
    }

    @Synchronized
    override fun replaceAll(values: Map<String, String>) {
        this.values.clear()
        this.values.putAll(values)
    }
}
