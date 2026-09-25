// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HealthCursorTest {

    @Test
    fun missingCursorDecodesToDefaults() {
        val cursor = HealthCursor.fromJsonElement(null)
        assertEquals(emptyMap<String, String>(), cursor.tokens)
        assertNull(cursor.lastFullSyncAt)
    }

    @Test
    fun roundTripsTokensAndTimestamp() {
        val cursor = HealthCursor(
            tokens = mapOf("Weight" to "tok-1", "HeartRate" to "tok-2", "SleepSession" to "tok-3"),
            lastFullSyncAt = "2026-06-10T08:15:00.000Z",
        )
        assertEquals(cursor, HealthCursor.fromJsonElement(cursor.toJsonElement()))
    }

    @Test
    fun withTokenAddsAndReplaces() {
        val cursor = HealthCursor().withToken("Weight", "tok-1").withToken("Steps", "tok-2")
        assertEquals("tok-1", cursor.tokenFor("Weight"))
        assertEquals("tok-2", cursor.tokenFor("Steps"))
        assertEquals("tok-3", cursor.withToken("Weight", "tok-3").tokenFor("Weight"))
    }

    @Test
    fun withNullTokenRemoves() {
        val cursor = HealthCursor(tokens = mapOf("Weight" to "tok-1", "Steps" to "tok-2"))
            .withToken("Weight", null)
        assertNull(cursor.tokenFor("Weight"))
        assertEquals(mapOf("Steps" to "tok-2"), cursor.tokens)
    }

    @Test
    fun malformedJsonDecodesToDefaultsWithoutThrowing() {
        val malformed = listOf(
            JsonPrimitive("not an object"),
            JsonPrimitive(42),
            buildJsonObject { put("tokens", "not-a-map") },
        )
        for (element in malformed) {
            assertEquals(HealthCursor(), HealthCursor.fromJsonElement(element))
        }
    }

    @Test
    fun unknownFieldsAreIgnored() {
        val element = buildJsonObject {
            put("tokens", buildJsonObject { put("Weight", "tok-1") })
            put("someFutureField", true)
        }
        assertEquals(HealthCursor(tokens = mapOf("Weight" to "tok-1")), HealthCursor.fromJsonElement(element))
    }
}
