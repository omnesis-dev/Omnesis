// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * [ActivitySegmentsSessionProvider] is normally bound by `:app`'s
 * `ActivitySegmentsSyncModule` (it needs the app's `SessionManager`, which
 * this library module never depends on). This module's own generated Hilt
 * test component still aggregates every `@EntryPoint`/`@Inject` site declared
 * anywhere in `:feature-activity-segments` — including
 * `ActivitySegmentsSyncWorker.Deps` and `ActivitySegmentsViewModel`, neither
 * of which [ActivityTransitionReceiverRoundTripTest] exercises — so a stub
 * binding is required to satisfy the graph. Always returns null, matching
 * the real provider's contract while unpaired.
 */
@Module
@InstallIn(SingletonComponent::class)
object TestActivitySegmentsSessionModule {

    @Provides
    fun provideActivitySegmentsSessionProvider(): ActivitySegmentsSessionProvider =
        object : ActivitySegmentsSessionProvider {
            override fun coordinator(): ActivitySegmentsSyncCoordinator? = null

            override fun deviceId(): String? = null
        }
}
