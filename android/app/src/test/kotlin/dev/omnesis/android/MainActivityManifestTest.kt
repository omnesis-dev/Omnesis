// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.view.WindowManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 34])
class MainActivityManifestTest {
    @Suppress("DEPRECATION")
    @Test
    fun applicationDisablesAndroidBackup() {
        val context = RuntimeEnvironment.getApplication()
        val application = context.packageManager.getApplicationInfo(context.packageName, 0)

        assertEquals(0, application.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    }

    @Suppress("DEPRECATION")
    @Test
    fun applicationDisablesCleartextGatewayTraffic() {
        val context = RuntimeEnvironment.getApplication()
        val application = context.packageManager.getApplicationInfo(context.packageName, 0)

        assertEquals(0, application.flags and ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC)
    }

    @Suppress("DEPRECATION")
    @Test
    fun mainActivityResizesForTheSoftwareKeyboard() {
        val context = RuntimeEnvironment.getApplication()
        val activity = context.packageManager.getActivityInfo(
            ComponentName(context, MainActivity::class.java),
            0,
        )

        assertEquals(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE,
            activity.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST,
        )
    }

    @Test
    fun mainActivityClaimsOnlyTheAuthorizationDeepLinkHost() {
        val context = RuntimeEnvironment.getApplication()
        val canonical = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("omnesis://access-authorization?v=1&code=ABCD-EFGH"),
        ).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            setPackage(context.packageName)
        }
        val resolved = canonical.resolveActivity(context.packageManager)

        assertEquals(ComponentName(context, MainActivity::class.java), resolved)

        val wrongHost = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("omnesis://other?v=1&code=ABCD-EFGH"),
        ).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            setPackage(context.packageName)
        }
        assertNull(wrongHost.resolveActivity(context.packageManager))
    }
}
