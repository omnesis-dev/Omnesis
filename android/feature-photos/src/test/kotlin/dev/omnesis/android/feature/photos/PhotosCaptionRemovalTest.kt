// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import org.junit.Assert.assertFalse
import org.junit.Test

class PhotosCaptionRemovalTest {
    @Test
    fun `photos integration does not retain a genai caption analyzer`() {
        // A deferred analyzer is still part of every new-photo sync. Inspect
        // its registration without initializing ML Kit in this JVM test.
        assertFalse(
            PhotosIntegration::class.java.declaredFields.any { field ->
                field.name.contains("caption", ignoreCase = true)
            },
        )
    }
}
