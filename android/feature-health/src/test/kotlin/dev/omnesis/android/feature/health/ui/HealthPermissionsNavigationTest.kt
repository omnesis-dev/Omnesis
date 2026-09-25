// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HealthPermissionsNavigationTest {
    private val manageAction = "android.health.connect.action.MANAGE_HEALTH_PERMISSIONS"

    private class LaunchContext(val reject: (Intent) -> Unit) :
        ContextWrapper(ApplicationProvider.getApplicationContext<Context>()) {
        val attempts = mutableListOf<Intent>()
        override fun startActivity(intent: Intent) {
            attempts += intent
            reject(intent)
        }
    }

    @Test
    fun protectedPerAppSettingsFallsBackToHealthConnectSettings() {
        val context = LaunchContext {
            if (it.action == manageAction) throw SecurityException("Privileged settings action")
        }
        openHealthConnectPermissions(context)
        assertEquals(listOf(manageAction, HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS), context.attempts.map { it.action })
    }

    @Test
    fun supportedPerAppSettingsOpensOnlyTheRequestedApp() {
        val context = LaunchContext {}
        openHealthConnectPermissions(context)
        assertEquals(1, context.attempts.size)
        assertEquals(context.packageName, context.attempts.single().getStringExtra(Intent.EXTRA_PACKAGE_NAME))
    }

    @Test
    fun unavailableSettingsFallsBackToStore() {
        val context = LaunchContext {
            if (it.action != Intent.ACTION_VIEW) throw ActivityNotFoundException()
        }
        openHealthConnectPermissions(context)
        assertEquals("market", context.attempts.last().data?.scheme)
    }
}
