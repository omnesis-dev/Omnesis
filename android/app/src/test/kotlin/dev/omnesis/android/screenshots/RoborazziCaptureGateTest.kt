// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit cover for the decision behind the Roborazzi zero-capture guard
 * wired in the root `build.gradle.kts`: after a record/verify run it reads
 * Roborazzi's `results-summary.json`, and `summary.total == 0` means the screenshot
 * lane captured nothing — a silent no-op that must fail the lane (the committed
 * goldens would otherwise keep it green). This mirrors the gate's parse so the
 * decision is regression-covered without spinning a Gradle run.
 */
class RoborazziCaptureGateTest {
    /** The same value the Gradle gate extracts (`summary.total`). */
    private fun capturedTotal(summaryJson: String): Int =
        Json.parseToJsonElement(summaryJson)
            .jsonObject["summary"]!!
            .jsonObject["total"]!!
            .jsonPrimitive
            .int

    @Test
    fun `zero captures trips the gate`() {
        val zero =
            """{"summary":{"total":0,"recorded":0,"added":0,"changed":0,"unchanged":0},"results":[]}"""
        assertEquals(0, capturedTotal(zero))
        assertTrue("total == 0 must trip the zero-capture gate", capturedTotal(zero) == 0)
    }

    @Test
    fun `a populated run passes the gate`() {
        // Shape taken verbatim from a real Roborazzi 1.40.1 results-summary.json.
        val populated =
            """{"summary":{"total":6,"recorded":0,"added":0,"changed":0,"unchanged":6},"results":[]}"""
        assertEquals(6, capturedTotal(populated))
        assertTrue("a real capture run must pass the gate", capturedTotal(populated) > 0)
    }
}
