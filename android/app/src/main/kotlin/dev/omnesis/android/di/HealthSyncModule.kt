// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.health.HealthSessionProvider
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.session.SessionManager

@Module
@InstallIn(SingletonComponent::class)
object HealthSyncModule {

    /**
     * The seam through which the health feature (settings UI, `HealthSyncWorker`)
     * reaches the live session. Routing through [SessionManager] means a
     * WorkManager cold start instantiates the session from the persisted
     * pairing, and an unpaired app yields nulls (callers skip).
     */
    @Provides
    fun provideHealthSessionProvider(sessionManager: SessionManager): HealthSessionProvider =
        object : HealthSessionProvider {
            override fun coordinator(): HealthSyncCoordinator? = sessionManager.session?.health

            override fun deviceId(): String? = sessionManager.session?.pairing?.deviceId
        }
}
