// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.di

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import dagger.Module
import dev.omnesis.android.feature.health.setup.HealthSetupStep
import dev.omnesis.android.setup.PhoneSetupStep
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dagger.multibindings.IntoSet
import dev.omnesis.android.feature.health.HealthIntegration
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.PermissionHealthReporter
import dev.omnesis.android.feature.health.HealthSettings
import dev.omnesis.android.feature.health.KeyValueStore
import javax.inject.Singleton

/**
 * Whether Health Connect is usable on this device. The provider needs API 28+,
 * is a standalone app through API 33, and a framework module on 34+.
 */
enum class HealthConnectAvailability {
    /** Android version too old for Health Connect (API < 28). */
    NotSupported,

    /** Supported OS but the Health Connect provider app isn't installed. */
    NotInstalled,

    /** Provider installed but too old for the client SDK. */
    UpdateRequired,

    /** Ready — [HealthConnectClient.getOrCreate] will succeed. */
    Available;

    companion object {
        fun detect(context: Context): HealthConnectAvailability {
            if (Build.VERSION.SDK_INT < 28) return NotSupported
            return when (HealthConnectClient.getSdkStatus(context)) {
                HealthConnectClient.SDK_AVAILABLE -> Available
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> UpdateRequired
                else -> NotInstalled
            }
        }
    }
}

/** [KeyValueStore] over SharedPreferences — the production backing for [HealthSettings]. */
class SharedPreferencesKeyValueStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String?) {
        prefs.edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }
}

/**
 * Read-only snapshot of the on-device Health Connect provider — availability
 * plus the currently granted permissions — behind a seam so the health UI's
 * view model stays unit-testable off-device.
 */
interface HealthConnectStatusReader {
    fun availability(): HealthConnectAvailability

    /** Whether an optional provider-version capability can be requested. */
    fun featureAvailable(feature: Int): Boolean = false

    /** Granted Health Connect permissions; empty when the provider isn't usable. */
    suspend fun grantedPermissions(): Set<String>
}

/** Production reader over the real [HealthConnectClient]. */
class DefaultHealthConnectStatusReader(private val context: Context) : HealthConnectStatusReader {
    override fun availability(): HealthConnectAvailability = HealthConnectAvailability.detect(context)

    override suspend fun grantedPermissions(): Set<String> =
        if (availability() == HealthConnectAvailability.Available) {
            HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
        } else {
            emptySet()
        }

    override fun featureAvailable(feature: Int): Boolean =
        availability() == HealthConnectAvailability.Available &&
            HealthConnectClient.getOrCreate(context).features.getFeatureStatus(feature) ==
            androidx.health.connect.client.HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
}

@Module
@InstallIn(SingletonComponent::class)
object HealthModule {
    @Provides @IntoSet
    fun providePermissionReporter(integration: HealthIntegration): PermissionHealthReporter = integration

    /**
     * The opt-in a refusal is applied to, so the switch goes off and the
     * background work stops with or without a settings screen open.
     */
    @Provides @IntoSet
    fun provideHostedSourceOptIn(integration: HealthIntegration): HostedSourceOptIn = integration

    /** The Health Connect page of the phone setup flow. */
    @Provides @IntoSet
    fun providePhoneSetupStep(step: HealthSetupStep): PhoneSetupStep = step

    @Provides
    @Singleton
    fun provideHealthSettings(@ApplicationContext context: Context): HealthSettings =
        HealthSettings(
            SharedPreferencesKeyValueStore(
                context.getSharedPreferences("omnesis.health", Context.MODE_PRIVATE),
            ),
        )

    @Provides
    @Singleton
    fun provideHealthConnectStatusReader(@ApplicationContext context: Context): HealthConnectStatusReader =
        DefaultHealthConnectStatusReader(context)
}
