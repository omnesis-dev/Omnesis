// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RecordingSettingsTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test-recording", Context.MODE_PRIVATE)

    @Test fun theStartInputIsRememberedOnceChosen() {
        val settings = RecordingSettings(prefs)
        assertNull(settings.preferredInput)
        settings.preferredInput = RecordingInput.PHONE
        assertEquals(RecordingInput.PHONE, RecordingSettings(prefs).preferredInput)
        settings.preferredInput = RecordingInput.WEARABLE
        assertEquals(RecordingInput.WEARABLE, RecordingSettings(prefs).preferredInput)
    }

    @Test fun anUnknownStoredInputReadsAsNoChoice() {
        prefs.edit().putString("input", "TELEPATHY").commit()
        assertNull(RecordingSettings(prefs).preferredInput)
    }
}
