// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import dev.omnesis.android.transport.PushRefusalLedger

/**
 * Abstract string key/value store backing [CallLogSettings]. SharedPreferences
 * conforms in production (see `di/CallLogModule`); tests inject an
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
 * Per-user Call Log preferences. Survives app relaunches (SharedPreferences in
 * production) but is wiped on uninstall.
 *
 * Two pieces of state:
 *  1. [callLogEnabled] — the user has opted in to Call Log syncing. Drives
 *     whether the gateway registers an `android-call-log:local` source row and
 *     whether the sync worker runs at all.
 *  2. [permissionPermanentlyDenied] — the latest denied callback indicated
 *     Android will no longer show READ_CALL_LOG, so relaunches point at app
 *     settings. A successful grant clears it for truthful auto-reset recovery.
 */
class CallLogSettings(private val store: KeyValueStore) {

    object Keys {
        const val ENABLED = "omnesis.calllog.enabled"
        const val PERMISSION_PERMANENTLY_DENIED = "omnesis.calllog.permissionPermanentlyDenied"
        const val PUSH_PREFIX = "omnesis.calllog.push"
    }

    /**
     * Refusals counted against the window of new calls the sync is stuck on,
     * and the record of the windows it gave up on. The unit is the watermark
     * the window starts at, which moves only when a push gets through.
     */
    val pushRefusals = PushRefusalLedger(
        sourceId = CallLogSyncCoordinator.SOURCE_ID,
        keyPrefix = Keys.PUSH_PREFIX,
        read = store::get,
        write = store::put,
    )

    var callLogEnabled: Boolean
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

    /** Wipe every setting — called on unpair so a fresh pairing starts from defaults. */
    fun reset() {
        store.put(Keys.ENABLED, null)
        store.put(Keys.PERMISSION_PERMANENTLY_DENIED, null)
        pushRefusals.clear()
    }
}
