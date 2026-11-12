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
import dev.omnesis.android.wear.link.PhoneListenerService
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
    fun the_recorder_links_are_not_registered_for_other_apps_to_open() {
        // The tile and the complication address the screen by its class, so the
        // links need no filter, and a link from anywhere else finds nothing to open.
        for (route in WearRoute.entries) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(route.uri)).setPackage(context.packageName)
            assertNull(route.uri, packages.resolveActivity(intent, 0))
        }
    }

    @Test
    fun the_listener_is_started_for_what_the_phone_sends_and_not_for_the_watchs_own_items() {
        fun started(action: String, path: String): Boolean {
            val intent = Intent("com.google.android.gms.wearable.$action", Uri.parse("wear://node$path"))
                .setPackage(context.packageName)
            return packages.queryIntentServices(intent, 0).any { it.serviceInfo.name == PhoneListenerService::class.java.name }
        }
        val fromPhone = listOf(
            WearDataLayer.PROGRESS_PATH,
            WearDataLayer.RESULT_PATH,
            WearDataLayer.NOTE_ACK_PATH,
            WearDataLayer.CAPTURE_UPDATE_PATH,
            WearDataLayer.RECORDING_RECEIVED_PATH,
        )
        for (path in fromPhone) assertTrue(path, started("MESSAGE_RECEIVED", path))
        assertTrue(started("REQUEST_RECEIVED", WearDataLayer.CAPTURE_UPDATE_PATH))
        assertTrue(started("DATA_CHANGED", WearDataLayer.GATE_PATH))
        // The watch's own recordings and queued relays change without waking it.
        assertFalse(started("DATA_CHANGED", WearDataLayer.recordingPath("5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5d")))
        assertFalse(started("DATA_CHANGED", WearDataLayer.queuedPath("5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5d")))
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
        // The manifest names two of the types as the system does, not as the enum does.
        val tags = CaptureComplication.SUPPORTED_TYPES.map { type ->
            when (type) {
                ComplicationType.MONOCHROMATIC_IMAGE -> "ICON"
                ComplicationType.PHOTO_IMAGE -> "LARGE_IMAGE"
                else -> type.name
            }
        }
        assertEquals(tags, declared?.split(","))
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
    fun the_listener_is_started_when_the_phone_app_comes_into_or_goes_out_of_reach() {
        // Play services addresses a capability change as wear://<node>/<capability name>.
        val change = Intent(
            "com.google.android.gms.wearable.CAPABILITY_CHANGED",
            Uri.parse("wear://node/${WearDataLayer.PHONE_CAPABILITY}"),
        ).setPackage(context.packageName)
        val started = packages.queryIntentServices(change, 0).map { it.serviceInfo.name }
        assertEquals(listOf(PhoneListenerService::class.java.name), started)
        // The watch's own capability changing is nothing the outbox waits for.
        val own = Intent(change).setData(Uri.parse("wear://node/${WearDataLayer.WATCH_CAPABILITY}"))
        assertTrue(packages.queryIntentServices(own, 0).isEmpty())
    }

    @Test
    fun nothing_the_system_draws_for_the_app_reads_a_theme_attribute() {
        // The tile, the complication and the launcher draw these outside the app's theme.
        val drawables = java.io.File("src/main/res").listFiles { dir -> dir.name.startsWith("drawable") }
            .orEmpty()
            .flatMap { it.listFiles { file -> file.extension == "xml" }.orEmpty().toList() }
        assertTrue(drawables.isNotEmpty())
        val themed = drawables.filter { Regex("""="\?[^"]*"""").containsMatchIn(it.readText()) }.map { it.name }
        assertEquals(emptyList<String>(), themed)
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
