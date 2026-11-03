// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Each staged SDK must boot a real sandbox while runtime downloads are disabled. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 28, 32, 33, 34, 35])
class RobolectricOfflineSandboxTest {
    @Test
    fun everyTestSdkCanCreateAnApplicationWithoutRuntimeDownloads() {
        assertEquals("true", System.getProperty("robolectric.offline"))
        assertNotNull(RuntimeEnvironment.getApplication().applicationContext)
    }
}
