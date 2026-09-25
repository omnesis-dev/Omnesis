// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private const val TAG = "Omnesis:activitysegments"

/**
 * Thin `BroadcastReceiver`: GMS delivers one `ActivityTransitionResult` per
 * batch of transitions via the `PendingIntent` handed to
 * [ActivityTransitionSubscriber.subscribe]. `hasResult`/`extractResult` are
 * Google's own public, documented idiom for pulling the result back out of
 * the intent — the only contract this receiver relies on.
 *
 * [handleResult] is kept public and directly callable so it can be exercised
 * from an instrumentation test with a hand-built [ActivityTransitionResult]
 * and zero real GMS callback (see `ActivityTransitionReceiverRoundTripTest`).
 */
class ActivityTransitionReceiver : BroadcastReceiver() {

    // A plain (non-Hilt) receiver: dependencies resolve through this Hilt
    // EntryPoint against the application component, the same pattern
    // CallLogSyncWorker/AppUsageSyncWorker use for OS-instantiated components
    // that Hilt doesn't construct directly. Method name must stay unique
    // across every feature module's own @EntryPoint interface.
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun activityTransitionBuffer(): ActivityTransitionBuffer
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return
        val result = ActivityTransitionResult.extractResult(intent) ?: return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                handleResult(context, result)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to buffer activity transition result: $e")
            } finally {
                pending.finish()
            }
        }
    }

    suspend fun handleResult(context: Context, result: ActivityTransitionResult) {
        val buffer = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
            .activityTransitionBuffer()
        val nowWallClockMillis = System.currentTimeMillis()
        val nowElapsedRealtimeMillis = SystemClock.elapsedRealtime()
        val events = result.transitionEvents.map { event ->
            BufferedTransitionEvent(
                id = 0, // assigned by SQLite AUTOINCREMENT on insert
                activityType = activityTypeName(event.activityType),
                transitionType = transitionTypeName(event.transitionType),
                elapsedRealtimeNanos = event.elapsedRealTimeNanos,
                // Computed once, here, at receive time: elapsedRealtime() is
                // monotonic and immune to a wall-clock/NTP step between the
                // live GMS callback and this live onReceive() for the same
                // event, so this arithmetic is safe even though the two
                // clocks are read at slightly different instants.
                eventWallClockMillis = nowWallClockMillis -
                    (nowElapsedRealtimeMillis - event.elapsedRealTimeNanos / 1_000_000),
            )
        }
        buffer.insertAll(events)
        Log.i(TAG, "Buffered ${events.size} activity transition event(s)")
    }

    companion object {
        fun activityTypeName(detectedActivityType: Int): String = when (detectedActivityType) {
            com.google.android.gms.location.DetectedActivity.STILL -> "still"
            com.google.android.gms.location.DetectedActivity.WALKING -> "walking"
            com.google.android.gms.location.DetectedActivity.RUNNING -> "running"
            com.google.android.gms.location.DetectedActivity.ON_BICYCLE -> "on_bicycle"
            com.google.android.gms.location.DetectedActivity.IN_VEHICLE -> "in_vehicle"
            else -> "unknown"
        }

        fun transitionTypeName(transitionType: Int): String = when (transitionType) {
            ActivityTransition.ACTIVITY_TRANSITION_ENTER -> "ENTER"
            ActivityTransition.ACTIVITY_TRANSITION_EXIT -> "EXIT"
            else -> "UNKNOWN"
        }
    }
}
