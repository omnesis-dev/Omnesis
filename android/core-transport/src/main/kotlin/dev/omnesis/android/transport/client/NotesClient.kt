// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.CreateNoteBody
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson

/**
 * Client for the gateway's quick-capture `/notes` surface ("Tell Omnesis").
 * Auth is the standard device bearer token. Older gateways 404 every route,
 * which [GatewayHttp] maps to `GatewayException.NotFound`.
 */
class NotesClient(private val http: GatewayHttp) {

    /** `POST /notes` — capture one note; returns the stored entry (201). */
    suspend fun create(body: CreateNoteBody): NoteEntryDto =
        http.postJson("notes", body)
}
