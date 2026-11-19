// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `GET /status`'s `tailscaleEmbed`: only an explicit `true` turns the Tailscale approvals on. */
class StatusTailscaleEmbedDecodeTest {
    private fun decode(json: String) = OmnesisJson.decodeFromString<StatusSnapshot>(json)

    @Test fun `true only when the gateway says true`() {
        assertTrue(decode("""{"tailscaleEmbed":true}""").tailscaleEmbed)
        assertFalse(decode("""{"tailscaleEmbed":false}""").tailscaleEmbed)
    }

    @Test fun `absent, null or unreadable is false, and the rest of the status still decodes`() {
        assertFalse(decode("{}").tailscaleEmbed)
        assertFalse(decode("""{"tailscaleEmbed":null}""").tailscaleEmbed)
        assertFalse(decode("""{"tailscaleEmbed":"true"}""").tailscaleEmbed)
        assertFalse(decode("""{"tailscaleEmbed":1}""").tailscaleEmbed)
        val status = decode("""{"tailscaleEmbed":{"on":true},"developer":true,"documents":{"total":3,"bySource":{}}}""")
        assertFalse(status.tailscaleEmbed)
        assertTrue(status.developer)
        assertEquals(3, status.documents.total)
    }
}
