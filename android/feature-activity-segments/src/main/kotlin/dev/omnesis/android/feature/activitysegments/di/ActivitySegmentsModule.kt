// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments.di

import android.content.Context
import android.content.SharedPreferences
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dagger.multibindings.IntoSet
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsIntegration
import dev.omnesis.android.feature.activitysegments.setup.ActivitySegmentsSetupStep
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSettings
import dev.omnesis.android.feature.activitysegments.ActivityTransitionBuffer
import dev.omnesis.android.feature.activitysegments.KeyValueStore
import javax.inject.Singleton

/** [KeyValueStore] over SharedPreferences — the production backing for [ActivitySegmentsSettings]. */
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
object ActivitySegmentsModule {
    @Provides @IntoSet
    fun providePermissionReporter(integration: ActivitySegmentsIntegration): PermissionHealthReporter = integration

    /**
     * The opt-in a refusal is applied to, so the switch goes off and the
     * background work stops with or without a settings screen open.
     */
    @Provides @IntoSet
    fun provideHostedSourceOptIn(integration: ActivitySegmentsIntegration): HostedSourceOptIn = integration

    /** The Activity Segments page of the phone setup flow. */
    @Provides @IntoSet
    fun providePhoneSetupStep(step: ActivitySegmentsSetupStep): PhoneSetupStep = step

    @Provides
    @Singleton
    fun provideActivitySegmentsSettings(@ApplicationContext context: Context): ActivitySegmentsSettings =
        ActivitySegmentsSettings(
            SharedPreferencesKeyValueStore(
                context.getSharedPreferences("omnesis.activitysegments", Context.MODE_PRIVATE),
            ),
        )

    /**
     * Singleton so [ActivityTransitionReceiver] (resolved via its own Hilt
     * [dev.omnesis.android.feature.activitysegments.ActivityTransitionReceiver.Deps]
     * entry point) and the app's session both write to the same buffer
     * instance/SQLite connection.
     */
    @Provides
    @Singleton
    fun provideActivityTransitionBuffer(@ApplicationContext context: Context): ActivityTransitionBuffer =
        ActivityTransitionBuffer(context)
}
