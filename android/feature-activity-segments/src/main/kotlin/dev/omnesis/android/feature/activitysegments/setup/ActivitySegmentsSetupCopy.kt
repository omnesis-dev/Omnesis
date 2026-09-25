// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.setup

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DirectionsWalk
import androidx.compose.ui.graphics.Color
import dev.omnesis.android.setup.SetupLedger
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.SetupUnit

/**
 * What the Activity Segments setup page and its Settings disclosure say. The
 * ledger follows `ActivitySegmentsNormalizer` and `ActivitySegmentsSchemas`:
 * one row per segment with its type, start, end and confidence, and one
 * movement document per day.
 */
val ActivitySegmentsSetupCopy = SetupStepCopy(
    name = "Activity Segments",
    glyph = Icons.AutoMirrored.Outlined.DirectionsWalk,
    tint = Color(0xFF30D158),
    row = "Walking, cycling, still",
    value = "How you moved through each day: walking, running, cycling, in a vehicle or still.",
    ask = "Did I cycle more this month than last?",
    disclosure = "Omnesis detects changes in your activity and sends them to your gateway, including while the app is closed.",
    ledger = SetupLedger(
        sent = listOf(
            "Activity segments: type, start, end, confidence",
            "A daily movement summary",
        ),
        staysLabel = "Stays on this phone",
        stays = listOf("Raw motion sensor readings"),
    ),
    permissionLabel = "physical activity access",
    settingsSteps = "In Settings, tap Permissions, then Physical activity, and choose Allow.",
    onBody = "New activity is recorded as it happens.",
    unit = SetupUnit("segment", "segments"),
)
