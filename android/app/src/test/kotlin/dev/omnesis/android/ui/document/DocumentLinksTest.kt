// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import android.app.Activity
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DocumentLinksTest {
    private lateinit var context: Context

    @Before fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        // A browser-like app that opens https links; nothing handles any other scheme.
        val browser = ComponentName("com.example.browser", "com.example.browser.Main")
        val pm = shadowOf(context.packageManager)
        pm.addActivityIfNotPresent(browser)
        pm.addIntentFilterForActivity(
            browser,
            IntentFilter(Intent.ACTION_VIEW).apply {
                addCategory(Intent.CATEGORY_DEFAULT)
                addCategory(Intent.CATEGORY_BROWSABLE)
                addDataScheme("https")
            },
        )
    }

    @Test fun a_custom_scheme_opens_when_an_app_declares_it_as_a_link() {
        registerHandler("com.example.tasks", "fictional-tasks", browsable = true)
        assertTrue(context.canOpenLink("fictional-tasks:///show?id=Ab12"))
        val urls = openableDocUrls("fictional-tasks:///show?id=Ab12", null, context::canOpenLink)
        assertEquals(listOf("fictional-tasks:///show?id=Ab12"), urls)
    }

    @Test fun a_web_link_counts_even_when_no_handler_is_visible() {
        // The handler Android would pick can sit outside this app's package visibility.
        assertTrue(context.canOpenLink("https://unregistered.example.org/event?eid=abc"))
    }

    @Test fun a_handler_that_does_not_accept_links_does_not_count() {
        registerHandler("com.example.internal", "fictional-internal", browsable = false)
        assertFalse(context.canOpenLink("fictional-internal://item/1"))
    }

    @Test fun an_app_link_no_app_handles_falls_back_to_the_web_link() {
        val urls = openableDocUrls(
            appUrl = "fictional-calendar://event?eid=abc",
            sourceUrl = "https://calendar.example.com/event?eid=abc",
            canOpen = context::canOpenLink,
        )
        assertEquals(listOf("https://calendar.example.com/event?eid=abc"), urls)
    }

    @Test fun a_document_whose_links_nothing_opens_gets_no_open_action() {
        assertFalse(context.canOpenLink("fictional-notes://showNote?identifier=1"))
        val urls = openableDocUrls(
            appUrl = "fictional-mobile-notes://showNote?identifier=1",
            sourceUrl = "fictional-notes://showNote?identifier=1",
            canOpen = context::canOpenLink,
        )
        assertTrue(urls.isEmpty())
    }

    @Test fun an_openable_app_link_stays_ahead_of_the_web_link() {
        val urls = openableDocUrls(
            appUrl = "fictional-app://item/1",
            sourceUrl = "https://app.example.com/item/1",
            canOpen = { true },
        )
        assertEquals(listOf("fictional-app://item/1", "https://app.example.com/item/1"), urls)
    }

    @Test fun blocked_schemes_and_duplicates_are_dropped() {
        assertEquals(
            listOf("https://example.com/a"),
            openableDocUrls("https://example.com/a", "https://example.com/a", canOpen = { true }),
        )
        assertTrue(openableDocUrls("javascript:alert(1)", "file:///etc/hosts", canOpen = { true }).isEmpty())
    }

    private fun registerHandler(pkg: String, scheme: String, browsable: Boolean) {
        val component = ComponentName(pkg, "$pkg.Main")
        val pm = shadowOf(context.packageManager)
        pm.addActivityIfNotPresent(component)
        pm.addIntentFilterForActivity(
            component,
            IntentFilter(Intent.ACTION_VIEW).apply {
                addCategory(Intent.CATEGORY_DEFAULT)
                if (browsable) addCategory(Intent.CATEGORY_BROWSABLE)
                addDataScheme(scheme)
            },
        )
    }

    @Test fun opening_moves_past_a_link_no_app_accepts() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        // Unresolvable intents throw ActivityNotFoundException, as on a device.
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).checkActivities(true)
        val opened = activity.openFirstLink(
            listOf("fictional-calendar://event?eid=abc", "https://calendar.example.com/event?eid=abc"),
        )
        assertTrue(opened)
        assertEquals(
            "https://calendar.example.com/event?eid=abc",
            shadowOf(activity).nextStartedActivity.dataString,
        )
    }
}
