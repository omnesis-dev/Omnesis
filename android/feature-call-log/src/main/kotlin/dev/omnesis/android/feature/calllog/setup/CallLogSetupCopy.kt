// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.setup

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.ui.graphics.Color
import dev.omnesis.android.setup.SetupLedger
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.SetupUnit

/**
 * What the Call Log setup page and the Call Log Settings disclosure say. The
 * ledger follows `CallLogNormalizer`: one row per call with its counterparty
 * number and cached name, whether it was answered or missed, its start time
 * and duration, and a per-day calls document.
 */
val CallLogSetupCopy = SetupStepCopy(
    name = "Call Log",
    glyph = Icons.Outlined.Phone,
    tint = Color(0xFF64D2FF),
    row = "Who you spoke to and when",
    value = "Who you spoke to, and when.",
    ask = "When did I last call the plumber?",
    disclosure = "Omnesis reads your call history and sends it to your gateway, including while the app is closed.",
    ledger = SetupLedger(
        sent = listOf(
            "Calls: number, name, answered or missed, time, duration",
            "A daily call summary",
        ),
        staysLabel = "Never",
        stays = listOf("Call audio"),
    ),
    permissionLabel = "call log access",
    settingsSteps = "In Settings, tap Permissions, then Call logs, and choose Allow.",
    onBody = "Your call history is being read now.",
    unit = SetupUnit("call", "calls"),
)
