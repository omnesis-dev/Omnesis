// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * Wire DTOs for the gateway's quick-capture `/notes` surface ("Tell Omnesis").
 * Older gateway versions may not expose these endpoints.
 *
 * Gateway TS shape (the wire contract these mirror):
 *
 * ```ts
 * // POST /notes            body: { id?: string; text: string; capturedAt?: string; surface?: string; deviceId?: string }
 * //                        `id` is a client-generated idempotency key (UUID): a retried
 * //                        POST with the same id returns the stored entry instead of
 * //                        creating a duplicate.
 * type NoteEntry = {
 *   id: string;
 *   day: string;          // "YYYY-MM-DD"
 *   capturedAt: string;   // ISO 8601
 *   updatedAt: string;    // ISO 8601
 *   text: string;
 *   surface: string | null;
 *   deviceId: string | null;
 * };
 * ```
 *
 * Decoded with [OmnesisJson] (forward-compatible: unknown keys ignored,
 * missing optionals default), so a newer gateway never crashes this client.
 */
@Serializable
data class NoteEntryDto(
    val id: String,
    val day: String,
    val capturedAt: String,
    val updatedAt: String,
    val text: String,
    val surface: String? = null,
    val deviceId: String? = null,
)

/** `POST /notes` request body. [id] is the client idempotency key (see the contract above). */
@Serializable
data class CreateNoteBody(
    val text: String,
    val id: String? = null,
    val capturedAt: String? = null,
    val surface: String? = null,
    val deviceId: String? = null,
)
