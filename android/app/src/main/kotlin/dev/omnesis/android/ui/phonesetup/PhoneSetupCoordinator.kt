// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.flow.FirstRunDecision
import dev.omnesis.android.setup.flow.PhoneSetupGate
import dev.omnesis.android.setup.flow.PhoneSetupPolicy
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import javax.inject.Inject
import javax.inject.Singleton

/** "{on} of {total} sources on", for the Settings row that reopens the flow. */
data class PhoneSetupSummary(val on: Int, val total: Int)

/**
 * What the app shell asks of the phone setup flow without opening it: what a
 * paired device should see, how many of this phone's sources are on, and the
 * gate the shell's own presenters wait behind.
 */
@Singleton
class PhoneSetupCoordinator @Inject constructor(
    val record: PhoneSetupRecord,
    val gate: PhoneSetupGate,
    private val steps: Set<@JvmSuppressWildcards PhoneSetupStep>,
) {
    /** Reads, without changing anything, what first run should do for [deviceId]. */
    fun firstRunDecision(deviceId: String?): FirstRunDecision = PhoneSetupPolicy.decide(
        record = record,
        deviceId = deviceId,
        anySourceOn = sources().any { it.isOnSafely() },
    )

    /** Records a device that already contributes as done, so it is never shown the flow. */
    fun completeSilentlyIfContributing(deviceId: String?) {
        if (deviceId != null && firstRunDecision(deviceId) == FirstRunDecision.COMPLETE_SILENTLY) {
            record.markCompleted(deviceId)
        }
    }

    /** Sources on, out of those this device and edition can host. */
    fun summary(): PhoneSetupSummary {
        val sources = sources()
        return PhoneSetupSummary(
            on = sources.count { it.isOnSafely() },
            total = sources.count { it.isOnSafely() || it.availabilitySafely() == SetupAvailability.Available },
        )
    }

    private fun sources() = steps.filter { it.group == SetupGroup.SOURCE }
}

/** A step's availability, read as hidden when the phone cannot answer. */
internal fun PhoneSetupStep.availabilitySafely(): SetupAvailability =
    runCatching { availability() }.getOrDefault(SetupAvailability.Hidden)

internal fun PhoneSetupStep.isOnSafely(): Boolean = runCatching { isOn() }.getOrDefault(false)
