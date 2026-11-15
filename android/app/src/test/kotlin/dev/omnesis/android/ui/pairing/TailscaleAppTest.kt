// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TailscaleAppTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()

    @Test fun `without Tailscale installed the Play Store listing comes first, then the web page`() {
        val intents = tailscaleIntents(context.packageManager)
        assertEquals(listOf(TAILSCALE_MARKET_URL, TAILSCALE_PLAY_URL), intents.map { it.dataString })
        assertEquals(listOf(Intent.ACTION_VIEW, Intent.ACTION_VIEW), intents.map { it.action })
    }

    @Test fun `an installed Tailscale is launched before any store page`() {
        val launcher = ComponentName(TAILSCALE_PACKAGE, "$TAILSCALE_PACKAGE.MainActivity")
        shadowOf(context.packageManager).apply {
            addActivityIfNotPresent(launcher)
            addIntentFilterForActivity(
                launcher,
                IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) },
            )
        }
        val intents = tailscaleIntents(context.packageManager)
        assertEquals(TAILSCALE_PACKAGE, intents.first().`package` ?: intents.first().component?.packageName)
        assertEquals(listOf(TAILSCALE_MARKET_URL, TAILSCALE_PLAY_URL), intents.drop(1).map { it.dataString })
    }

    @Test fun `open starts the first way in`() {
        openTailscale(context)
        val started = shadowOf(context as android.app.Application).nextStartedActivity
        assertEquals(TAILSCALE_MARKET_URL, started.dataString)
    }
}
