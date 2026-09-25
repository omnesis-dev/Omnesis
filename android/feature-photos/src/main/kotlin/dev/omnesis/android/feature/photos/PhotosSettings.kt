// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import dev.omnesis.android.transport.PushRefusalLedger
import java.time.Instant

/**
 * Abstract string key/value store backing [PhotosSettings]. SharedPreferences
 * conforms in production (see `di/PhotosModule`); tests inject an
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
 * Per-user Photos preferences. Survives app relaunches (SharedPreferences in
 * production) but is wiped on uninstall.
 *
 * Two pieces of state:
 *  1. [photosEnabled] — the user has opted in to Photos syncing. Drives
 *     whether the gateway registers a `photos:local` source row and whether
 *     the sync worker + media-observer job run at all.
 *  2. [lastReconcileAt] — when the whole-library reconcile snapshot last
 *     ran. Throttled to at most once/day (see `PhotosSyncCoordinator`) since
 *     a photo library is orders of magnitude larger than, say, a call log —
 *     sending every current asset id on every sync pass would be real cost.
 */
class PhotosSettings(private val store: KeyValueStore) {

    object Keys {
        const val ENABLED = "omnesis.photos.enabled"
        const val PERMISSION_PERMANENTLY_DENIED = "omnesis.photos.permissionPermanentlyDenied"
        const val LAST_RECONCILE_AT = "omnesis.photos.lastReconcileAt"
        const val PUSH_PREFIX = "omnesis.photos.push"
        const val ACCESS = "omnesis.photos.access"
        const val ACCESS_GENERATION = "omnesis.photos.accessGeneration"
    }

    /**
     * Refusals counted against the backfill page the sync is stuck on, and the
     * record of the pages it gave up on. The unit is the cursor position the
     * page started from, which moves only when a page gets through.
     */
    val pushRefusals = PushRefusalLedger(
        sourceId = PhotosSyncCoordinator.SOURCE_ID,
        keyPrefix = Keys.PUSH_PREFIX,
        read = store::get,
        write = store::put,
    )

    var photosEnabled: Boolean
        get() = store.get(Keys.ENABLED) == "true"
        set(value) = store.put(Keys.ENABLED, value.toString())

    var permissionPermanentlyDenied: Boolean
        get() = store.get(Keys.PERMISSION_PERMANENTLY_DENIED) == "true"
        set(value) = store.put(Keys.PERMISSION_PERMANENTLY_DENIED, value.toString())

    fun recordPermissionResult(primaryGranted: Boolean, permanentlyDenied: Boolean) {
        permissionPermanentlyDenied = !primaryGranted && permanentlyDenied
    }

    fun observePermission(primaryGranted: Boolean) {
        if (primaryGranted) permissionPermanentlyDenied = false
    }

    var lastReconcileAt: Instant?
        get() = store.get(Keys.LAST_RECONCILE_AT)?.let { runCatching { Instant.parse(it) }.getOrNull() }
        set(value) = store.put(Keys.LAST_RECONCILE_AT, value?.toString())

    val accessGeneration: Long
        get() = store.get(Keys.ACCESS_GENERATION)?.toLongOrNull() ?: 0L

    /** Monotonic epoch: a LIMITED/DENIED -> FULL expansion requires a complete re-baseline. */
    @Synchronized
    fun observeAccess(access: PhotosAccess): Long {
        val previous = store.get(Keys.ACCESS)?.let { runCatching { PhotosAccess.valueOf(it) }.getOrNull() }
        var generation = accessGeneration
        if (previous != PhotosAccess.FULL && access == PhotosAccess.FULL) {
            generation += 1
            store.put(Keys.ACCESS_GENERATION, generation.toString())
            lastReconcileAt = null
        }
        store.put(Keys.ACCESS, access.name)
        return generation
    }

    /** Wipe every setting — called on unpair so a fresh pairing starts from defaults. */
    fun reset() {
        store.put(Keys.ENABLED, null)
        store.put(Keys.PERMISSION_PERMANENTLY_DENIED, null)
        store.put(Keys.LAST_RECONCILE_AT, null)
        store.put(Keys.ACCESS, null)
        store.put(Keys.ACCESS_GENERATION, null)
        pushRefusals.clear()
    }
}
