// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build

private fun linkIntent(url: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)

/**
 * Whether an installed app opens [url] from a link. A web link always counts: every phone has
 * a browser, and asking the package manager is unreliable for it — when an app installed after
 * this one is the verified handler, Android can leave it outside this app's package visibility
 * and report no match at all. A custom scheme is checked, visible through the manifest's
 * wildcard `VIEW` query.
 */
fun Context.canOpenLink(url: String): Boolean {
    val scheme = Uri.parse(url).scheme?.lowercase()
    if (scheme == "http" || scheme == "https") return true
    val intent = linkIntent(url)
    val match = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.resolveActivity(
            intent,
            PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()),
        )
    } else {
        @Suppress("DEPRECATION")
        packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
    }
    return match != null
}

/**
 * Open the first of [urls] an app accepts. An app removed since [canOpenLink] ran fails with
 * [ActivityNotFoundException], and a handler that demands a permission with
 * [SecurityException]; either way the next link is tried instead of the tap doing nothing.
 */
fun Context.openFirstLink(urls: List<String>): Boolean {
    for (url in urls) {
        try {
            startActivity(linkIntent(url))
            return true
        } catch (_: ActivityNotFoundException) {
            continue
        } catch (_: SecurityException) {
            continue
        }
    }
    return false
}
