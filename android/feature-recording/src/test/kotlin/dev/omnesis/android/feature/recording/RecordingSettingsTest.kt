// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RecordingSettingsTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test-recording", Context.MODE_PRIVATE)

    @Test fun wifiOnlyIsOffUntilChosenAndOutlivesARestart() {
        val settings = RecordingSettings(prefs)
        assertFalse(settings.wifiOnly)
        settings.wifiOnly = true
        assertTrue(RecordingSettings(prefs).wifiOnly)
        settings.wifiOnly = false
        assertFalse(RecordingSettings(prefs).wifiOnly)
    }
}
