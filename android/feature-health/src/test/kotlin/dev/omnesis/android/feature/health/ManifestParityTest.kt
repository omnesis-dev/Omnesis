// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Catches catalog/manifest drift: every permission the consent flow requests —
 * the per-type read permissions plus background and history reads — must be
 * declared in this module's AndroidManifest.xml, or the Health Connect consent
 * sheet silently omits it and the source never reads the type.
 */
class ManifestParityTest {

    private fun manifestFile(): File {
        val userDir = File(System.getProperty("user.dir") ?: ".")
        // Gradle test workers run with the module dir as user.dir; fall back to
        // the repo-root-relative path for other runners.
        val candidates = listOf(
            File(userDir, "src/main/AndroidManifest.xml"),
            File(userDir, "feature-health/src/main/AndroidManifest.xml"),
            File(userDir, "android/feature-health/src/main/AndroidManifest.xml"),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("AndroidManifest.xml not found from ${userDir.absolutePath}")
    }

    @Test
    fun everyRequestedPermissionIsDeclaredInTheManifest() {
        val manifest = manifestFile().readText()
        val declared = Regex("""<uses-permission\s+android:name="([^"]+)"""")
            .findAll(manifest)
            .map { it.groupValues[1] }
            .toSet()

        for (permission in HealthTypeCatalog.allPermissionsToRequest) {
            assertTrue("$permission missing from AndroidManifest.xml", permission in declared)
        }
    }
}
