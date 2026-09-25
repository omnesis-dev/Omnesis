// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import kotlinx.coroutines.tasks.await

/**
 * Wraps `ActivityRecognitionClient`, the push-based half of this feature: one
 * [ActivityTransitionRequest] covering [MONITORED_ACTIVITY_TYPES] × ENTER+EXIT
 * (10 [ActivityTransition]s), delivered to [ActivityTransitionReceiver] via a
 * single stable [PendingIntent].
 *
 * Deliberately excludes `DetectedActivity.ON_FOOT` — Google's own guidance is
 * not to mix the coarse type with its finer `WALKING`/`RUNNING` subtypes,
 * both of which are already monitored.
 */
class ActivityTransitionSubscriber(private val context: Context) {

    companion object {
        val MONITORED_ACTIVITY_TYPES = listOf(
            DetectedActivity.STILL,
            DetectedActivity.WALKING,
            DetectedActivity.RUNNING,
            DetectedActivity.ON_BICYCLE,
            DetectedActivity.IN_VEHICLE,
        )

        private const val REQUEST_CODE = 4201
    }

    private fun pendingIntent(): PendingIntent {
        val intent = Intent(context, ActivityTransitionReceiver::class.java)
        // FLAG_MUTABLE is required on API 31+: GMS fills the transition-result
        // extra into this exact intent at delivery time, and an immutable
        // PendingIntent silently drops it. Conditional because this module's
        // minSdk is 26, where FLAG_MUTABLE does not exist.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags)
    }

    private fun buildRequest(): ActivityTransitionRequest {
        val transitions = MONITORED_ACTIVITY_TYPES.flatMap { type ->
            listOf(
                ActivityTransition.Builder()
                    .setActivityType(type)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                    .build(),
                ActivityTransition.Builder()
                    .setActivityType(type)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
                    .build(),
            )
        }
        return ActivityTransitionRequest(transitions)
    }

    /**
     * (Re-)subscribes. Safe to call repeatedly with the SAME request +
     * `PendingIntent`: GMS documents `requestActivityTransitionUpdates` as
     * idempotent in that case (a refresh, not a duplicate registration
     * error) — this is what makes the worker's unconditional resubscribe
     * (see `ActivitySegmentsSyncWorker`) safe to run every hourly pass.
     */
    suspend fun subscribe() {
        ActivityRecognition.getClient(context)
            .requestActivityTransitionUpdates(buildRequest(), pendingIntent())
            .await()
    }

    suspend fun unsubscribe() {
        ActivityRecognition.getClient(context)
            .removeActivityTransitionUpdates(pendingIntent())
            .await()
    }
}
