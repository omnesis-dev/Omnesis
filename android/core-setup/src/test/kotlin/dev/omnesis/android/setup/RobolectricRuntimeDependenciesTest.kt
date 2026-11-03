// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup

import java.io.File
import java.nio.file.Files
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.plugins.DefaultSdkProvider
import org.robolectric.plugins.LegacyDependencyResolver

/** Proves the pinned Robolectric library can resolve every SDK our tests use locally. */
class RobolectricRuntimeDependenciesTest {
    @Test
    fun everyTestSdkResolvesFromGradlesPreparedDirectory() {
        assertEquals("true", System.getProperty("robolectric.offline"))
        assertEquals("true", System.getProperty("robolectric.usePreinstrumentedJars"))
        val directory = File(requireNotNull(System.getProperty("robolectric.dependency.dir")))
        val sdks = DefaultSdkProvider(LegacyDependencyResolver(System.getProperties())).sdks.associateBy { it.apiLevel }
        val sdkFiles = listOf(26, 28, 32, 33, 34, 35).map { api ->
            val jar = sdks.getValue(api).jarPath.toFile()
            assertTrue("SDK $api must be staged before the test JVM starts", jar.isFile)
            assertEquals(directory.canonicalFile, requireNotNull(jar.parentFile).canonicalFile)
            jar.name
        }
        assertEquals(sdkFiles.toSet(), directory.listFiles().orEmpty().map { it.name }.toSet())
    }

    @Test
    fun aMissingSdkFailsLocallyWithoutAFallbackDownload() {
        val directory = Files.createTempDirectory("robolectric-missing-sdk").toFile()
        try {
            val properties = Properties().apply {
                setProperty("robolectric.dependency.dir", directory.absolutePath)
                setProperty("robolectric.offline", "true")
            }
            val sdk = DefaultSdkProvider(LegacyDependencyResolver(properties)).sdks.single { it.apiLevel == 34 }
            val failure = assertThrows(IllegalArgumentException::class.java) { sdk.jarPath }
            assertTrue(failure.message.orEmpty().contains("Path is not a file"))
            assertTrue(directory.listFiles().orEmpty().isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }
}
