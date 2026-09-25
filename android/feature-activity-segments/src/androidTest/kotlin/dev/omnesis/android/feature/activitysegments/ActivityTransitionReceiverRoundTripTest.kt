// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.Context
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionEvent
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import javax.inject.Inject
import kotlin.math.abs
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented round-trip: a hand-built [ActivityTransitionResult] (real
 * GMS Parcelable data holders, public constructors — not sealed, not
 * undocumented) fed straight into [ActivityTransitionReceiver.handleResult],
 * proving the receiver's production code path — including its Hilt
 * `@EntryPoint` resolution of [ActivityTransitionBuffer] — writes correctly
 * to a real on-device SQLite database, with ZERO real motion and ZERO real
 * GMS callback.
 *
 * This deliberately does NOT drive [ActivityTransitionReceiver.onReceive]
 * itself: `goAsync()` requires a `PendingResult` the framework only supplies
 * when a receiver is dispatched through a genuine broadcast, so calling
 * `onReceive` on a bare, manually-constructed receiver throws. `handleResult`
 * is the documented, directly-callable seam for exactly this reason (see its
 * doc comment). Likewise, `ActivityTransitionResult.hasResult`/`extractResult`
 * — the idiom `onReceive` itself uses to pull a result out of the delivered
 * `Intent` — has no public, documented way to construct a matching `Intent`
 * for a test to feed back in (the real extra key GMS uses is internal); that
 * specific hop is exercised only by a genuine device broadcast and stays on
 * the "unverifiable without a physical device" list.
 *
 * Run: `./gradlew :feature-activity-segments:connectedDebugAndroidTest`
 * (boot the AVD first).
 */
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class ActivityTransitionReceiverRoundTripTest {

    @get:Rule
    val hiltRule = HiltAndroidRule(this)

    @Inject
    lateinit var buffer: ActivityTransitionBuffer

    @Before
    fun setUp() {
        hiltRule.inject()
        // Clean slate: this is the real production on-device database file,
        // which can carry rows left over from a previous run.
        runBlocking {
            buffer.readAll(limit = 100_000).maxOfOrNull { it.id }?.let { buffer.deleteUpTo(it) }
        }
    }

    @Test
    fun handleResult_writes_a_hand_built_transition_result_through_the_real_hilt_entry_point() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val receiver = ActivityTransitionReceiver()

        val nowElapsedMillis = SystemClock.elapsedRealtime()
        val enterElapsedMillis = nowElapsedMillis - 60_000
        val result = ActivityTransitionResult(
            listOf(
                ActivityTransitionEvent(
                    DetectedActivity.WALKING,
                    ActivityTransition.ACTIVITY_TRANSITION_ENTER,
                    enterElapsedMillis * 1_000_000L,
                ),
                ActivityTransitionEvent(
                    DetectedActivity.WALKING,
                    ActivityTransition.ACTIVITY_TRANSITION_EXIT,
                    nowElapsedMillis * 1_000_000L,
                ),
            ),
        )

        receiver.handleResult(context, result)

        val rows = buffer.readAll()
        assertEquals(2, rows.size)
        assertEquals("walking", rows[0].activityType)
        assertEquals("ENTER", rows[0].transitionType)
        assertEquals("walking", rows[1].activityType)
        assertEquals("EXIT", rows[1].transitionType)

        // The EXIT event's elapsed-realtime instant is "now", so its derived
        // wall-clock time should land within a few seconds of the real now.
        val nowWallClockMillis = System.currentTimeMillis()
        assertTrue(
            "expected eventWallClockMillis close to now, was ${rows[1].eventWallClockMillis} vs $nowWallClockMillis",
            abs(nowWallClockMillis - rows[1].eventWallClockMillis) < 5_000,
        )

        // Merging what was just buffered produces one real closed segment.
        val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(rows, java.time.Instant.ofEpochMilli(nowWallClockMillis))
        assertEquals(1, outcome.closedSegments.size)
        assertEquals("walking", outcome.closedSegments.single().activityType)
    }
}
