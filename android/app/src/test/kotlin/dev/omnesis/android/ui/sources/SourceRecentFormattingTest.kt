// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class SourceRecentFormattingTest {

    @Test
    fun normalise_row_pads_and_truncates_to_columns() {
        assertEquals(
            listOf(JsonPrimitive("value"), JsonNull),
            normaliseRecentAnalyticsRow(listOf(JsonPrimitive("value")), 2),
        )
        assertEquals(
            listOf(JsonPrimitive(1)),
            normaliseRecentAnalyticsRow(listOf(JsonPrimitive(1), JsonPrimitive(2)), 1),
        )
    }

    @Test
    fun format_cell_preserves_scalar_values_and_compacts_nested_json() {
        assertEquals("—", formatRecentAnalyticsCell(JsonNull))
        assertEquals("42", formatRecentAnalyticsCell(JsonPrimitive(42.0)))
        assertEquals("8.25", formatRecentAnalyticsCell(JsonPrimitive(8.25)))
        assertEquals("true", formatRecentAnalyticsCell(JsonPrimitive(true)))
        assertEquals("Studio Northstar", formatRecentAnalyticsCell(JsonPrimitive("Studio Northstar")))
        assertEquals("[2 items]", formatRecentAnalyticsCell(JsonArray(listOf(JsonPrimitive(1), JsonPrimitive("two")))))
        assertEquals(
            "{1 fields}",
            formatRecentAnalyticsCell(JsonObject(mapOf("place" to JsonPrimitive("Studio Northstar")))),
        )
        assertEquals("x".repeat(200) + "…", formatRecentAnalyticsCell(JsonPrimitive("x".repeat(240))))
    }

    @Test
    fun accessibility_label_associates_each_value_with_its_column() {
        assertEquals(
            "distance_km: 8.4",
            recentAnalyticsCellAccessibilityLabel(column = "distance_km", value = "8.4"),
        )
        assertEquals("distance_km", recentAnalyticsCellAccessibilityLabel(column = null, value = "distance_km"))
    }
}
