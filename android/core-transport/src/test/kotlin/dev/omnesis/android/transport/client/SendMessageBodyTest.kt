// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `/messages` POST body's per-message `deepResearch` flag — the send-path
 * seam the composer's `/`→pill rides. Armed → `"deepResearch": true`; default →
 * the key is dropped so a plain turn's payload is byte-identical to before the
 * flag existed (parity with portal/iOS `sendMessageBody`).
 */
class SendMessageBodyTest {

    @Test
    fun default_send_omits_deepResearch() {
        val body = SendMessageBody.of("what's on my calendar", deepResearch = false)
        val obj = OmnesisJson.encodeToString(body).let { OmnesisJson.parseToJsonElement(it).jsonObject }
        assertEquals("what's on my calendar", obj["text"]?.jsonPrimitive?.content)
        // explicitNulls = false drops the null → no key at all.
        assertNull(obj["deepResearch"])
    }

    @Test
    fun armed_send_carries_deepResearch_true() {
        val body = SendMessageBody.of("trace my spending on coffee this quarter", deepResearch = true)
        val obj = OmnesisJson.encodeToString(body).let { OmnesisJson.parseToJsonElement(it).jsonObject }
        assertTrue(obj["deepResearch"]!!.jsonPrimitive.boolean)
    }
}
