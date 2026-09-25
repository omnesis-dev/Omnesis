// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import dev.omnesis.android.transport.ws.DeviceSocket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppVersionInfoTest {

    @Test
    fun currentReportsTheBuildsOwnNumbers() {
        val info = AppVersionInfo.current()
        assertEquals(BuildConfig.VERSION_NAME, info.version)
        assertEquals(BuildConfig.VERSION_CODE.toString(), info.build)
    }

    /**
     * The displayed protocol number is the one the socket actually sends. A
     * hard-coded copy would keep reading `1` after a bump and quietly
     * misdiagnose the connection failure the bump caused.
     */
    @Test
    fun wireProtocolIsTheNumberTheSocketSpeaks() {
        assertEquals(DeviceSocket.PROTOCOL_VERSION, AppVersionInfo.current().wireProtocol)
    }

    /** Every field is displayable: no blanks reach the About section. */
    @Test
    fun everyFieldIsPopulated() {
        val info = AppVersionInfo.current()
        assertTrue(info.version.isNotBlank())
        assertTrue(info.build.isNotBlank())
        assertTrue(info.wireProtocol > 0)
    }
}
