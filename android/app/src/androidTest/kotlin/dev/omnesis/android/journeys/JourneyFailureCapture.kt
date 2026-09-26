// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.journeys

import android.util.Log
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * When a journey fails, saves what the screen showed so the failure can be
 * read without re-running it: a screenshot under [DIRECTORY] on the device,
 * which the journey script pulls into its artifacts, and the Compose semantics
 * tree in logcat under the `OmnesisJourney` tag.
 */
class JourneyFailureCapture(private val compose: ComposeTestRule) : TestWatcher() {
    override fun failed(e: Throwable?, description: Description) {
        val name = "${description.testClass.simpleName}.${description.methodName}"
        shell("mkdir -p $DIRECTORY")
        shell("screencap -p $DIRECTORY/$name.png")
        runCatching { compose.onRoot(useUnmergedTree = true).printToString(maxDepth = 60) }
            .onSuccess { tree -> tree.chunked(3_000).forEach { Log.i(TAG, "$name semantics:\n$it") } }
            .onFailure { Log.i(TAG, "$name: no Compose hierarchy to print (${it.message})") }
    }

    private fun shell(command: String) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { fd ->
            java.io.FileInputStream(fd.fileDescriptor).use { it.readBytes() }
        }
    }

    companion object {
        const val DIRECTORY = "/sdcard/omnesis-journeys"
        private const val TAG = "OmnesisJourney"
    }
}
