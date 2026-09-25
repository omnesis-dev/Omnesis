// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.delivery.PushHealthCoordinator
import dev.omnesis.android.session.SessionManager
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

@Module
@InstallIn(SingletonComponent::class)
object DeliveryHealthModule {

    /**
     * One holder for the whole app, so every surface rendering the delivery
     * banner agrees on what is undelivered and whether a retry is running.
     *
     * The reporter list is resolved per call rather than captured: an unpaired
     * app yields none (the banner reads healthy), and a re-pair is picked up
     * without the holder observing the session. The scope is the holder's own,
     * so a retry started from a screen survives that screen going away.
     */
    @Provides
    @Singleton
    fun providePushHealthCoordinator(sessionManager: SessionManager): PushHealthCoordinator =
        PushHealthCoordinator(
            reporters = { sessionManager.session?.deliveryReporters.orEmpty() },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        )
}
