// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** A library's manifest target, without a Config SDK override, also resolves offline. */
@RunWith(RobolectricTestRunner::class)
class RobolectricLibraryDefaultSdkTest {
    @Test
    fun unannotatedLibraryTestsBootTheirManifestDefaultSdk() {
        assertEquals("true", System.getProperty("robolectric.offline"))
        assertEquals(26, RuntimeEnvironment.getApiLevel())
        assertNotNull(RuntimeEnvironment.getApplication().applicationContext)
    }
}
