// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import dev.omnesis.android.transport.PushRefusalLedger

/**
 * Abstract string key/value store backing [ActivitySegmentsSettings].
 * SharedPreferences conforms in production (see `di/ActivitySegmentsModule`);
 * tests inject an [InMemoryKeyValueStore].
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
 * Per-user Activity Segments preference. Survives app relaunches
 * (SharedPreferences in production) but is wiped on uninstall.
 */
class ActivitySegmentsSettings(private val store: KeyValueStore) {

    object Keys {
        const val ENABLED = "omnesis.activitysegments.enabled"
        const val PERMISSION_PERMANENTLY_DENIED = "omnesis.activitysegments.permissionPermanentlyDenied"
        const val PUSH_PREFIX = "omnesis.activitysegments.push"
    }

    var activitySegmentsEnabled: Boolean
        get() = store.get(Keys.ENABLED) == "true"
        set(value) = store.put(Keys.ENABLED, value.toString())

    var permissionPermanentlyDenied: Boolean
        get() = store.get(Keys.PERMISSION_PERMANENTLY_DENIED) == "true"
        set(value) = store.put(Keys.PERMISSION_PERMANENTLY_DENIED, value.toString())

    fun recordPermissionResult(granted: Boolean, permanentlyDenied: Boolean) {
        permissionPermanentlyDenied = !granted && permanentlyDenied
    }

    fun observePermission(granted: Boolean) {
        if (granted) permissionPermanentlyDenied = false
    }

    /**
     * Refusals counted against the un-drained range of the transition buffer,
     * and the record of the ranges syncing gave up on. The unit is the `_id` of
     * the buffer's oldest row: it moves only when the buffer actually drains,
     * so it is exactly the identity of "the push that is stuck".
     */
    val pushRefusals = PushRefusalLedger(
        sourceId = ActivitySegmentsSyncCoordinator.SOURCE_ID,
        keyPrefix = Keys.PUSH_PREFIX,
        read = store::get,
        write = store::put,
    )

    /** Wipe every setting — called on unpair so a fresh pairing starts from defaults. */
    fun reset() {
        store.put(Keys.ENABLED, null)
        store.put(Keys.PERMISSION_PERMANENTLY_DENIED, null)
        pushRefusals.clear()
    }
}
