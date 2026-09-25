// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import dev.omnesis.android.transport.PushRefusalLedger

/**
 * Abstract string key/value store backing [AppUsageSettings]. SharedPreferences
 * conforms in production (see `di/AppUsageModule`); tests inject an
 * [InMemoryKeyValueStore].
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
 * Per-user App Usage preference. Survives app relaunches (SharedPreferences in
 * production) but is wiped on uninstall.
 *
 * [appUsageEnabled] is the user's opt-in to app-usage syncing: it drives
 * whether the gateway registers an `android-app-usage:local` source row and
 * whether the sync worker runs at all. [explicitEnablePending] records that
 * the user agreed to turn App Usage on and was sent to the usage-access
 * screen, which returns no answer; usage access has no dialog at all (see
 * [AppUsageIntegration.hasUsageAccess]).
 */
class AppUsageSettings(private val store: KeyValueStore) {

    object Keys {
        const val ENABLED = "omnesis.appusage.enabled"
        const val EXPLICIT_ENABLE_PENDING = "omnesis.appusage.explicitEnablePending"
        const val EXPLICIT_ENABLE_CHOICE = "omnesis.appusage.explicitEnableChoice"
        const val PUSH_PREFIX = "omnesis.appusage.push"
    }

    var appUsageEnabled: Boolean
        get() = store.get(Keys.ENABLED) == "true"
        set(value) = store.put(Keys.ENABLED, value.toString())

    /**
     * The user agreed to turn App Usage on and has not yet finished or
     * declined. Only a usage grant found while this is set may complete the
     * enable; a grant made for any other reason never turns App Usage on.
     */
    var explicitEnablePending: Boolean
        get() = store.get(Keys.EXPLICIT_ENABLE_PENDING) == "true"
        set(value) = store.put(Keys.EXPLICIT_ENABLE_PENDING, if (value) "true" else null)

    /** The option the agreement was made with when the gateway asked how this phone should contribute, by name. */
    var explicitEnableChoice: String?
        get() = store.get(Keys.EXPLICIT_ENABLE_CHOICE)
        set(value) = store.put(Keys.EXPLICIT_ENABLE_CHOICE, value)

    /**
     * Refusals counted against the query window the sync is stuck on, and the
     * record of the windows it gave up on. The unit is the instant the window
     * starts at — its end moves with the clock on every pass, its start moves
     * only when a push gets through.
     */
    val pushRefusals = PushRefusalLedger(
        sourceId = AppUsageSyncCoordinator.SOURCE_ID,
        keyPrefix = Keys.PUSH_PREFIX,
        read = store::get,
        write = store::put,
    )

    /** Wipe every setting — called on unpair so a fresh pairing starts from defaults. */
    fun reset() {
        store.put(Keys.ENABLED, null)
        store.put(Keys.EXPLICIT_ENABLE_PENDING, null)
        store.put(Keys.EXPLICIT_ENABLE_CHOICE, null)
        pushRefusals.clear()
    }
}
