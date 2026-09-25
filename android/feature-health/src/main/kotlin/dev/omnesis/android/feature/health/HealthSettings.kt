// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import dev.omnesis.android.transport.PushRefusalLedger

/**
 * Abstract string key/value store backing [HealthSettings]. SharedPreferences
 * conforms in production (see `di/HealthModule`); tests inject an
 * [InMemoryKeyValueStore] — the Android analogue of the iOS
 * `KeyValueDefaults` / `DictionaryDefaults` pair.
 */
interface KeyValueStore {
    fun get(key: String): String?

    /** Stores [value] under [key]; null removes the entry. */
    fun put(key: String, value: String?)
}

/** In-memory backing for tests. */
class InMemoryKeyValueStore(
    initial: Map<String, String> = emptyMap(),
) : KeyValueStore {
    private val values = initial.toMutableMap()

    override fun get(key: String): String? = synchronized(values) { values[key] }

    override fun put(key: String, value: String?) {
        synchronized(values) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}

/**
 * Per-user Health Connect preferences. Survives app relaunches (SharedPreferences
 * in production) but is wiped on uninstall.
 *
 * Three pieces of state:
 *  1. [healthConnectEnabled] — the user has opted in to Health Connect syncing.
 *     Drives whether the gateway registers a `health-connect:<account>` source
 *     row and whether the sync worker runs at all.
 *  2. [hasRequestedPermissions] — the Health Connect consent sheet has been
 *     shown at least once, so the app doesn't re-prompt on every launch.
 *  3. [enabledCategories] — which [HealthCategory] groups the user wants
 *     indexed. Disabled categories are skipped by [HealthConnectSource] even if
 *     Health Connect granted read access.
 */
class HealthSettings(private val store: KeyValueStore) {

    object Keys {
        const val ENABLED = "omnesis.hc.enabled"
        const val HAS_REQUESTED = "omnesis.hc.hasRequestedPermissions"
        const val ENABLED_CATEGORIES = "omnesis.hc.enabledCategories"
        const val PUSH_PREFIX = "omnesis.hc.push"
        const val CONSENT_DISMISSALS = "omnesis.hc.consentDismissals"
    }

    /**
     * Consecutive consent requests answered with nothing granted. Health
     * Connect stops showing its sheet after two, so from then on a request
     * goes to its settings screen instead of a contract that silently returns.
     */
    val consentDismissals: Int
        get() = store.get(Keys.CONSENT_DISMISSALS)?.toIntOrNull() ?: 0

    fun recordConsentResult(granted: Set<String>) {
        if (granted.isEmpty()) store.put(Keys.CONSENT_DISMISSALS, (consentDismissals + 1).toString()) else clearConsentDismissals()
    }

    /** A grant was read, so Health Connect's sheet shows again and the count starts over. */
    fun clearConsentDismissals() {
        store.put(Keys.CONSENT_DISMISSALS, null)
    }

    /**
     * Refusals counted against the [HealthSyncUnit] the sync is stuck on, and
     * the record of the units it gave up on. Per unit rather than per source
     * so one record type's refusal neither starves the rest of the catalog nor
     * inherits their successes.
     */
    val pushRefusals = PushRefusalLedger(
        sourceId = HealthSyncCoordinator.SOURCE_ID,
        keyPrefix = Keys.PUSH_PREFIX,
        read = store::get,
        write = store::put,
    )

    var healthConnectEnabled: Boolean
        get() = store.get(Keys.ENABLED) == "true"
        set(value) = store.put(Keys.ENABLED, value.toString())

    var hasRequestedPermissions: Boolean
        get() = store.get(Keys.HAS_REQUESTED) == "true"
        set(value) = store.put(Keys.HAS_REQUESTED, value.toString())

    /**
     * Enabled categories, stored as comma-joined sorted table names. Absent key
     * means the default: everything enabled. Unknown table names in the stored
     * value (e.g. from a newer app version) are ignored.
     */
    var enabledCategories: Set<HealthCategory>
        get() {
            val raw = store.get(Keys.ENABLED_CATEGORIES) ?: return HealthCategory.entries.toSet()
            return raw.split(",")
                .mapNotNull { HealthCategory.fromTableName(it.trim()) }
                .toSet()
        }
        set(value) {
            store.put(Keys.ENABLED_CATEGORIES, value.map { it.tableName }.sorted().joinToString(","))
        }

    fun isCategoryEnabled(category: HealthCategory): Boolean = category in enabledCategories

    fun setCategory(category: HealthCategory, enabled: Boolean) {
        enabledCategories = if (enabled) enabledCategories + category else enabledCategories - category
    }

    /** Wipe every setting — called on unpair so a fresh pairing starts from defaults. */
    fun reset() {
        store.put(Keys.ENABLED, null)
        store.put(Keys.HAS_REQUESTED, null)
        store.put(Keys.ENABLED_CATEGORIES, null)
        store.put(Keys.CONSENT_DISMISSALS, null)
        pushRefusals.clear()
    }
}
