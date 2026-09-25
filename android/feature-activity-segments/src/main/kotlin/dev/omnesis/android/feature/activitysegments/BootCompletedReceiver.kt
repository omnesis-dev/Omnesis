// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private const val TAG = "Omnesis:activitysegments"

/**
 * Best-effort re-subscription after a reboot — GMS's activity-recognition
 * subscription does not reliably survive every device restart. This is a
 * convenience, not the primary robustness mechanism: the hourly
 * `ActivitySegmentsSyncWorker` unconditionally re-subscribes on every run
 * regardless of whether a boot broadcast was ever missed (a more OEM- and
 * timing-robust guarantee than relying on this receiver alone).
 */
class BootCompletedReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun bootReceiverSettings(): ActivitySegmentsSettings

        fun bootReceiverIntegration(): ActivitySegmentsIntegration
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
                val shouldResubscribe = deps.bootReceiverSettings().activitySegmentsEnabled &&
                    deps.bootReceiverIntegration().hasPermission() &&
                    ActivitySegmentsAvailability.detect(context) == ActivitySegmentsAvailability.Available
                if (!shouldResubscribe) return@launch
                ActivityTransitionSubscriber(context.applicationContext).subscribe()
                Log.i(TAG, "Re-subscribed to activity transitions after boot")
            } catch (e: Exception) {
                Log.w(TAG, "Boot re-subscribe failed (the hourly worker will retry): $e")
            } finally {
                pending.finish()
            }
        }
    }
}
