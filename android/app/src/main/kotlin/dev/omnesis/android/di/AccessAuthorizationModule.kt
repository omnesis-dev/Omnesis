// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.ui.access.AccessAuthorizationGateway
import dev.omnesis.android.ui.access.SessionAccessAuthorizationGateway

@Module
@InstallIn(SingletonComponent::class)
abstract class AccessAuthorizationModule {
    @Binds
    abstract fun bindAccessAuthorizationGateway(
        implementation: SessionAccessAuthorizationGateway,
    ): AccessAuthorizationGateway
}
