// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import dev.omnesis.android.transport.ws.DeviceSocket

/**
 * Every version number this app build can state about itself.
 *
 * Three numbers, three different questions, and someone looking at a phone
 * needs all of them:
 *
 * - [version] is the lockstep Omnesis product version. It says how old this
 *   build is relative to the gateway it pairs with — an app legitimately
 *   trails the tag it was cut from while a store release is in the queue.
 * - [build] is the store's monotonic upload counter. Two builds of the same
 *   product version are told apart by nothing else.
 * - [wireProtocol] is the device-socket number the gateway either speaks or
 *   refuses outright. When a phone cannot connect at all, this is the value
 *   that decided it.
 */
data class AppVersionInfo(
    val version: String,
    val build: String,
    val wireProtocol: Int,
) {
    companion object {
        /**
         * The running build's identity.
         *
         * `BuildConfig` is the application module's to read: the library
         * modules deliberately declare no version of their own, so this is
         * the one place the build's numbers enter the app.
         */
        fun current(): AppVersionInfo = AppVersionInfo(
            version = BuildConfig.VERSION_NAME,
            build = BuildConfig.VERSION_CODE.toString(),
            wireProtocol = DeviceSocket.PROTOCOL_VERSION,
        )
    }
}
