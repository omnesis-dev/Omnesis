// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.health.connect.client.HealthConnectClient
import dev.omnesis.android.setup.ui.startActivitySafely

/**
 * Play Store deep link to the Health Connect provider app. The
 * `url=healthconnect://onboarding` extra routes the user straight into the
 * provider's own onboarding after install (Google's documented pattern).
 */
private const val HEALTH_CONNECT_PLAY_URI =
    "market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding"

private const val HEALTH_CONNECT_PLAY_WEB_URI =
    "https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata"

/** Manage-permissions deep link for a specific app on the framework provider (API 34+). */
private const val ACTION_MANAGE_HEALTH_PERMISSIONS =
    "android.health.connect.action.MANAGE_HEALTH_PERMISSIONS"

/**
 * Opens the Health Connect Play Store page, falling back to its web page when
 * Play is absent. False when neither could be opened.
 */
fun openHealthConnectPlayStore(context: Context): Boolean =
    listOf(
        Intent(Intent.ACTION_VIEW, Uri.parse(HEALTH_CONNECT_PLAY_URI)).setPackage("com.android.vending"),
        Intent(Intent.ACTION_VIEW, Uri.parse(HEALTH_CONNECT_PLAY_WEB_URI)),
    ).any { startActivitySafely(context, it) }

/**
 * Opens Health Connect's manage-permissions screen for this app so the user can
 * (re-)grant read access. This is the reliable re-prompt path: once the user has
 * dismissed Health Connect's consent sheet, the permission contract resolves
 * without showing anything on a re-launch.
 *
 * Tries the per-app manage-permissions deep link first (framework provider,
 * API 34+), then the general Health Connect settings action (APK provider /
 * older devices) — some system providers reserve the per-app screen for
 * privileged callers even though it resolves — and finally the Play Store
 * listing. False when nothing could be opened.
 */
fun openHealthConnectPermissions(context: Context): Boolean =
    listOf(
        Intent(ACTION_MANAGE_HEALTH_PERMISSIONS).putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName),
        Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS),
    ).any { startActivitySafely(context, it) } || openHealthConnectPlayStore(context)
