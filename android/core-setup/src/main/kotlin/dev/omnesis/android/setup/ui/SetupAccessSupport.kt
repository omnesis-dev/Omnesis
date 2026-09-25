// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat

/**
 * How a page opens what a step's enable asks for. Created by the page, so
 * it can be recreated at any time; answers go straight back to the step's
 * sequence, never to a callback the page holds.
 */
interface SetupLauncher {
    /** Opens Android's prompt or system screen for the access the step needs. */
    fun launch()

    /** Opens the system screen where the grant can change; false when the phone has none. */
    fun openSettings(): Boolean
}

/**
 * Android's runtime permission dialog. [permissions] is read when launching,
 * so it can follow the API level; an empty set means nothing needs asking
 * and access is granted at once. [onAnswer] hears whether access was granted
 * and whether Android will no longer show the dialog ("don't ask again").
 */
@Composable
fun rememberPermissionLauncher(
    permissions: () -> Array<String>,
    rationalePermission: String?,
    accessGranted: (Map<String, Boolean>) -> Boolean,
    onAnswer: (granted: Boolean, permanentlyDenied: Boolean) -> Unit,
    settingsIntent: (Context) -> Intent = ::appDetailsSettingsIntent,
): SetupLauncher {
    val context = LocalContext.current
    val currentPermissions by rememberUpdatedState(permissions)
    val currentAccessGranted by rememberUpdatedState(accessGranted)
    val currentOnAnswer by rememberUpdatedState(onAnswer)
    val currentSettingsIntent by rememberUpdatedState(settingsIntent)
    val dialog = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val granted = currentAccessGranted(grants)
        val activity = context.findActivity()
        val permanentlyDenied = !granted && rationalePermission != null && activity != null &&
            !ActivityCompat.shouldShowRequestPermissionRationale(activity, rationalePermission)
        currentOnAnswer(granted, permanentlyDenied)
    }
    return remember(dialog, context) {
        object : SetupLauncher {
            override fun launch() {
                val asked = currentPermissions()
                if (asked.isEmpty()) currentOnAnswer(true, false) else dialog.launch(asked)
            }

            override fun openSettings(): Boolean = startActivitySafely(context, currentSettingsIntent(context))
        }
    }
}

/**
 * A system screen that grants access without a result, read back when the
 * app resumes. [onReturned] is given only when the screen must be started
 * for a result; it then runs when the screen closes. [onFailed] runs when
 * the phone has no such screen.
 */
@Composable
fun rememberSystemScreenLauncher(
    screenIntent: (Context) -> Intent,
    onFailed: () -> Unit,
    onReturned: (() -> Unit)? = null,
    settingsIntent: (Context) -> Intent = screenIntent,
): SetupLauncher {
    val context = LocalContext.current
    val currentScreenIntent by rememberUpdatedState(screenIntent)
    val currentSettingsIntent by rememberUpdatedState(settingsIntent)
    val currentOnFailed by rememberUpdatedState(onFailed)
    val currentOnReturned by rememberUpdatedState(onReturned)
    val forResult = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        currentOnReturned?.invoke()
    }
    return remember(forResult, context) {
        object : SetupLauncher {
            override fun launch() {
                val intent = runCatching { currentScreenIntent(context) }.getOrNull()
                val opened = when {
                    intent == null -> false
                    currentOnReturned != null -> runCatching { forResult.launch(intent) }.isSuccess
                    else -> startActivitySafely(context, intent)
                }
                if (!opened) currentOnFailed()
            }

            override fun openSettings(): Boolean =
                runCatching { currentSettingsIntent(context) }.getOrNull()?.let { startActivitySafely(context, it) } ?: false
        }
    }
}

/** Starts [intent], answering false when the phone has nothing to open it or refuses this app. */
fun startActivitySafely(context: Context, intent: Intent): Boolean = try {
    context.startActivity(intent)
    true
} catch (_: ActivityNotFoundException) {
    false
} catch (_: SecurityException) {
    false
}

/** This app's own page in system Settings, where every runtime permission can change. */
fun appDetailsSettingsIntent(context: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.fromParts("package", context.packageName, null))

fun openAppDetailsSettings(context: Context): Boolean = startActivitySafely(context, appDetailsSettingsIntent(context))

tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * Opens the phone setup flow on one step, by id. The app provides it where a
 * source's Settings card is shown, so the card's "Set up" goes through the
 * same page — disclosure, agreement and outcome — as the flow.
 */
val LocalOpenPhoneSetupStep = staticCompositionLocalOf<(String) -> Unit> { {} }
