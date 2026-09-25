// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.di

import android.content.Context
import android.content.SharedPreferences
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dagger.multibindings.IntoSet
import dev.omnesis.android.feature.calllog.CallLogIntegration
import dev.omnesis.android.feature.calllog.setup.CallLogSetupStep
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.feature.calllog.CallLogSettings
import dev.omnesis.android.feature.calllog.KeyValueStore
import javax.inject.Singleton

/** [KeyValueStore] over SharedPreferences — the production backing for [CallLogSettings]. */
class SharedPreferencesKeyValueStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String?) {
        prefs.edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }
}

@Module
@InstallIn(SingletonComponent::class)
object CallLogModule {
    @Provides @IntoSet
    fun providePermissionReporter(integration: CallLogIntegration): PermissionHealthReporter = integration

    /**
     * The opt-in a refusal is applied to, so the switch goes off and the
     * background work stops with or without a settings screen open.
     */
    @Provides @IntoSet
    fun provideHostedSourceOptIn(integration: CallLogIntegration): HostedSourceOptIn = integration

    /** The Call Log page of the phone setup flow. */
    @Provides @IntoSet
    fun providePhoneSetupStep(step: CallLogSetupStep): PhoneSetupStep = step

    @Provides
    @Singleton
    fun provideCallLogSettings(@ApplicationContext context: Context): CallLogSettings =
        CallLogSettings(
            SharedPreferencesKeyValueStore(
                context.getSharedPreferences("omnesis.calllog", Context.MODE_PRIVATE),
            ),
        )
}
