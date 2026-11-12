// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.util.Log
import dev.omnesis.android.wear.core.WatchLog

/**
 * The app's one log tag. Lines are concise one-liners and never carry a
 * question, a note or an answer.
 */
object WearLog : WatchLog {
    private const val TAG = "Omnesis:wear"

    override fun info(message: String) {
        Log.i(TAG, message)
    }

    override fun error(message: String) {
        Log.e(TAG, message)
    }
}
