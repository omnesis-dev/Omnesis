// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.setup

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.ui.graphics.Color
import dev.omnesis.android.setup.SetupLedger
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.SetupUnit

/**
 * What the Health Connect setup page and its Settings disclosure say. The
 * ledger follows the `hc_*` analytics schemas: one row per record with its
 * metric, value, unit and time; sleep sessions with their stages; exercise
 * sessions with the title and notes the recording app gave them; and every
 * row's data origin and device type.
 */
val HealthSetupCopy = SetupStepCopy(
    name = "Health Connect",
    glyph = Icons.Outlined.MonitorHeart,
    tint = Color(0xFFFF2D55),
    row = "Sleep, heart, workouts",
    value = "Your health history, searchable and chartable next to the rest of your life.",
    ask = "Is my resting heart rate trending down?",
    disclosure = "Omnesis reads the health types you allow and sends them to your gateway, including while the app is closed.",
    ledger = SetupLedger(
        sent = listOf(
            "Health records: type, value, unit, time",
            "Sleep sessions and stages",
            "Exercise sessions, with titles and notes",
            "Source app and device type",
        ),
        alsoAsked = listOf("Reading while the app is closed", "History older than 30 days"),
        staysLabel = "Never",
        stays = listOf("Writing to Health Connect"),
    ),
    permissionLabel = "Health Connect access",
    onBody = "Your history is being read in the background. You don't need to wait here.",
    partialBody = "Health Connect allowed part of what Omnesis asked for. You can review access in Health Connect any time.",
    partialActionLabel = "Open Health Connect",
    settingsSteps = "In Health Connect, tap App permissions, then Omnesis, and allow the types you want.",
    unit = SetupUnit("record", "records"),
)
