// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.app.Application
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImageComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import dev.omnesis.android.wear.core.WatchHaptic
import dev.omnesis.android.wear.device.VibratorHaptics
import dev.omnesis.android.wear.surfaces.CaptureComplication
import dev.omnesis.android.wear.surfaces.CaptureComplicationService
import dev.omnesis.android.wear.surfaces.CaptureTileService
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What the app declares to the system, checked against the shared relay contract. */
@RunWith(RobolectricTestRunner::class)
class WearManifestTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val packages = context.packageManager

    @Test
    fun the_app_advertises_the_watch_capability_the_phone_looks_for() {
        val capabilities = context.resources.getStringArray(R.array.android_wear_capabilities)
        assertEquals(listOf(WearDataLayer.WATCH_CAPABILITY), capabilities.toList())
    }

    @Test
    fun the_app_needs_the_phone_and_asks_only_for_the_microphone_and_vibration() {
        val info = packages.getPackageInfo(
            context.packageName,
            PackageManager.GET_PERMISSIONS or PackageManager.GET_META_DATA,
        )
        val standalone = info.applicationInfo?.metaData?.getBoolean("com.google.android.wearable.standalone", true)
        assertEquals(false, standalone)
        val requested = info.requestedPermissions.orEmpty().toSet()
        assertTrue("android.permission.RECORD_AUDIO" in requested)
        assertTrue("android.permission.VIBRATE" in requested)
        // The watch makes no gateway call: everything goes through the phone app.
        assertFalse("android.permission.INTERNET" in requested)
    }

    @Test
    fun each_deep_link_resolves_to_the_app_screen() {
        for (route in WearRoute.entries) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(route.uri)).setPackage(context.packageName)
            val target = packages.resolveActivity(intent, 0)
            assertEquals(route.uri, MainActivity::class.java.name, target?.activityInfo?.name)
        }
    }

    @Test
    fun the_tile_and_the_complication_are_declared_for_the_system_to_bind() {
        for (service in listOf(CaptureTileService::class.java, CaptureComplicationService::class.java)) {
            val info = packages.getServiceInfo(ComponentName(context, service), PackageManager.GET_META_DATA)
            assertTrue(service.simpleName, info.exported)
            assertNotNull(service.simpleName, info.permission)
        }
        val complication = packages.getServiceInfo(
            ComponentName(context, CaptureComplicationService::class.java),
            PackageManager.GET_META_DATA,
        )
        val declared = complication.metaData.getString("android.support.wearable.complications.SUPPORTED_TYPES")
        assertEquals(CaptureComplication.SUPPORTED_TYPES.map { it.name }, declared?.split(","))
    }

    @Test
    fun the_complication_fills_each_shape_it_declares_and_no_other() {
        val short = CaptureComplication.data(context, ComplicationType.SHORT_TEXT, null)
        val mono = CaptureComplication.data(context, ComplicationType.MONOCHROMATIC_IMAGE, null)
        val small = CaptureComplication.data(context, ComplicationType.SMALL_IMAGE, null)
        assertTrue(short is ShortTextComplicationData)
        assertTrue(mono is MonochromaticImageComplicationData)
        assertTrue(small is SmallImageComplicationData)
        assertNotNull((short as ShortTextComplicationData).monochromaticImage)
        assertNull(CaptureComplication.data(context, ComplicationType.RANGED_VALUE, null))
        assertNull(CaptureComplication.data(context, ComplicationType.LONG_TEXT, null))
    }

    @Test
    fun the_four_signals_are_four_different_patterns() {
        val patterns = WatchHaptic.entries.map { VibratorHaptics.pattern(it).toList() }
        assertEquals(WatchHaptic.entries.size, patterns.toSet().size)
        for (pattern in patterns) {
            assertEquals("a pattern starts with a pause of zero", 0L, pattern.first())
            assertTrue(pattern.size % 2 == 0)
        }
    }
}
