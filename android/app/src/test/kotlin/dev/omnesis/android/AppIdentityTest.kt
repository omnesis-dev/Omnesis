// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppIdentityTest {
    @Test fun every_shortcut_names_the_installed_package_as_a_literal() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(BuildConfig.APPLICATION_ID, context.packageName)
        val parser = context.resources.getXml(R.xml.shortcuts)
        var targets = 0
        parser.use {
            while (it.next() != XmlPullParser.END_DOCUMENT) {
                if (it.eventType != XmlPullParser.START_TAG || it.name != "intent") continue
                // Google Play's App Actions parser rejects a resource reference here.
                assertEquals(
                    "android:targetPackage must be a literal, not a resource reference",
                    0,
                    it.getAttributeResourceValue(ANDROID_NAMESPACE, "targetPackage", 0),
                )
                assertEquals(BuildConfig.APPLICATION_ID, it.getAttributeValue(ANDROID_NAMESPACE, "targetPackage"))
                targets += 1
            }
        }
        assertEquals(12, targets)
    }

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}
