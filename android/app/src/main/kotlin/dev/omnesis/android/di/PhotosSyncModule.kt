// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.photos.PhotosSessionProvider
import dev.omnesis.android.feature.photos.PhotosSyncCoordinator
import dev.omnesis.android.session.SessionManager

@Module
@InstallIn(SingletonComponent::class)
object PhotosSyncModule {

    /**
     * The seam through which the photos feature (settings UI,
     * `PhotosSyncWorker`, `PhotosMediaObserverJobService`) reaches the live
     * session. Routing through [SessionManager] means a WorkManager/
     * JobScheduler cold start instantiates the session from the persisted
     * pairing, and an unpaired app yields nulls (callers skip).
     */
    @Provides
    fun providePhotosSessionProvider(sessionManager: SessionManager): PhotosSessionProvider =
        object : PhotosSessionProvider {
            override fun coordinator(): PhotosSyncCoordinator? = sessionManager.session?.photos

            override fun deviceId(): String? = sessionManager.session?.pairing?.deviceId
        }
}
