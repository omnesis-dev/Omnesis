// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/** The Tailscale Android app. The manifest lists it under `<queries>` so its launch intent is visible. */
internal const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
internal const val TAILSCALE_MARKET_URL = "market://details?id=$TAILSCALE_PACKAGE"
internal const val TAILSCALE_PLAY_URL = "https://play.google.com/store/apps/details?id=$TAILSCALE_PACKAGE"

/**
 * What "Open Tailscale" tries, in order: the app itself when it is installed, else its listing
 * in the Play Store app, else the same listing in a browser.
 */
internal fun tailscaleIntents(packageManager: PackageManager): List<Intent> = listOfNotNull(
    packageManager.getLaunchIntentForPackage(TAILSCALE_PACKAGE),
    Intent(Intent.ACTION_VIEW, Uri.parse(TAILSCALE_MARKET_URL)),
    Intent(Intent.ACTION_VIEW, Uri.parse(TAILSCALE_PLAY_URL)),
)

/** Opens Tailscale, or where to install it. Does nothing when no app can open any of them. */
internal fun openTailscale(context: Context) {
    for (intent in tailscaleIntents(context.packageManager)) {
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            return
        } catch (_: ActivityNotFoundException) {
            // The next way in.
        }
    }
}
