// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dagger.multibindings.IntoSet
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.flow.PhoneSetupGate
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.setup.flow.SetupKeyValueStore
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.ui.phonesetup.BackgroundSyncingSetupStep
import dev.omnesis.android.ui.phonesetup.NotificationsSetupStep
import javax.inject.Singleton

/**
 * The phone setup flow's device-local memory, its presentation gate, the
 * session scope its steps start first syncs in, and the two steps the app
 * itself contributes beside the sources' own.
 */
@Module
@InstallIn(SingletonComponent::class)
object PhoneSetupModule {
    @Provides
    @Singleton
    fun providePhoneSetupRecord(@ApplicationContext context: Context): PhoneSetupRecord {
        val prefs = context.getSharedPreferences("omnesis.phone-setup", Context.MODE_PRIVATE)
        return PhoneSetupRecord(
            object : SetupKeyValueStore {
                override fun get(key: String): String? = prefs.getString(key, null)

                override fun put(key: String, value: String?) {
                    // Written synchronously: a completion the process dies right after must still be there on the next launch.
                    prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.commit()
                }
            },
        )
    }

    @Provides
    @Singleton
    fun providePhoneSetupGate(): PhoneSetupGate = PhoneSetupGate()

    @Provides
    fun provideSessionScopes(session: SessionManager): SessionScopeProvider = session

    @Provides
    @IntoSet
    fun provideNotificationsStep(step: NotificationsSetupStep): PhoneSetupStep = step

    @Provides
    @IntoSet
    fun provideBackgroundSyncingStep(step: BackgroundSyncingSetupStep): PhoneSetupStep = step
}
