// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSessionProvider
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncCoordinator
import dev.omnesis.android.session.SessionManager

@Module
@InstallIn(SingletonComponent::class)
object ActivitySegmentsSyncModule {

    /**
     * The seam through which the activity-segments feature (settings UI,
     * `ActivitySegmentsSyncWorker`, `BootCompletedReceiver`) reaches the live
     * session. Routing through [SessionManager] means a WorkManager cold
     * start instantiates the session from the persisted pairing, and an
     * unpaired app yields nulls (callers skip).
     */
    @Provides
    fun provideActivitySegmentsSessionProvider(sessionManager: SessionManager): ActivitySegmentsSessionProvider =
        object : ActivitySegmentsSessionProvider {
            override fun coordinator(): ActivitySegmentsSyncCoordinator? = sessionManager.session?.activitySegments

            override fun deviceId(): String? = sessionManager.session?.pairing?.deviceId
        }
}
