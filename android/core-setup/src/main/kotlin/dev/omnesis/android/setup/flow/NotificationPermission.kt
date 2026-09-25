// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

/** Android's notification permission as the flow and Settings read it. */
enum class NotificationPermissionState {
    /** Below Android 13 there is no runtime permission to ask for. */
    NOT_REQUIRED,
    UNDETERMINED,
    GRANTED,

    /** Asked before and not granted: only system Settings can change it now. */
    DENIED,
}

fun notificationPermissionState(apiLevel: Int, granted: Boolean, prompted: Boolean): NotificationPermissionState = when {
    apiLevel < 33 -> NotificationPermissionState.NOT_REQUIRED
    granted -> NotificationPermissionState.GRANTED
    prompted -> NotificationPermissionState.DENIED
    else -> NotificationPermissionState.UNDETERMINED
}

/**
 * Whether a page or button the user chose may ask Android now. Nothing else
 * asks: the app never raises the notification prompt on its own, and asks at
 * most while Android would still show it.
 */
fun notificationPromptAvailable(state: NotificationPermissionState): Boolean =
    state == NotificationPermissionState.UNDETERMINED

/** The Notifications row on Choose. [pushConfigured] is false in builds that cannot deliver notifications at all. */
fun notificationRow(id: String, state: NotificationPermissionState, pushConfigured: Boolean = true): SetupRow = SetupRow(
    id = id,
    group = SetupGroup.ALSO,
    availability = when {
        !pushConfigured -> SetupAvailability.Hidden
        state == NotificationPermissionState.NOT_REQUIRED -> SetupAvailability.Hidden
        state == NotificationPermissionState.DENIED -> SetupAvailability.Disabled("Off in Settings")
        else -> SetupAvailability.Available
    },
    on = state == NotificationPermissionState.GRANTED,
)
