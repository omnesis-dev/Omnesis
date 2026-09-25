// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.distribution

import dev.omnesis.android.transport.DeliveryReporter
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.JsonObject

/**
 * Device-hosted sources that exist only in a particular distribution artifact.
 * The shared app composes this generic seam without linking restricted source
 * code into artifacts that must not contain it.
 */
interface DistributionSourceSession {
    val deliveryReporters: List<DeliveryReporter>

    fun handleCommand(type: String, payload: JsonObject, scope: CoroutineScope): Boolean

    fun launchInitialSync(scope: CoroutineScope)
}
