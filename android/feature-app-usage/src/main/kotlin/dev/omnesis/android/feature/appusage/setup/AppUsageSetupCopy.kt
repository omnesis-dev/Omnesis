// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.setup

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.ui.graphics.Color
import dev.omnesis.android.setup.SetupLedger
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.SetupUnit

/** Where Usage access is granted, shown before Android opens it and on the "off" outcome. */
const val APP_USAGE_SETTINGS_STEPS = "In Usage access, find Omnesis and turn on Permit usage access."

/**
 * What the App Usage setup page and the App Usage Settings disclosure say.
 * The ledger follows what the source sends: per-app foreground sessions and
 * daily per-app totals as analytics rows, and one Attention Timeline document
 * per day.
 */
val AppUsageSetupCopy = SetupStepCopy(
    name = "App Usage",
    glyph = Icons.Outlined.BarChart,
    tint = Color(0xFFBF5AF2),
    row = "Where your screen time goes",
    value = "Where your screen time goes, app by app.",
    ask = "How long was I on my phone after 11pm last week?",
    disclosure = "Omnesis reads which apps you used and for how long, and sends that to your gateway, " +
        "including while the app is closed.",
    ledger = SetupLedger(
        sent = listOf(
            "App sessions: app, start, end",
            "Daily totals per app",
            "A daily attention timeline",
        ),
        staysLabel = "Stays on this phone",
        stays = listOf("What you do inside each app"),
    ),
    primaryLabel = "Agree & open settings",
    fine = APP_USAGE_SETTINGS_STEPS,
    permissionLabel = "usage access",
    settingsSteps = APP_USAGE_SETTINGS_STEPS,
    onBody = "Today's usage is being read now.",
    unit = SetupUnit("session", "sessions"),
)
