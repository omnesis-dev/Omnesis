// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.IndexStats
import dev.omnesis.android.transport.dto.StatusSnapshot
import dev.omnesis.android.transport.dto.Whoami
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.getJson

/** Health/status/identity. Mirrors the iOS `GatewayClient` read surface. */
class GatewayClient(private val http: GatewayHttp) {

    /** Unauthenticated reachability probe. */
    suspend fun health(): Boolean = try {
        http.execute(http.newRequest(http.urlFor("health")).get().build())
        true
    } catch (e: GatewayException) {
        false
    }

    suspend fun status(): StatusSnapshot = http.getJson("status")

    suspend fun whoami(): Whoami = http.getJson("whoami")

    suspend fun indexStats(): IndexStats = http.getJson("index/stats")
}
