// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.pairing.PrefsCipher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AssistSettingsTest {
    /** Reversible, and visibly not the plain text. */
    private object Rot : PrefsCipher {
        override fun seal(plaintext: String) = "sealed:" + plaintext.reversed()
        override fun open(token: String) = token.removePrefix("sealed:").reversed()
    }

    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("assist-test", Context.MODE_PRIVATE)
    private fun settings() = AssistSettings(prefs, Rot)

    private val hook = CommandRoute("hook", "hey_mycroft", Destination.Webhook("https://hooks.example.com/voice"), threshold = 0.6f)
    private val phone = CommandRoute("phone", "alexa", Destination.PhoneAction)

    @Test fun aFreshPhoneOffersOkHomeForHomeAssistant() {
        val p = settings().state.value
        assertEquals(listOf(CommandRoute("home-assistant", "ok_home", Destination.HomeAssistant)), p.routes)
        assertEquals(TranscriberKind.GATEWAY, p.transcriber)
        assertFalse(p.enabled)
    }

    @Test fun routesAndTheTranscriberSurviveAReload() {
        val s = settings()
        s.setRoutes(CommandRoute.defaults + hook + phone)
        s.setTranscriber(TranscriberKind.PHONE)
        val again = settings().state.value
        assertEquals(CommandRoute.defaults + hook + phone, again.routes)
        assertEquals(TranscriberKind.PHONE, again.transcriber)
    }

    @Test fun aWakeWordCannotLeadToTwoDestinations() {
        val s = settings()
        try {
            s.setRoutes(listOf(hook, phone.copy(wakeWord = hook.wakeWord)))
            org.junit.Assert.fail("expected a refusal")
        } catch (_: IllegalArgumentException) {
        }
        assertEquals(CommandRoute.defaults, s.state.value.routes)
    }

    @Test fun aWebhookSecretIsSealedAndGoesWithItsRoute() {
        val s = settings()
        s.setRoutes(listOf(hook))
        s.setWebhookSecret(hook.id, " s3cret ")
        assertEquals(setOf("hook"), s.state.value.webhookSecrets)
        assertEquals("s3cret", s.webhookSecret(hook.id))
        assertFalse(prefs.all.values.any { it == "s3cret" })

        s.setRoutes(listOf(phone))
        assertTrue(s.state.value.webhookSecrets.isEmpty())
        assertNull(s.webhookSecret(hook.id))
    }

    @Test fun unreadableRoutesFallBackToTheDefault() {
        prefs.edit().putString("routes", "{not json").commit()
        assertEquals(CommandRoute.defaults, settings().state.value.routes)
    }

    @Test fun clearForgetsEverything() {
        val s = settings()
        s.setConnection("http://homeassistant.local:8123", "token")
        s.setRoutes(listOf(hook))
        s.setWebhookSecret(hook.id, "s3cret")
        s.setEnabled(true)
        s.clear()
        assertEquals(AssistPreferences(), s.state.value)
        assertNull(s.config())
    }
}
