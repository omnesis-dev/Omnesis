// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The transient/permanent split, driven through the statuses that decide it.
 * The permanent arm is the one that costs data when it is wrong: everything
 * classified there is a payload a caller is entitled to stop re-sending.
 */
class GatewayFailureTest {

    private fun kindOf(status: Int) = classifyGatewayFailure(GatewayException.ServerError(status, null))

    @Test
    fun `auth failures ask for attention rather than a retry`() {
        assertEquals(GatewayFailureKind.NEEDS_ATTENTION, classifyGatewayFailure(GatewayException.Unauthorized()))
        assertEquals(GatewayFailureKind.NEEDS_ATTENTION, classifyGatewayFailure(GatewayException.Forbidden()))
    }

    @Test
    fun `a 4xx verdict on the payload is permanent`() {
        for (status in listOf(400, 409, 413, 422, 431)) {
            assertEquals("status $status", GatewayFailureKind.PERMANENT, kindOf(status))
        }
    }

    @Test
    fun `the 4xx statuses that mean later are transient`() {
        for (status in listOf(408, 425, 429)) {
            assertEquals("status $status", GatewayFailureKind.TRANSIENT, kindOf(status))
        }
    }

    @Test
    fun `server errors are transient`() {
        for (status in listOf(500, 502, 503, 504)) {
            assertEquals("status $status", GatewayFailureKind.TRANSIENT, kindOf(status))
        }
    }

    @Test
    fun `a redirect the client could not follow is transient`() {
        // Reaches this classifier only when OkHttp gave up following it — a
        // captive portal or a misrouted proxy, not a verdict on the payload.
        assertEquals(GatewayFailureKind.TRANSIENT, kindOf(302))
    }

    @Test
    fun `an unreachable gateway and an unreadable reply are transient`() {
        assertEquals(GatewayFailureKind.TRANSIENT, classifyGatewayFailure(GatewayException.Network(IOException("no route"))))
        assertEquals(GatewayFailureKind.TRANSIENT, classifyGatewayFailure(GatewayException.Decoding("not json")))
        assertEquals(GatewayFailureKind.TRANSIENT, classifyGatewayFailure(GatewayException.InvalidResponse("empty")))
        assertEquals(GatewayFailureKind.TRANSIENT, classifyGatewayFailure(GatewayException.NotFound()))
    }

    @Test
    fun `a throwable that is not a gateway error is transient`() {
        assertEquals(GatewayFailureKind.TRANSIENT, classifyGatewayFailure(IllegalStateException("boom")))
    }
}
