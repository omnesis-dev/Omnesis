// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/** The gateway's local choice about new devices (`CloudRelayManagementStatus.deviceEnrollment`). */
@Serializable
data class DeviceEnrollmentSettings(
    /** `automatic` or `ask`. */
    val policy: String = "ask",
)

@Serializable
internal data class DeviceEnrollmentPolicyBody(val policy: String)
