// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import android.content.Context

/**
 * Dismissal policy for the app-wide notification warning.
 *
 * Some users genuinely do not want notifications, so the global banner gets a
 * dismiss cross. Dismissal lasts for one "epoch" of disabled delivery: once
 * dismissed the warning stays hidden until the app sees delivery healthy
 * again, which clears the flag so the next disabled epoch shows it once more.
 *
 * Only the disabled-delivery case ([NotificationSetupIssue.PERMISSION]) is
 * dismissible. Setup problems (missing Firebase config, relay consent, …)
 * keep showing until fixed.
 */
object NotificationWarningDismissal {
    const val PREFS = "omnesis_notification_warning"
    const val KEY_DISMISSED = "dismissed"

    /** Whether the global banner should show the disabled-delivery warning now. */
    fun shouldShowWarning(issue: NotificationSetupIssue?, dismissed: Boolean): Boolean =
        issue == NotificationSetupIssue.PERMISSION && !dismissed

    /** Whether observing this health clears a previous dismissal (new epoch). */
    fun shouldResetDismissal(health: String): Boolean = health == "healthy"

    fun isDismissed(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_DISMISSED, false)

    fun setDismissed(context: Context, dismissed: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_DISMISSED, dismissed).apply()
    }
}
