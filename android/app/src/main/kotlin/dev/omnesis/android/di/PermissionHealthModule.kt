// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.PermissionHealthReporter
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

@Module
@InstallIn(SingletonComponent::class)
object PermissionHealthModule {
    @Provides
    @Singleton
    fun providePermissionHealthCoordinator(
        reporters: Set<@JvmSuppressWildcards PermissionHealthReporter>,
        optIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
        sessions: SessionManager,
    ): PermissionHealthCoordinator = PermissionHealthCoordinator(
        reporters = { reporters },
        admin = { sessions.session?.admin },
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        deviceId = { sessions.session?.pairing?.deviceId },
        // A source this device does not host on its gateway has a stale opt-in: it goes off as on a new pairing.
        forgetSource = { sourceId -> optIns.firstOrNull { it.sourceId == sourceId }?.forget() },
    )
}
