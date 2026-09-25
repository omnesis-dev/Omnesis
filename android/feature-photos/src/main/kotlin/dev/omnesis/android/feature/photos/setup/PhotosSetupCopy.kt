// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.setup

import android.os.Build
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Image
import androidx.compose.ui.graphics.Color
import dev.omnesis.android.setup.SetupLedger
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.SetupUnit

/** Where Android keeps photo access for Omnesis, in the words the running API level shows. */
fun photosSettingsSteps(sdkInt: Int): String = when {
    sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> "In Settings, tap Permissions, then Photos and videos, and choose Allow all."
    sdkInt >= Build.VERSION_CODES.TIRAMISU -> "In Settings, tap Permissions, then Photos and videos, and choose Allow."
    else -> "In Settings, tap Permissions, then Storage (or Files and media), and choose Allow."
}

/**
 * What the Photos setup page and the Photos Settings disclosure say. The
 * ledger follows `PhotosDocumentBuilder` and the analyzers: extracted text and
 * barcode payloads in the content, scene labels as tags, the date the photo
 * was added, and a place name with its coordinates only when media location
 * access is allowed.
 */
val PhotosSetupCopy = SetupStepCopy(
    name = "Photos",
    glyph = Icons.Outlined.Image,
    tint = Color(0xFF0A84FF),
    row = "What's in them, never the images",
    value = "Find anything you photographed by what's in it. Omnesis looks at your photos on this phone and sends only what it finds.",
    ask = "Find the whiteboard photo from the kickoff.",
    disclosure = "Omnesis reads the photos you allow, extracts text and details from them, and sends those to your gateway, " +
        "including while the app is closed. The images stay on this phone.",
    ledger = SetupLedger(
        sent = listOf(
            "Text found in the image",
            "Scene labels",
            "QR and barcode contents",
            "Date added",
            "Place and coordinates, if you allow location",
        ),
        staysLabel = "Stays on this phone",
        stays = listOf("The photos themselves"),
    ),
    permissionLabel = "photo access",
    onTitle = "Photos are on",
    onBody = "Your photos are read in the background, even while Omnesis is closed.",
    offTitle = "Photos are off",
    settingsSteps = photosSettingsSteps(Build.VERSION.SDK_INT),
    limitedBody = "Omnesis can read the photos you chose.",
    limitedActionLabel = "Add more photos",
    unit = SetupUnit("photo", "photos"),
)
