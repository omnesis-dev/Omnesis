// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.appusage.AppUsageSessionProvider
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.session.SessionManager

@Module
@InstallIn(SingletonComponent::class)
object AppUsageSyncModule {

    /**
     * The seam through which the app-usage feature (settings UI,
     * `AppUsageSyncWorker`) reaches the live session. Routing through
     * [SessionManager] means a WorkManager cold start instantiates the
     * session from the persisted pairing, and an unpaired app yields nulls
     * (callers skip).
     */
    @Provides
    fun provideAppUsageSessionProvider(sessionManager: SessionManager): AppUsageSessionProvider =
        object : AppUsageSessionProvider {
            override fun coordinator(): AppUsageSyncCoordinator? = sessionManager.session?.appUsage

            override fun deviceId(): String? = sessionManager.session?.pairing?.deviceId
        }
}
